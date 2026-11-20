// Draws one camera frame with its effect, all on the GPU (WebGL2):
//   blur: the frame shrunk to a quarter, blurred, and mixed back in behind you
//         using the segmentation mask;
//   paint: a texture stretched over the 468-point face mesh;
//   props: flat pictures placed on the face.
// Texture orientation: the camera, the mask and the art are top row first;
// the small blur framebuffers are bottom row first (WebGL's own order).
import { TRIANGLES, UVS } from "./faceMesh";

const VS_QUAD = `#version 300 es
in vec2 a_pos;
uniform float u_flip;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  if (u_flip > 0.5) v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS_COPY = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, v_uv); }`;

// 9-tap Gaussian in 5 samples (linear filtering does the rest).
const FS_BLUR = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_step;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv) * 0.2270270270;
  c += texture(u_tex, v_uv + u_step * 1.3846153846) * 0.3162162162;
  c += texture(u_tex, v_uv - u_step * 1.3846153846) * 0.3162162162;
  c += texture(u_tex, v_uv + u_step * 3.2307692308) * 0.0702702703;
  c += texture(u_tex, v_uv - u_step * 3.2307692308) * 0.0702702703;
  o = c;
}`;

const FS_MIX = `#version 300 es
precision mediump float;
uniform sampler2D u_sharp;
uniform sampler2D u_blur;
uniform sampler2D u_mask;
in vec2 v_uv;
out vec4 o;
void main() {
  float m = smoothstep(0.35, 0.75, texture(u_mask, v_uv).r);
  vec4 b = texture(u_blur, vec2(v_uv.x, 1.0 - v_uv.y));
  o = mix(b, texture(u_sharp, v_uv), m);
}`;

const VS_MESH = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}`;

const FS_MESH = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_alpha;
in vec2 v_uv;
out vec4 o;
void main() { vec4 c = texture(u_tex, v_uv); o = vec4(c.rgb, c.a * u_alpha); }`;

const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QUAD_IDX = new Uint16Array([0, 1, 2, 0, 2, 3]);

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Target = { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number };

export interface Overlay {
  art: HTMLCanvasElement;
  /** Face landmarks (468 × x,y) for paint, or a prop's four corners. */
  points: Float32Array;
  mesh: boolean;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private copy: Prog;
  private blur: Prog;
  private mix: Prog;
  private meshProg: Prog;
  private video: WebGLTexture;
  private mask: WebGLTexture;
  private small: [Target, Target] | null = null;
  private art = new Map<HTMLCanvasElement, WebGLTexture>();
  private faceVao: WebGLVertexArrayObject;
  private facePos: WebGLBuffer;
  private propVao: WebGLVertexArrayObject;
  private propPos: WebGLBuffer;
  private w = 0;
  private h = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: "low-power", // the built-in GPU: easier on the battery
    });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.copy = this.program(VS_QUAD, FS_COPY, ["u_tex", "u_flip"]);
    this.blur = this.program(VS_QUAD, FS_BLUR, ["u_tex", "u_flip", "u_step"]);
    this.mix = this.program(VS_QUAD, FS_MIX, ["u_sharp", "u_blur", "u_mask", "u_flip"]);
    this.meshProg = this.program(VS_MESH, FS_MESH, ["u_tex", "u_alpha"]);

    // Full-screen triangle pair for the quad passes.
    this.quad = this.vao();
    this.buffer(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.attrib("a_pos", 2);

    // Face mesh: landmark positions change every frame; texture places and triangles never do.
    this.faceVao = this.vao();
    this.facePos = this.buffer(gl.ARRAY_BUFFER, new Float32Array(UVS.length), gl.DYNAMIC_DRAW);
    this.attrib("a_pos", 2);
    this.buffer(gl.ARRAY_BUFFER, UVS, gl.STATIC_DRAW);
    this.attrib("a_uv", 2);
    this.buffer(gl.ELEMENT_ARRAY_BUFFER, TRIANGLES, gl.STATIC_DRAW);

    this.propVao = this.vao();
    this.propPos = this.buffer(gl.ARRAY_BUFFER, new Float32Array(8), gl.DYNAMIC_DRAW);
    this.attrib("a_pos", 2);
    this.buffer(gl.ARRAY_BUFFER, QUAD_UV, gl.STATIC_DRAW);
    this.attrib("a_uv", 2);
    this.buffer(gl.ELEMENT_ARRAY_BUFFER, QUAD_IDX, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.video = this.texture();
    this.mask = this.texture();
  }

  /** Match the output to the camera's frame size. */
  resize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = this.canvas.width = w;
    this.h = this.canvas.height = h;
    this.freeSmall();
  }

  /** The person mask from the segmenter, 0–255, top row first. */
  setMask(data: Uint8Array, w: number, h: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  draw(frame: TexImageSource, blur: boolean, overlays: Overlay[], alpha: number) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.video);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.bindVertexArray(this.quad);

    if (blur) {
      const [a, b] = this.smallTargets();
      // Shrink (bilinear), then blur twice in each direction at quarter size.
      this.pass(this.copy, a, this.video, 1);
      for (const spread of [1, 2]) {
        this.pass(this.blur, b, a.tex, 0, [spread / a.w, 0]);
        this.pass(this.blur, a, b.tex, 0, [0, spread / a.h]);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.w, this.h);
      gl.useProgram(this.mix.p);
      this.bindTex(0, this.video, this.mix.u.u_sharp);
      this.bindTex(1, a.tex, this.mix.u.u_blur);
      this.bindTex(2, this.mask, this.mix.u.u_mask);
      gl.uniform1f(this.mix.u.u_flip, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.w, this.h);
      gl.useProgram(this.copy.p);
      this.bindTex(0, this.video, this.copy.u.u_tex);
      gl.uniform1f(this.copy.u.u_flip, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    if (overlays.length && alpha > 0) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.meshProg.p);
      gl.uniform1f(this.meshProg.u.u_alpha, alpha);
      for (const o of overlays) {
        this.bindTex(0, this.artTexture(o.art), this.meshProg.u.u_tex);
        if (o.mesh) {
          gl.bindVertexArray(this.faceVao);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.facePos);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, o.points, 0, UVS.length);
          gl.drawElements(gl.TRIANGLES, TRIANGLES.length, gl.UNSIGNED_SHORT, 0);
        } else {
          gl.bindVertexArray(this.propVao);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.propPos);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, o.points, 0, 8);
          gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        }
      }
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    this.freeSmall();
    for (const t of this.art.values()) gl.deleteTexture(t);
    this.art.clear();
    gl.deleteTexture(this.video);
    gl.deleteTexture(this.mask);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // ─── helpers ───

  private pass(prog: Prog, to: Target, from: WebGLTexture, flip: number, step?: [number, number]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb);
    gl.viewport(0, 0, to.w, to.h);
    gl.useProgram(prog.p);
    this.bindTex(0, from, prog.u.u_tex);
    gl.uniform1f(prog.u.u_flip, flip);
    if (step) gl.uniform2f(prog.u.u_step, step[0], step[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  private smallTargets(): [Target, Target] {
    if (this.small) return this.small;
    const w = Math.max(1, Math.round(this.w / 4)), h = Math.max(1, Math.round(this.h / 4));
    const make = (): Target => {
      const gl = this.gl;
      const tex = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      if (!fb) throw new Error("no framebuffer");
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fb, tex, w, h };
    };
    return (this.small = [make(), make()]);
  }

  private freeSmall() {
    for (const t of this.small ?? []) { this.gl.deleteFramebuffer(t.fb); this.gl.deleteTexture(t.tex); }
    this.small = null;
  }

  private artTexture(art: HTMLCanvasElement): WebGLTexture {
    let tex = this.art.get(art);
    if (!tex) {
      const gl = this.gl;
      tex = this.texture();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, art);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.art.set(art, tex);
    }
    return tex;
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) throw new Error("no texture");
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private vao(): WebGLVertexArrayObject {
    const v = this.gl.createVertexArray();
    if (!v) throw new Error("no vertex array");
    this.gl.bindVertexArray(v);
    return v;
  }

  private buffer(target: number, data: ArrayBufferView, usage: number): WebGLBuffer {
    const b = this.gl.createBuffer();
    if (!b) throw new Error("no buffer");
    this.gl.bindBuffer(target, b);
    this.gl.bufferData(target, data, usage);
    return b;
  }

  /** Bind the last-bound array buffer to an attribute (all programs share a_pos at 0, a_uv at 1). */
  private attrib(name: "a_pos" | "a_uv", size: number) {
    const loc = name === "a_pos" ? 0 : 1;
    this.gl.enableVertexAttribArray(loc);
    this.gl.vertexAttribPointer(loc, size, this.gl.FLOAT, false, 0, 0);
  }

  private program(vs: string, fs: string, uniforms: string[]): Prog {
    const gl = this.gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error("no shader");
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram();
    if (!p) throw new Error("no program");
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    // Same attribute slots in every program, so one vertex array serves them all.
    gl.bindAttribLocation(p, 0, "a_pos");
    gl.bindAttribLocation(p, 1, "a_uv");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    const u: Prog["u"] = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
    return { p, u };
  }
}

// Profile pictures. People carry an avatar version; the picture itself is
// fetched once per version (authenticated) and cached for the session.
import { api } from "./api";
import { initial } from "./dom";

export interface HasAvatar { id: number; display_name: string; color: string; avatar: number | null }

const cache = new Map<string, Promise<string | null>>();

function load(id: number, version: number): Promise<string | null> {
  const key = `${id}:${version}`;
  let p = cache.get(key);
  if (!p) {
    p = api.avatar(id).then((a) => a.data_url).catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** Round avatar: the picture when there is one, initials on the person's color otherwise. */
export function personAvatar(p: HasAvatar, size = 28, cls = ""): HTMLElement {
  const el = document.createElement("span");
  el.className = `avatar ${cls}`;
  if (size > 0) Object.assign(el.style, { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` });
  el.style.background = p.color;
  el.textContent = initial(p.display_name);
  if (p.avatar) {
    void load(p.id, p.avatar).then((url) => {
      if (!url) return;
      el.textContent = "";
      el.style.background = `center / cover no-repeat url("${url}"), ${p.color}`;
    });
  }
  return el;
}

/** Shrink a picked file to at most 512px (JPEG) before upload; the server makes the final 256px. */
export async function shrinkForUpload(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.9);
}

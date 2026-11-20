// Serves release files from R2: GET/HEAD only, no listing, allow-listed paths,
// country block and per-IP rate limits. Keys:
//   latest.json                 updater feed
//   Treehouse.dmg               newest macOS DMG
//   Treehouse-setup.exe         newest Windows installer
//   v<semver>/<file>            versioned DMG, Treehouse.app.tar.gz, Treehouse-<v>-setup.exe (+ .sig)
const KEY = /^(latest\.json|Treehouse\.dmg|Treehouse-setup\.exe|v\d+\.\d+\.\d+\/[A-Za-z0-9._-]+)$/;

const text = (status, body, extra = {}) =>
  new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", ...extra } });

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "Method not allowed", { allow: "GET, HEAD" });
    }

    const blocked = (env.BLOCKED_COUNTRIES || "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
    const country = request.cf?.country;
    if (country && blocked.includes(country)) {
      return text(451, "Not available in your region");
    }

    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!KEY.test(key)) return text(404, "Not found");

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const limiter = key === "latest.json" ? env.FEED_LIMIT : env.DOWNLOAD_LIMIT;
    const { success } = await limiter.limit({ key: ip });
    if (!success) return text(429, "Too many requests, try again in a minute", { "retry-after": "60" });

    const object = request.method === "HEAD"
      ? await env.BUCKET.head(key)
      : await env.BUCKET.get(key, { onlyIf: request.headers, range: request.headers });
    if (object === null) return text(404, "Not found");

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("x-content-type-options", "nosniff");
    if (key.endsWith(".dmg") || key.endsWith(".exe")) {
      headers.set("content-disposition", `attachment; filename="${key.split("/").pop()}"`);
    }

    if (request.method === "HEAD") {
      headers.set("content-length", String(object.size));
      return new Response(null, { status: 200, headers });
    }
    if (!("body" in object)) return new Response(null, { status: 304, headers });
    if (object.range && request.headers.has("range")) {
      const start = object.range.offset ?? 0;
      const len = object.range.length ?? object.size - start;
      headers.set("content-range", `bytes ${start}-${start + len - 1}/${object.size}`);
      headers.set("content-length", String(len));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set("content-length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  },
};

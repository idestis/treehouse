// DEV ONLY (never in a release build): lets `npm run dev` run in a plain
// browser against a local server, through Vite's /api proxy. The token lives
// in this module's memory only, so a reload signs you out.
import type { Api } from "./index";
import { hub, routes } from "./routes";
import type { ApiError, LiveEvent } from "./types";

let token: string | null = null;
let address = "";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw { error: "offline", message: "Can’t reach the treehouse. Is the local server running (task server:dev)?", status: 0 } satisfies ApiError;
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw { error: data?.error ?? "http_error", message: data?.message ?? `Server error ${res.status}.`, status: res.status } satisfies ApiError;
  if (data && typeof data === "object" && "token" in data) {
    token = data.token;
    delete data.token;
  }
  if (path === "/api/logout") token = null;
  return data as T;
}

let ws: WebSocket | null = null;
let stopped = true;

function connect(emit: (e: LiveEvent) => void, since: Record<string, number>, delay = 1000) {
  if (stopped) return;
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`);
  ws.onopen = () => ws?.send(JSON.stringify({ token, since }));
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === "ready") for (const [ch, s] of Object.entries(e.seqs ?? {})) since[ch] = Math.max(since[ch] ?? 0, s as number);
    else if (e.channel && e.seq) since[e.channel] = e.seq;
    if (e.type === "signed_out") stopped = true;
    emit(e);
  };
  ws.onclose = () => {
    if (stopped) return;
    emit({ type: "offline" });
    setTimeout(() => connect(emit, since, Math.min(delay * 2, 30_000)), delay);
  };
}

export const browserApi: Api = {
  ...routes(call),
  servers: async () => (address ? [{ address, name: "Local treehouse" }] : []),
  probe: async (input) => {
    const info = await call<{ name: string }>("GET", "/api/server-info");
    address = input.trim() || location.host;
    return { address, name: info.name, signed_in: false };
  },
  forgetLogin: async () => { token = null; },
  subscribe: hub<LiveEvent>(
    (emit) => { stopped = false; connect(emit, {}); },
    () => { stopped = true; ws?.close(); ws = null; },
  ),
};

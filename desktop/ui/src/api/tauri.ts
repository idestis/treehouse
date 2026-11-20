import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Api } from "./index";
import { hub, routes } from "./routes";
import type { LiveEvent } from "./types";

const call = <T>(method: string, path: string, body?: unknown) =>
  invoke<T>("api_request", { method, path, body: body ?? null });

let unlisten: UnlistenFn | null = null;

export const tauriApi: Api = {
  ...routes(call),
  servers: () => invoke("servers_list"),
  probe: (address) => invoke("server_probe", { address }),
  forgetLogin: () => invoke("session_clear"),
  subscribe: hub<LiveEvent>(
    (emit) => {
      void listen<LiveEvent>("live", (e) => emit(e.payload)).then((u) => (unlisten = u));
      void invoke("events_start").catch(() => emit({ type: "signed_out" }));
    },
    () => {
      unlisten?.();
      unlisten = null;
      void invoke("events_stop");
    },
  ),
};

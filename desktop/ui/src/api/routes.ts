// Server routes, shared by both transports (spec §9.3).
import type { Api } from "./index";
import type { Me } from "./types";

export type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export function routes(call: Call): Omit<Api, "servers" | "probe" | "forgetLogin" | "subscribe"> {
  return {
    login: (username, password, remember) => call("POST", "/api/login", { username, password, remember }),
    loginMfa: async (mfa_token, code, backup) =>
      (await call<{ me: Me }>("POST", "/api/login/mfa", backup ? { mfa_token, backup_code: code } : { mfa_token, code })).me,
    join: async (input) => (await call<{ me: Me }>("POST", "/api/join", input)).me,
    logout: () => call("POST", "/api/logout"),
    passwordCheck: (input) => call("POST", "/api/password-check", input),

    me: () => call("GET", "/api/me"),
    updateMe: (patch) => call("PATCH", "/api/me", patch),
    changePassword: (current, next) => call("POST", "/api/me/password", { current, new: next }),
    avatar: (id) => call("GET", `/api/avatars/${id}`),
    uploadAvatar: (image) => call("PUT", "/api/me/avatar", { image }),
    removeAvatar: () => call("DELETE", "/api/me/avatar"),
    mfaSetup: () => call("POST", "/api/me/mfa/setup"),
    mfaConfirm: (code) => call("POST", "/api/me/mfa/confirm", { code }),
    treehouse: () => call("GET", "/api/server-info"),
    people: () => call("GET", "/api/people"),
    setRole: (id, role) => call("PATCH", `/api/people/${id}/role`, { role }),
    block: (id) => call("POST", `/api/people/${id}/block`, {}),
    unblock: (id) => call("POST", `/api/people/${id}/unblock`),
    rooms: () => call("GET", "/api/rooms"),

    messages: (id) => call("GET", `/api/channels/${id}/messages`),
    send: (id, body) => call("POST", `/api/channels/${id}/messages`, body),
    deleteMessage: (id) => call("DELETE", `/api/messages/${id}`),
    react: (id, emoji, on) => call(on ? "PUT" : "DELETE", `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
    gifs: (q) => call("GET", `/api/gifs?q=${encodeURIComponent(q)}`),

    voiceToken: (id, opts) => call("POST", `/api/rooms/${id}/voice-token${opts?.overlay ? "?overlay=true" : ""}`),
    createRoom: (input) => call("POST", "/api/rooms", input),
    updateRoom: (id, patch) => call("PATCH", `/api/rooms/${id}`, patch),
    deleteRoom: (id, everyone) => call("DELETE", `/api/rooms/${id}${everyone ? "?everyone=true" : ""}`),
    voiceState: (id, state) => call("POST", `/api/rooms/${id}/voice-state`, state),

    invites: () => call("GET", "/api/invites"),
    createInvite: (input) => call("POST", "/api/invites", input),
    cancelInvite: (id) => call("DELETE", `/api/invites/${id}`),

    devices: () => call("GET", "/api/me/devices"),
    signOutDevice: (id) => call("DELETE", `/api/me/devices/${id}`),
  };
}

/** Fan-out helper: start on first listener, stop after the last. */
export function hub<E>(start: (emit: (e: E) => void) => void, stop: () => void) {
  const fns = new Set<(e: E) => void>();
  return (fn: (e: E) => void) => {
    fns.add(fn);
    if (fns.size === 1) start((e) => fns.forEach((f) => f(e)));
    return () => {
      fns.delete(fn);
      if (fns.size === 0) stop();
    };
  };
}

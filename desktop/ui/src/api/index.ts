// The one door to the server. In the app, calls go through Rust, which holds
// the device token in the OS keychain. In a plain browser during development
// (`npm run dev`), a dev-only transport talks to the local server through
// Vite's proxy and keeps the token in memory.
import type {
  Device, Gif, Invite, LiveEvent, LoginResult, Me, Message, MfaSetup, Person, ProbeResult,
  Reaction, Role, Room, ServerEntry, Treehouse, VoiceGrant,
} from "./types";

export interface Api {
  servers(): Promise<ServerEntry[]>;
  probe(address: string): Promise<ProbeResult>;
  login(username: string, password: string, remember: boolean): Promise<LoginResult>;
  loginMfa(mfa_token: string, code: string, backup: boolean): Promise<Me>;
  join(input: { code: string; display_name: string; username: string; password: string; color: string }): Promise<Me>;
  logout(): Promise<void>;
  passwordCheck(input: { password: string; username?: string; display_name?: string }): Promise<{ score: number; ok: boolean; message: string }>;
  forgetLogin(): Promise<void>;

  me(): Promise<Me>;
  updateMe(patch: Partial<Pick<Me, "display_name" | "color">>): Promise<Me>;
  changePassword(current: string, next: string): Promise<void>;
  mfaSetup(): Promise<MfaSetup>;
  mfaConfirm(code: string): Promise<{ backup_codes: string[] }>;
  treehouse(): Promise<Treehouse>;
  people(): Promise<Person[]>;
  rooms(): Promise<Room[]>;

  messages(channel_id: number): Promise<Message[]>;
  send(channel_id: number, body: { client_id: string; text?: string; gif_id?: string; gif_query?: string }): Promise<Message>;
  deleteMessage(id: number): Promise<void>;
  react(id: number, emoji: string, on: boolean): Promise<Reaction[]>;
  gifs(q: string): Promise<Gif[]>;

  voiceToken(room_id: number): Promise<VoiceGrant>;

  invites(): Promise<Invite[]>;
  createInvite(input: { label: string; role: Role; max_uses: number; hours: number }): Promise<Invite>;
  cancelInvite(id: number): Promise<void>;

  devices(): Promise<Device[]>;
  signOutDevice(id: string): Promise<void>;

  /** Live events; the connection opens with the first subscriber and closes with the last. */
  subscribe(fn: (e: LiveEvent) => void): () => void;
}

const inTauri = "__TAURI_INTERNALS__" in window;

export const api: Api =
  inTauri || !import.meta.env.DEV
    ? (await import("./tauri")).tauriApi
    : (await import("./browser")).browserApi;

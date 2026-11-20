// Shapes returned by the treehouse server (spec §9.3). The client only renders these.
import { currentLang, has, t } from "../i18n";

export type Role = "member" | "moderator" | "admin";

export interface ServerEntry { address: string; name: string }
export interface ProbeResult { address: string; name: string; signed_in: boolean }

export interface Me {
  id: number;
  username: string;
  display_name: string;
  color: string;
  role: Role;
  is_owner: boolean;
  mfa_enabled: boolean;
  /** Admins (and moderators, if required) must turn on two-step sign-in first. */
  mfa_setup_needed: boolean;
  /** Avatar version, null when they use initials. */
  avatar: number | null;
  status: Presence;
  status_emoji: string | null;
  status_text: string | null;
  /** Sounds others hear when this person joins / leaves a voice room. */
  join_sound: SoundName;
  leave_sound: SoundName;
}

/** What people choose to show; being connected (online) is separate. */
export type Presence = "online" | "away" | "busy" | "brb";

export type LoginResult =
  | { status: "ok"; me: Me }
  | { status: "mfa_required"; mfa_token: string };

export interface Person {
  id: number;
  username: string;
  display_name: string;
  color: string;
  role: Role;
  online: boolean;
  avatar: number | null;
  status: Presence;
  status_emoji: string | null;
  status_text: string | null;
  /** Sounds others hear when this person joins / leaves a voice room. */
  join_sound: SoundName;
  leave_sound: SoundName;
}

export interface VoiceMember {
  user_id: number;
  muted: boolean;
  camera: boolean;
  /** Sharing their screen. */
  screen: boolean;
}

/** Your own flags in a voice room, reported after every change. */
export interface VoiceState { muted: boolean; camera: boolean; screen: boolean }

export interface Room {
  id: number;
  kind: "deck" | "voice";
  name: string;
  slug: string;
  capacity: number | null;
  last_used_at?: string | null;
  members: VoiceMember[];
}

export interface Treehouse {
  name: string;
  version: string;
  message_ttl_hours: number;
  max_voice_rooms: number;
  gifs: boolean;
}

export interface Gif { id: string; title: string; url: string; preview_url: string; width: number; height: number }

export interface Reaction { emoji: string; user_ids: number[] }

export interface Message {
  id: number;
  channel_id: number;
  author_id: number;
  client_id: string;
  kind: "text" | "gif" | "roll" | "action";
  body: string | null;
  gif: (Gif & { query?: string }) | null;
  roll: { value: number; max: number } | null;
  mentions: number[];
  created_at: string;
  reactions: Reaction[];
}

export interface Invite {
  id: number;
  label: string | null;
  role: Role;
  max_uses: number;
  uses: number;
  expires_at: string;
  /** Display names of the people who joined with it. */
  joined: string[];
  /** Only present right after creating it. */
  code?: string;
  link?: string;
}

export interface Device { id: string; device_name: string; last_seen: string; current: boolean }

export interface VoiceGrant {
  /** LiveKit server address (wss:// in production). */
  url: string;
  token: string;
  expires_at: string;
  /** "room-<id>" */
  livekit_room: string;
  /** Your user id as a string; LiveKit participants are named by it. */
  identity: string;
}

export interface MfaSetup { secret: string; otpauth_url: string; qr: string }

/** Live events (WS /api/events), numbered per channel, plus connection status. */
export type LiveEvent =
  | { type: "ready" }
  | { type: "offline" }
  | { type: "signed_out" }
  | { type: "message_new"; message: Message }
  | { type: "message_deleted"; channel_id: number; id: number }
  | { type: "reactions"; channel_id: number; id: number; reactions: Reaction[] }
  | { type: "presence"; user_id: number; online: boolean }
  | { type: "people" }
  | { type: "rooms" }
  /** Who is in a voice room, from LiveKit webhooks (channel "treehouse"). */
  | { type: "voice"; room_id: number; members: VoiceMember[] };

export interface ApiError {
  error: string;
  /** English sentence from the server (or the desktop shell). */
  message: string;
  status: number;
  /** Values for the translated sentence, e.g. { room: "Hangout" }. */
  params?: Record<string, string | number>;
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "message" in e && "error" in e;
}

/**
 * Sentence for a server or shell code in the current language. English
 * shows the server's own sentence; other languages look up `err.<code>`
 * and fall back to that sentence for codes they don't know.
 */
export function codeText(code: string, message: string, params?: Record<string, string | number>): string {
  const key = `err.${code}`;
  if (currentLang() === "en" || !has(key)) return message;
  const p = { ...params };
  if (typeof p.until === "string") p.until = until(p.until);
  return t(key, p);
}

/** What to show for a failed request. */
export function errorText(e: unknown): string {
  if (isApiError(e)) return codeText(e.error, e.message, e.params);
  return t("err.generic");
}

/** Timeout end in local time: "18:30", or "21 nov, 18:30" on another day. */
function until(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(currentLang(), sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export type SoundName = "ding" | "doink" | "fart" | "quack" | "hewya" | "yeah-boy" | "female-bye" | "kiddo-bye" | "mmbye" | "none";

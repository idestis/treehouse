# Decisions

Choices made where the spec is silent. Newest last.

## 2026-11-19: Scaffold, build and release

- **One Cargo workspace** at the repo root (`server`, `desktop/src-tauri`), one version in `[workspace.package]`. `task bump` also updates `tauri.conf.json` and `desktop/package.json`. `rust-version = 1.90`: resolver 3 picks crates by MSRV, and 1.85 held `tauri` back below the npm packages.
- **Server env vars have no prefix**, matching the spec (`SETUP_INVITE_TTL`, `MAX_VOICE_ROOMS`): `BIND_ADDR`, `DATABASE_URL`, `PUBLIC_URL`, `DB_MAX_CONNECTIONS`, `RUN_MIGRATIONS`, `LOG_FORMAT`, `LOG_LEVEL`, `SHUTDOWN_GRACE_SECS`. Only `DATABASE_URL` is required.
- **Migrations run at startup** (`RUN_MIGRATIONS=true`). sqlx takes a Postgres advisory lock while migrating, so two replicas starting together are safe (tested).
- **Two replicas behind Caddy** use `reverse_proxy { dynamic a treehouse 8080 }`, so `TREEHOUSE_REPLICAS=1|2` needs no Caddy change. `/healthz` is liveness (no DB), `/readyz` checks Postgres.
- **Image** is `debian:bookworm-slim` + `tini`, non-root, with no curl: `treehouse healthcheck` is the Docker HEALTHCHECK.
- **"The Deck can't be deleted"** can't be a check constraint (checks don't fire on DELETE). Instead `treehouse.deck_room_id` references the Deck with `ON DELETE RESTRICT`, plus a partial unique index allows only one Deck.
- **IDs** are `bigint` identity columns everywhere. Roles and kinds are `text` with `CHECK`, not Postgres enums (simpler with sqlx, easy to extend).
- **Desktop builds from this Mac:** a universal macOS `.app`/DMG (Developer ID, hardened runtime, notarized), and Windows x64 NSIS `-setup.exe` cross-compiled with `cargo-xwin` (needs `nsis`, `llvm`, `lld` from Homebrew). Windows builds have no Authenticode signature, so SmartScreen warns on first run.
- **Updater** works as in kite: the feed URL is baked in at build time (`TREEHOUSE_UPDATE_URL` from `R2_PUBLIC_URL`), and builds without it have updates off. Payloads are signed by hand with `~/.tauri/treehouse.key`: the notarized `.app` tarball (both `darwin-*` entries) and the NSIS `.exe` itself (`windows-x86_64`, passive install).

## 2026-11-20: Auth, chat, live events, desktop screens, tray

- **0001_init.sql was extended in place** (nothing real had run it): login lockout columns, `sessions.id`, `mfa_challenges`, `messages.mentions`, `voice_members`, `events` + `channel_seq`, `connections`, the default rooms (Gaming Loft, Quiet Nook), and `message_json` / `reactions_json` / `rooms_json` SQL functions so the API and live events share one shape. From the first real deploy on, changes go in new migrations.
- **Two-step sign-in is enforced by the server**: an admin (or a moderator when required) without confirmed TOTP gets `403 mfa_setup_needed` everywhere except `/api/me`, `/api/me/mfa/*` and logout. The app routes them to the setup screen.
- **Live events**: every change writes an `events` row (per-channel `seq` from `channel_seq`, row-locked) and `pg_notify('events', id)` in its transaction. `WS /api/events` takes `{token, since}` as its first frame (no token in URLs, works from a browser too); `ready` carries the current seq per visible channel. Voice-room chat events go only to people in the room.
- **Presence** is rows in `connections` with a 30 s heartbeat; the cleanup job sweeps rows older than 2 minutes (a crashed replica) and emits "offline".
- **Invite cancel** sets `expires_at = now()` instead of deleting, so "joined" history stays.
- **Reactions** are `{emoji, user_ids}`; the client derives counts and "mine".
- **Desktop**: Rust does HTTP and the WebSocket, and keeps the token in the keychain; the web view never sees it. `npm run dev` in a plain browser uses a dev-only transport (Vite proxy, token in memory), excluded from release builds.
- **Tray**: mentions-only badge (Telegram style) drawn in Rust; macOS template icon when clear, lantern + red bubble with a count; Dock badge (macOS) and taskbar overlay (Windows). Closing the window hides it to the tray; Quit is in the tray menu.
- **Dev server port is 8090** (`task server:dev`), because 8080 is often taken locally.
- **Not done yet**: voice (`voice-token` answers 503 until LiveKit, milestone 7), moderation actions and admin screens, the `/join` web page for invite links, GIF search without `GIPHY_API_KEY`, and the required concurrency tests.

## 2026-11-20: Avatars (spec change)

- Spec §6 says "no file uploads in v1"; profile pictures were requested anyway. They are the only upload: the app shrinks the picture to 512px, the server decodes it with size limits, center-crops to 256×256 and re-encodes as JPEG (≈10–25 KB, EXIF such as GPS dropped). Stored in Postgres (`avatars`, ≤100 KB per row, migration 0002). Served only to signed-in members as a data URL (`GET /api/avatars/{id}`); people and me carry an `avatar` version so clients refetch only on change.

## 2026-11-20: Statuses, notifications, volumes

- **Presence + custom status** live on `users` (migration 0004): `status` online/away/busy/brb, plus optional `status_emoji` and `status_text` (≤60). Being connected is separate; offline wins when nobody is connected. Numbered 0004 so the voice work can take 0003.
- **Notifications** (tray/Dock badge and the mention chime) are a per-computer preference; "busy" pauses them. The in-app @ badge always shows.
- **Volume sliders** (microphone 0–200%, output 0–100%) are per-computer and sit on top of the fixed voice processing (echo, noise, automatic gain stay on per spec §10); they adjust level only. Output was later capped at 100% (per-track volume in calls); the microphone gain is a LiveKit audio processor.

## 2026-11-20: Voice, camera and screen share (milestone 7, server)

- **Naming:** each voice room is the LiveKit room `room-<id>`; a person's LiveKit identity is their user id as a string, and the token's `name` is their display name. Ids never change, so renaming a room or a person needs nothing from LiveKit.
- **Tokens** are HS256 JWTs signed locally (`hmac` + `sha2`, no LiveKit call): 15 minutes, `canPublishSources` microphone, camera, screen_share, screen_share_audio; no data channel. The app calls `voice-token` again about every 10 minutes; a refusal (timeout, room full) makes it leave.
- **Capacity** is counted from `voice_members` (other people in the room) under `SELECT … FROM treehouse FOR UPDATE`. Two people taking the last seat in the same second can both get a token, because the row appears only when LiveKit's webhook arrives; LiveKit's own `max_participants` is the hard stop. Fine for 15 friends.
- **Timeout copy** shows the end in UTC ("until 21:30 UTC", or with the date when it isn't today): the server doesn't know the person's time zone.
- **Mute, camera and screen flags are reported by the app** (`POST /api/rooms/{id}/voice-state`): LiveKit webhooks don't carry mute toggles, and these flags are display only. Server mutes (milestone 8) are enforced in LiveKit by the outbox worker, not by these flags. Only someone already in `voice_members` for that room can report (409 `not_in_room` until their join webhook has landed; the app retries after it sees itself in a `voice` event).
- **Webhooks are idempotent and order-proof.** Each row keeps the LiveKit participant `sid` that created it. `participant_left` deletes the row only when the sid matches, and records the sid in `voice_left` (tombstones, swept after a day), so a late or repeated `participant_joined` for a session that already left is ignored. A join in another room moves the row (one room at a time) and reports both rooms. `room_finished` removes everyone in that room. Every change is one transaction that locks the treehouse row, writes `voice_members`, emits `voice` on `treehouse` (`{room_id, members}`) and, when the room is empty, deletes that room's chat. Unknown events answer 200; a bad signature answers 401.
- **One JSON shape for members** (`voice_members_json(room)`, migration 0003) is used by both `rooms_json()` and the `voice` event: `{user_id, muted, camera, screen}`.
- **Production webhook config:** a LiveKit config file can't read environment variables, so `docker-compose.yml` appends the `webhook:` section (API key, `https://APP_DOMAIN/api/livekit/webhook`) to a copy of `livekit.yaml` at container start.
- **Dev LiveKit** runs in `deploy/docker-compose.test.yml` (`task db`) with the fixed pair `devkey` / `treehouse-dev-secret-0123456789-not-for-production`, written in `deploy/livekit.dev.yaml` and `Taskfile.yml`. It is dev-only and published on 127.0.0.1 only; never reuse it on a server.

## 2026-11-20: Joining rooms, room admin

- **One click previews** a voice room (Join voice top-right); **double-click or the button joins**. "Join voice when I open a room", "join muted" and "camera on when I join" are per-computer preferences (camera off by default, spec §10).
- **Join sounds** play on each client when the server's `voice` event shows someone new in the room you're in (including you).
- **Room admin** (admins only): create within `max_voice_rooms` under the treehouse-row lock, rename (the #slug follows the name), size 2–10, delete. Deleting an occupied room needs `?everyone=true`; it removes `voice_members`, writes a mod_log row, and queues a LiveKit `DeleteRoom` in the **outbox**, which a worker runs after commit with retries and backoff (one replica at a time via an advisory lock). Rooms carry `last_used_at` (migration 0006).

## 2026-11-20: Releases on GitHub (no R2)

- Releases, downloads and the update feed all live on GitHub Releases for `idestis/treehouse`. Assets have stable names (`Treehouse.dmg`, `Treehouse-setup.exe`, `Treehouse.app.tar.gz` + `.sig`, `latest.json`), so `releases/latest/download/<name>` always serves the newest. Release builds bake `TREEHOUSE_UPDATE_URL=https://github.com/idestis/treehouse/releases/latest/download/latest.json`.
- `task publish` creates the release as a draft with every file attached, then publishes it, so the feed never points at missing files. The Cloudflare Worker (infra/releases) and R2 variables are gone.
- The feed needs the repo to be public: private release assets require authentication, so installed apps can't update while it's private.

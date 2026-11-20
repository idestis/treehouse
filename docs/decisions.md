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

## 2026-11-20: Push to talk, suggestions

- **Push to talk** is a system-wide shortcut (tauri-plugin-global-shortcut, accelerators built from KeyboardEvent.code): hold to talk, release to mute; with it bound you join muted. Mute and deafen stay window-only so their defaults (Ctrl+M, Ctrl+D) aren't taken from other apps.
- **Known gap:** if LiveKit dies without sending leave webhooks, `voice_members` keeps stale rows until `room_finished`. A periodic reconcile against LiveKit's ListParticipants (one replica, advisory lock) would fix it; not built yet.

## 2026-11-20: Levelled sounds, separate sounds volume

- Join/leave sounds play through Web Audio with a per-file gain (`GAIN_DB` in desktop/ui/src/sounds.ts) so each lands near -18 dBFS: measured as the RMS of 50 ms windows above -50 dBFS with AVFoundation (no ffmpeg on the build Mac), boosts capped so the sample peak stays under -1 dBFS. The files stay as delivered. Re-measure when adding a sound.
- "Sounds volume" (join, leave, mention chime; default 70%) is separate from "Voices volume" (people in calls).
## 2026-11-20: People overlay while screen sharing (desktop)

- **What:** while you share your screen, a small always-on-top window shows everyone in your call (camera if on, otherwise their picture, a lantern ring while they talk, a muted-mic mark). It opens on its own when sharing starts if Settings → Sound → "Show people on top while I share" is on (per-computer, default on), and the call bar's "Pop out people" button toggles it any time. It closes when the share it opened for stops, when you leave, or when the call ends. One you opened by hand stays open when sharing stops. Desktop app only; the dev browser transport hides it.
- **A second LiveKit connection:** each Tauri window is its own web view and can't hand MediaStreams to another, so the overlay page (`index.html#overlay=<room id>`, same bundle) connects by itself. It never plays sound (the main window does) and subscribes to cameras only, never microphones or screens.
- **Overlay tokens (server):** `POST /api/rooms/{id}/voice-token?overlay=true`. Only while you're in that room's `voice_members` (409 `not_in_room` otherwise; the page retries a few times right after joining, until the join webhook has landed). Same timeout checks as normal tokens. Doesn't count toward capacity, doesn't touch `last_used_at`, takes no lock (it writes nothing). Identity `<user id>-overlay`, 15 minutes, `canSubscribe` only, `canPublish`/`canPublishData` false, `hidden: true`, so other people never see it. The normal token's response is unchanged.
- **Webhooks ignore every identity that isn't all digits** (`livekit::user_identity`), so overlay joins and leaves never add members, emit events or clear room chat. Checked against a real LiveKit 1.9.3: others don't see the overlay participant, it can't publish, and its join/leave webhooks are ignored.
- **The window** (`overlay.rs`): label `overlay`, about 240×400 at the top-right of the screen the main window is on, always on top, on all workspaces, no decorations, no taskbar entry, not maximizable (double-clicking the drag area would fill the screen), opened without focus so it doesn't pull you out of a game, and `content_protected` so it's left out of your screen share. Its place and size are saved to `overlay.json` in the app config folder when it closes, and reused if that spot is still on a connected screen. API calls go through the shared Rust client, so the device token stays in Rust. A capability scoped to the overlay window allows dragging and closing.
- **Known limits:** macOS puts full-screen apps in their own Space, and an ordinary always-on-top window may not show over them (borderless/windowed games work; Windows exclusive full screen also covers it). Screen-capture exclusion depends on the OS: recent macOS versions have let ScreenCaptureKit capture windows that ask to be excluded, so the overlay could show up in a whole-screen share there. Clicking or dragging the overlay focuses Treehouse, which takes focus from the game until you click back.

## 2026-11-20: Computer sound with screen sharing on macOS

- **Why native:** the macOS web view's `getDisplayMedia` shares only the picture. The app captures the sound itself with ScreenCaptureKit (macOS 13+, `desktop/src-tauri/src/system_audio.rs`) and publishes it as the screen-share audio track, so the existing "With sound" badge works unchanged. Windows keeps using `getDisplayMedia`'s system audio.
- **Crate:** `objc2-screen-capture-kit` (plus `objc2-core-media`), the objc2 family Tauri already pulls in. Pure Rust, no Swift toolchain at build time (the `screencapturekit` crate compiles a Swift bridge). All of it is behind `cfg(target_os = "macos")`; elsewhere the commands answer `unsupported`.
- **Capture:** a stream on the first display with `capturesAudio`, 48 kHz stereo, `excludesCurrentProcessAudio`, and the Treehouse app itself excluded from the content filter (by pid and bundle id), so other people's voices played by Treehouse are never sent back to them. ScreenCaptureKit always captures a picture too; it is 2×2 px at 1 fps and ignored. The Screen Recording permission already needed for screen sharing covers it; no extra entitlement or Info.plist key.
- **Transport:** a Tauri IPC `Channel` with raw binary messages: 20 ms chunks of interleaved i16 LE (3840 bytes, about 1.5 Mbit/s locally). An audio worklet keeps an 80 ms jitter buffer (silence on underrun, drops back to 80 ms past 250 ms to absorb clock drift) and feeds a `MediaStreamAudioDestinationNode`.
- **Publishing:** `Track.Source.ScreenShareAudio`, `musicHighQualityStereo` (128 kbit/s), stereo, DTX and RED off, no echo cancellation, noise suppression or gain control. Windows screen-share audio gets the same publish settings and asks `getDisplayMedia` for unprocessed audio.
- **Choice:** "Include my computer's sound" in the share menu, remembered per computer and per mode: on for "Watching or playing", off for "Reading together". Errors: `permission` shows the Screen Recording banner ("Your screen is shared without sound"); anything else keeps the picture and says only the picture is shared.
- **Known limits:** streaming services (Netflix and similar) block capture with DRM and show black on every platform; the menu says so. Sound runs about 100 ms behind live (capture, IPC, jitter buffer), close to the screen video's own delay. Whether macOS attributes audio played by WebKit's helper processes to Treehouse for the exclusion could not be verified without granting Screen Recording on the build machine; if people hear themselves echo while someone shares on a Mac, that is the place to look.

## 2026-11-20: WebSocket revocation and hello limits

- **Revocation:** migration 0010 adds triggers that `NOTIFY session_revoked` (session id) after any `sessions` delete, including the expiry job and user deletion cascades, and `NOTIFY user_blocked` (user id) when `blocked_at` goes from null to set. Each replica's event listener forwards these to its sockets on the existing broadcast under an internal channel (`!revoked`) that is never sent to clients. A matching socket gets the same `{"type":"signed_out"}` frame as a refused hello and is closed. Every 30 s heartbeat, and once after `since` replay, the socket re-checks its session (exists, not expired, user not blocked, two-step setup not now required), which covers expiry and any NOTIFY missed while the listener reconnects.
- **Hello limits:** inbound WebSocket messages and frames are capped at 16 KiB (the hello is the only frame read). Only canonical channel names (`treehouse`, `room:<id>` exactly as the server formats it) are replayed; others are skipped before any query. At most 64 `since` entries are replayed: treehouse first, then rooms by id, newest first. Extra entries are dropped, not rejected, so a client that remembers many deleted rooms still connects.

## 2026-11-20: GIF limit (10 per minute per person)

One `gif_requests(user_id, at)` table counts GIF searches (cache hits included) and GIF sends together; the check prunes that user's rows older than a minute, counts and inserts under the user row lock. `send` runs its cheap checks (dedup, channel, timeout, message rate) first, then takes a GIF slot, then calls GIPHY outside any transaction, then re-checks under the author lock. Search text is capped at 50 characters.

## 2026-11-20: Two-step code limit per account, and password hashing off the async workers

- **Wrong two-step codes count per account** in a new `users.failed_mfa` column (migration 0011), not only per `mfa_challenges` row. Five wrong codes in total, across any number of challenges, set the existing `users.locked_until` (15 minutes) and remove the person's open challenges, so both `/api/login` and `/api/login/mfa` answer 429 `locked` "Too many wrong tries. Wait 15 minutes." The count is cleared only by a correct code (or restarts when the lock is set, like `failed_logins`). A correct password clears `failed_logins` and `locked_until` as before but never `failed_mfa`.
- **Why a separate column, not `failed_logins`:** a correct password must keep clearing wrong-password tries (otherwise a person who mistypes twice and then signs in still carries the strikes), while wrong codes must survive a correct password. One counter can't follow both rules. The lock itself reuses `locked_until`, so there is one lockout, one message and one admin unlock (`treehouse admin unblock` clears `locked_until`; it does not reset `failed_mfa`, so an unlocked account that had 1–4 wrong codes keeps them until its next correct code).
- **Code checks lock the user row first** (`SELECT … FROM users … FOR UPDATE`, then the challenge and `mfa` rows), so every attempt for one person runs one at a time. A backup code is removed with `UPDATE … WHERE $2 = ANY(backup_code_hashes) RETURNING`, and zero rows counts as a wrong code, so one backup code can't sign in twice.
- **TOTP codes work once:** `mfa.last_totp_step` (migration 0011) stores the newest accepted time step (unix time / 30); a code for that step or an older one is refused, even inside the ±1 step skew. Setting up two-step sign-in (account.rs) doesn't record its step, so the code typed at setup can still be used once to sign in within its window.
- **argon2 and zxcvbn run on the blocking pool** (`spawn_blocking`) behind a `tokio::sync::Semaphore` in `AppState` (permits = available parallelism, at least 2). `/api/login` reads the hash without a transaction, verifies with no connection held, then opens the transaction and re-checks lockout, block and the hash itself under `FOR UPDATE` before writing. Unknown usernames still pay one dummy verify. `/api/join` rejects an unusable invite with a plain SELECT before the strength check and hash; the atomic `UPDATE invites … uses < max_uses … RETURNING` is still the real gate. Change-password (account.rs) still hashes inline; it needs a signed-in user.

## 2026-11-20: Message encryption at rest (deferred, not in alpha)

- **Alpha stores message text as plain `text`** (`messages.body`). Protection comes from expiry (real deletion), a private database, and host disk encryption.
- **Later, optional:** if a server key is set (env var), the server encrypts `body` before insert and decrypts on read (AEAD, e.g. XChaCha20-Poly1305, key id stored per row so keys can rotate). `gif`, `roll`, `mentions` and reactions stay plain. Without the key, behaviour is unchanged.
- **What it protects:** database dumps, backups and direct DB access. **Not** a compromised server, since the key lives there; that would need a key held outside the server (KMS or similar), which is out of scope.

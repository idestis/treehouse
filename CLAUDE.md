# CLAUDE.md

Guidance for working on Treehouse. Read `docs/spec.md` first. It is the source of truth. If this file and the spec disagree, the spec wins; flag the conflict instead of guessing.

## What we're building

A private voice and chat hangout for 3–15 teenagers, run on one small server:

- **The Deck:** text chat with @mentions, #room links, `/commands`, GIFs, emoji and reactions.
- **Voice rooms:** 2–3 of them, with optional camera and per-room chat.
- **Invite-only access**, with three roles (member, moderator, admin) and moderation tools.
- **Messages expire** after a few days.

## Repository layout (target)

```
server/            Rust service: HTTP API, WebSocket events, background jobs
  src/
    main.rs        config, startup, router
    config.rs
    db/            sqlx queries grouped by area (users, invites, rooms, messages, moderation, outbox)
    http/          axum handlers, one module per API area in spec §9.3
    ws/            WebSocket gateway, LISTEN/NOTIFY fan-out, per-channel sequence numbers
    jobs/          expiry, room-chat clearing, outbox worker (each behind an advisory lock)
    livekit.rs     tokens + RoomService calls (remove participant, mute track, update permissions)
    gifs.rs        GIPHY proxy with rating filter and a 10-minute cache
    auth/          passwords (argon2), TOTP + backup codes, sessions, extractors
    perms.rs       role checks: one function per permission in spec §2
  migrations/      sqlx migrations, forward-only
  tests/           integration tests against a real Postgres
desktop/           Tauri 2 app
  src-tauri/       Rust side: keychain, HTTP client, WebSocket, LiveKit token refresh
  ui/              web UI (plain TS + Vite, or a light framework; no heavy state libraries)
deploy/            docker-compose.yml, Caddyfile, livekit.yaml, .env.example
docs/spec.md
mocks/             design references (do not ship)
brand/
reference/         old prototype, for snippets only
```

## Build order (milestones)

Finish each milestone with tests passing before starting the next.

1. **Skeleton:** workspace, config from env, Postgres via sqlx, first migration (spec §9.4 tables), health endpoint, docker compose that boots all four containers.
2. **Setup and auth:**
   - Setup invite on first boot (2 h TTL, printed as a link and a terminal QR code) and the `treehouse setup-invite` / `treehouse admin …` CLI commands.
   - Join with an invite; login; TOTP and backup codes (required for admins); device sessions; logout.
3. **People and invites:** roles, promote and demote with the last-admin rule, block and unblock, invite create, cancel and use (single and multi-use).
4. **Rooms:** The Deck (permanent) and voice rooms, with the max-rooms rule, capacity, delete-only-when-empty, and `last_used_at`.
5. **Realtime:** WebSocket gateway, events with per-channel sequence numbers, reconnect with `since`, presence and voice occupancy.
6. **Chat:** messages with `client_id` deduplication, delete, reactions, mentions, #room links, `/shrug` `/roll` `/me`, the GIF proxy and `/giphy`, rate limits, and the expiry jobs.
7. **Voice:** voice tokens (15-minute TTL, refreshed by the client, refused while sanctioned), LiveKit webhooks for joins and leaves, room chat cleared when a room empties.
8. **Moderation:** sanctions (mute, kick from room, voice timeout, treehouse timeout), lifting, the mod log, and the outbox worker that enforces sanctions in LiveKit.
9. **Desktop app:** the screens in `mocks/`, in this order: find treehouse, sign in, two-step, join, The Deck, voice rooms, settings. Then the admin and moderation screens listed in spec §7.6.
10. **Hardening:** backups, structured logs, metrics endpoint, load test with 15 fake clients.

## Rules that must not be broken

These are the reasons the design is small and race-free. Do not work around them for convenience.

- **Postgres is the only source of truth.** No in-memory state that matters across requests, apart from caches that can be thrown away (the GIF cache, WebSocket connection maps).
- **One action, one transaction.** Each state change is one transaction that checks its rule and writes the result. Never check in one query and write in another without a lock.
- **Invariants live in the database:**
  - Usernames unique case-insensitively (`citext` or a unique index on `lower(username)`).
  - Invite use is a single `UPDATE invites SET uses = uses + 1 WHERE code_hash = $1 AND uses < max_uses AND expires_at > now() RETURNING …`.
  - The Deck can't be deleted (check constraint on `kind`).
  - `reactions` primary key `(message_id, user_id, emoji)`; `messages` unique `(author_id, client_id)`.
  - Rules that span rows (room limit, at least one admin, room capacity): `SELECT … FROM treehouse FOR UPDATE` first, then count and write in the same transaction.
- **Side effects after commit go through the outbox.** Anything that talks to LiveKit or another service is written as an `outbox` row in the same transaction and run by the worker with retries. Never call LiveKit inside a transaction, or before commit.
- **Background jobs take `pg_try_advisory_lock`** so two server copies never run the same job.
- **Events are numbered per channel.** Clients resume with `since=<seq>`. The server never sends an event before its transaction has committed (use `NOTIFY` inside the transaction; Postgres delivers it on commit).
- **Message expiry is real deletion.** Delete expired rows in batches (for example `DELETE … WHERE id IN (SELECT id … LIMIT 1000)`). Don't soft-delete for expiry. The mod log is kept separately for 90 days.
- **The client holds no business rules.** It never decides permissions, limits or expiry; it shows what the server returns. Hide buttons for UX, but the server must reject everything anyway.
- **Secrets stay on the server.** The GIPHY key, the LiveKit secret and the TOTP secrets never reach the client. The client never calls GIPHY directly.
- **Tokens:**
  - The device token lives in the OS keychain (`keyring` crate), never in localStorage or files.
  - Only SHA-256 hashes of tokens, invite codes and backup codes are stored.

## Permissions

Implement spec §2 as plain functions in `perms.rs`, for example `can_moderate(actor, target) -> Result<(), Denied>`, and call them from handlers. The hierarchy rules:

- Moderators act on members only. Admins act on members and moderators.
- Only the owner can block or demote another admin.
- Never leave zero admins.
- Timeout length is capped by role: moderators 24 h, admins 7 days.

Every moderation action writes a `mod_log` row in the same transaction.

## Conventions

- **Rust:** stable toolchain, `cargo fmt`, and `cargo clippy -- -D warnings` must pass.
  - No `unwrap()` or `expect()` in request paths.
  - Errors go through one `AppError` type that maps to HTTP status and a short, user-readable message.
- **sqlx:** use `query!` / `query_as!` macros with offline mode (`cargo sqlx prepare`), so builds don't need a database.
- **API:** JSON, `snake_case` fields, RFC 3339 times in UTC. Errors look like `{ "error": "code", "message": "Human sentence." }`.
- **Copy** follows the mocks: plain verbs, sentence case, errors that say what happened and what to do. Examples: "Wrong username or password." and "Too many wrong tries. Wait 15 minutes."
- **Config** comes from environment variables only (see `deploy/.env.example`). Every variable gets a default except secrets.

## Tests

- Integration tests run against real Postgres (docker compose service `postgres-test`, or `testcontainers`). Don't mock the database.
- **Concurrency tests are required** for each invariant. Fire 20 parallel requests and assert exactly one or N succeed:
  - The same single-use invite used twice.
  - Two admins demoting each other at the same moment (one admin must remain).
  - Two rooms created when there's space for one.
  - The same `client_id` message sent twice.
  - Joining a full room.
- Expiry job: insert messages with old timestamps and assert they're gone after one run, along with their reactions.
- LiveKit is faked in tests behind a trait. The outbox worker is tested for retry and idempotency.

## Desktop app notes

- Match `mocks/` for layout, colors and copy. Design tokens are in spec §8:
  - `night` `#0E1322`, `canopy` `#121A2E`, `surface` `#182238`
  - `moon` `#ECEFF8`, `mist` `#A9B1CC`
  - `lantern` `#FFB347`, `leaf` `#63D69E`, `ember` `#FF8A7E`
- Fonts: Bricolage Grotesque (headings) and Atkinson Hyperlegible (text), bundled via `@fontsource`.
- Logo and first-screen picture are in `brand/`. Generate app icons with `npx tauri icon brand/treehouse-logo.png`.
- Voice settings are fixed. Copy `AUDIO_CAPTURE` and `PUBLISH` from `reference/prototype/desktop/ui/main.js`.
- Voice tiles split the stage evenly: 1 person fills it, 2 sit side by side, 3–4 make a 2 × 2 grid, 5–6 make a 3 × 2 grid.
- Hotkeys: Ctrl+M mute, Ctrl+D deafen. Respect `prefers-reduced-motion`; the first-screen animation must switch off.

## Commands

Everything goes through `task` (see `Taskfile.yml`, `task --list`):

```bash
task setup            # tools (rust targets, cargo-xwin, nsis, llvm, lld) + npm install
task db               # throwaway Postgres on 127.0.0.1:55432
task server:dev       # run the server against it
task dev              # desktop app with hot reload
task verify           # fmt check, clippy -D warnings, cargo test, tsc
task server:image     # Docker image (linux/amd64 by default)
task up               # full stack from deploy/.env (TREEHOUSE_REPLICAS=2 for two)
task dmg              # universal, Developer ID signed DMG (task mac also notarizes)
task windows          # Windows x64 NSIS installer, cross-built here
task release -- 0.2.0 # bump, ship mac + windows, tag, publish the GitHub release
```

## When unsure

Check `docs/spec.md` section by section. If the spec is silent, choose the simplest option that keeps the rules above, write it down in `docs/decisions.md` (create it if needed), and mention it in your summary.

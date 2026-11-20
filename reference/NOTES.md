# Reference prototype

`prototype/` is the first scaffold built before the spec existed (it was called "Huddle"). It compiles, and its server flow was tested by hand, but it does **not** follow `docs/spec.md`. Use it as a source of working snippets, not as the starting codebase.

## Worth reusing
- `server/src/livekit.rs`: LiveKit access tokens (HS256 JWT, room grants) and `ListParticipants` through the Twirp API.
- `server/src/auth.rs`: Argon2 password hashing, TOTP (`totp-rs`), lockout counting, hashed session tokens.
- `server/src/util.rs`: human-friendly codes with no 0/O/1/I/L, and token hashing.
- `desktop/src-tauri/src/lib.rs`: keeping the device token in the OS keychain (`keyring` crate) and calling the server from Rust instead of the web view.
- `desktop/ui/main.js`: the LiveKit `Room` setup for clean voice (`AUDIO_CAPTURE` and `PUBLISH` constants: echo/noise/gain on, Opus 48 kbit/s, DTX, RED), the speaking-level loop, and device switching.
- `docker-compose.yml`, `Caddyfile`, `livekit.yaml`: a working single-host deployment shape.

## Different from the spec
- SQLite instead of Postgres.
- Device pairing codes instead of signing in from the app.
- No roles, moderation, chat, message expiry, room limits or WebSocket events.
- Its web portal pages and their styling are superseded by the night theme in `mocks/`.

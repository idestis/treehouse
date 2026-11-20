# Treehouse

A private, self-hosted voice and chat hangout for a small crew of teenagers who game together at night. It works like a tiny Discord they own: one text chat (The Deck), a few voice rooms with optional camera, invite-only, running on one small server.

This folder is the hand-off for implementation: the spec, the design mocks, the brand assets, and a reference prototype.

## What's here

| Path | What it is |
|---|---|
| `docs/spec.md` | **Product and technical spec (v0.3). The source of truth.** Roles, moderation, setup, rooms, message expiry, server stack, API, data model, client. |
| `CLAUDE.md` | Working instructions for Claude Code (or any developer): architecture, conventions, build order, rules that must not be broken. |
| `mocks/index.html` | Start here for the design: links to every clickable screen and all screenshots. |
| `mocks/*.html` | Clickable HTML mocks of each screen. They open straight from disk in any browser, with no build step. |
| `mocks/screenshots/` | PNG screenshots of every screen and key state (GIF picker, emoji, slash commands, 2 × 2 voice grid, room chat, settings tabs). |
| `brand/treehouse-logo.png` | App logo, also used as the app icon. |
| `brand/left-side-pic.png` | Treehouse illustration for the first-launch screen. |
| `reference/prototype/` | Earlier working scaffold (Rust server + Tauri app). Reuse snippets only; see `reference/NOTES.md`. |

## Viewing the mocks

Open `mocks/index.html` in a browser. Everything is local (fonts, images, a tiny mock runtime), so it also works offline.

The mocks use fake data. The script inside each file is mock logic only: it shows intended behavior, but none of it should be copied into the product.

## Architecture in one picture

```
 Tauri desktop app ──HTTPS + WebSocket──► treehouse server (Rust) ──► Postgres
        │                                       │
        └──────────── WebRTC ──────────► LiveKit (voice / camera)
                                     Caddy in front for HTTPS
```

- **Server:** Rust (axum, tokio, sqlx) with Postgres 16. Every rule is enforced in transactions and constraints, so it's race-free.
- **Voice and camera:** a self-hosted LiveKit server.
- **Client:** a thin Tauri 2 app. It keeps the token in the OS keychain and renders what the server says.
- **Deploy:** `docker compose` on one small VPS.

## Next steps

1. Read `docs/spec.md`, then `CLAUDE.md`.
2. Answer the open questions in spec section 12, or accept the defaults.
3. Build in the milestone order from `CLAUDE.md`.

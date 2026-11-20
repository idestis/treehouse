# Treehouse

A private voice room for a small group of friends. Self-hosted, invite-only, and built so nobody has to touch audio settings.

- **server/**: Rust (axum + SQLite). Web portal for sign-up with invite codes, two-step sign-in, account and device management, plus an admin page. Also the JSON API the app uses.
- **desktop/**: Tauri 2 app for Windows, macOS and Linux. Pair once, press Join, talk.
- **LiveKit** carries the voice. It's self-hosted next to the server with docker-compose.

```
 desktop app ──HTTPS──► treehouse server (accounts, invites, MFA, voice tokens)
      │
      └──────WebRTC───► LiveKit (forwards audio as-is, built-in TURN relay)
```

## What you need

- A small Linux server (1 vCPU / 1 GB is plenty for 5 people) with a public IP.
- Two DNS names pointing at it, for example `chat.example.com` (website) and `voice.example.com` (voice).
- Open ports: TCP 80, 443, 7881; UDP 3478 and 50000–50200.
- Docker with the compose plugin.

## 1. Start the server

```bash
cp .env.example .env
# edit .env: your two domains, and two random values:
openssl rand -hex 24   # use for LIVEKIT_API_KEY
openssl rand -hex 24   # use for LIVEKIT_API_SECRET

docker compose up -d --build
docker compose logs treehouse | grep "Create the admin"
```

Open the link from the log. It creates the first (admin) account. Turn on two-step sign-in from **My account**.

## 2. Invite friends

Open **People & invites**, type who it's for, and choose **Create invite**. Send the link; it works once and expires.

## 3. Build the desktop app

Prerequisites: Rust (stable), Node.js 20+, and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
cd desktop
npm install
npm run tauri dev      # run while developing
npm run tauri build    # installers in src-tauri/target/release/bundle/
```

To change the icon, replace `src-tauri/icons/app-icon.png` and run `npx tauri icon src-tauri/icons/app-icon.png`.

Each person then pairs once: on the website, **My account → Pair a computer**, and type the code into the app.

## Local development without Docker

```bash
# Terminal 1: LiveKit in dev mode (key "devkey", secret "secret")
livekit-server --dev

# Terminal 2: the server
cd server
PUBLIC_URL=http://127.0.0.1:8080 \
LIVEKIT_URL=ws://127.0.0.1:7880 \
LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
COOKIE_SECURE=false cargo run

# Terminal 3: the app (server address: http://127.0.0.1:8080)
cd desktop && npm run tauri dev
```

The app only allows plain `http://` for `localhost` / `127.0.0.1`.

## How voice is kept clean

All of this is fixed in `desktop/ui/main.js` (`AUDIO_CAPTURE` and `PUBLISH`), so there are no knobs for kids to break:

- Echo removal, background-noise removal and automatic volume leveling are always on. Voice isolation is requested too and used where the web view supports it.
- Opus at 48 kbit/s mono, which is clear speech with room to spare.
- **DTX**: nothing is sent while someone is quiet.
- **RED**: each audio packet carries a copy of the previous one, so a lost packet doesn't become a click or gap.
- LiveKit forwards packets without re-encoding, so friends hear exactly what was sent.
- The microphone stays open while muted, so unmuting is instant.

Platform note: Windows (WebView2) and macOS (WKWebView) have solid WebRTC. On Linux, WebKitGTK's WebRTC support depends on the distro's build, so voice there may not work yet.

## Security notes

- Passwords: Argon2. Session cookies, device tokens and pairing codes are stored only as SHA-256 hashes.
- Lockout after 5 wrong passwords or codes in 15 minutes per username.
- Cookies are `HttpOnly`, `Secure` and `SameSite=Lax`, which blocks cross-site form posts.
- The device token sits in the OS keychain, never in the web view.
- Pausing an account signs it out of the website and every paired computer.
- Voice tokens last 6 hours and only allow the microphone in one room.

## Adding video later

1. `server/src/livekit.rs`: add `"camera"` and `"screen_share"` to `can_publish_sources` (optionally per user, from a new admin toggle).
2. `desktop/ui/main.js`: add a camera button that calls `room.localParticipant.setCameraEnabled(...)`, and in `TrackSubscribed` attach video tracks into the person's tile in place of the avatar.
3. `adaptiveStream` and `dynacast` are already on, so video adjusts to each person's connection.

## Ideas for next steps

- Show who's already in the room before joining (server calls LiveKit's `ListParticipants`).
- Passkeys as an easier second factor for kids (`webauthn-rs`).
- Per-person volume slider and push-to-talk.
- Quiet hours set by the admin (refuse voice tokens outside them).
- Mobile: Tauri 2 can build Android and iOS from the same project.

## Layout

```
server/
  src/main.rs        config, startup, first admin invite
  src/web.rs         website pages (login, join, account, admin)
  src/api.rs         desktop app API (pair, me, voice-token, unpair)
  src/auth.rs        passwords, TOTP, sessions, device tokens, lockout
  src/livekit.rs     voice token signing
  templates/         HTML pages (Askama)
  static/style.css
  migrations/        SQLite schema
desktop/
  ui/                index.html, main.js, style.css
  src-tauri/src/lib.rs   pairing, keychain, server calls
docker-compose.yml  Caddyfile  livekit.yaml  .env.example
```

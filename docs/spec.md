# Treehouse: product and technical spec

Version 0.3. Replaces 0.2. Adds roles and moderation, the setup flow, room limits, message expiry, the server stack, and everything designed since 0.2: The Deck text chat, room chat, camera, slash commands, GIFs, emojis and reactions.

## 1. What it is

Treehouse is a private, self-hosted hangout for a small crew of teenagers (about 3–15 people) who game together at night. It works like a tiny Discord that they own:

- **One text chat.** The Deck is where everyone talks by typing.
- **A few voice rooms.** Calls with optional camera.
- **Invite-only.** Nobody gets in without an invite.
- **Self-hosted.** It runs on one small server that someone in the family looks after.

**Principles**

1. **Night first.** Dark only, with lantern amber as the one loud color.
2. **Familiar.** Channels on the left, people in the middle, your controls bottom-left, just like Discord.
3. **Small on purpose.** Few rooms, messages that expire, one server, one database. Nothing to babysit.
4. **Zero audio fiddling.** Voice quality is decided by the app.
5. **Safe by default.** Admins and moderators can calm things down quickly, and every action is logged with a reason.

## 2. Roles and permissions

There are three roles. Every account has exactly one.

| | Member | Moderator | Admin |
|---|:-:|:-:|:-:|
| Chat in The Deck and room chat, join voice, use camera | ✓ | ✓ | ✓ |
| React, use `/commands`, GIFs, emoji | ✓ | ✓ | ✓ |
| Delete own messages | ✓ | ✓ | ✓ |
| Delete anyone's message | | ✓ | ✓ |
| Mute someone in voice (server mute) | | ✓ | ✓ |
| Kick someone from a voice room (back to The Deck) | | ✓ | ✓ |
| Time someone out from voice or the whole treehouse, with a reason | | ✓ (up to 24 h) | ✓ (up to 7 days) |
| See the moderation log | | ✓ | ✓ |
| Create and cancel invites | | | ✓ |
| Promote or demote (member, moderator, admin) | | | ✓ |
| Block or unblock an account | | | ✓ |
| Reset someone's two-step sign-in | | | ✓ |
| Create, rename, reorder and delete rooms | | | ✓ |
| Change treehouse settings (name, message expiry, limits) | | | ✓ |

**Who can act on whom**
- Moderators can only act on members.
- Admins can act on members and moderators. Admins can't block or demote another admin unless they're the **owner**, the account that used the setup invite.
- The treehouse always keeps at least one admin. The last admin can't demote themselves, and nobody can block them.

## 3. Setup: from empty server to first invite

1. **Start the stack** (section 9) with `docker compose up -d`.
2. **First boot creates a setup invite:** single use, admin role, owner flag, and valid for **2 hours** by default (`SETUP_INVITE_TTL`, from 15 minutes up to 24 hours). The server prints it to the log as a link and as a QR code you can scan in a terminal:
   `https://owls.example.net/join?code=XXXXX-XXXXX`
3. **The owner opens the link** or types the server address in the app, chooses **I have an invite code**, and creates their account.
4. **The app then requires two-step sign-in for the owner.** It's mandatory for admins and optional for everyone else; the admin can turn on "required for moderators" too.
5. **The owner names the treehouse** ("Night Owls"), checks the voice rooms, and creates invites for friends.

**If the setup invite expires,** run `docker compose exec treehouse treehouse setup-invite`. It only works while no admin exists.

**Recovery commands** (server shell only, never in the app):
- `treehouse admin promote <username>`
- `treehouse admin reset-mfa <username>`
- `treehouse admin unblock <username>`

### Invites

- **Admins only.** A setting, "Moderators can invite", is off by default.
- **Options:** valid for 1 hour, 1 day, 3 days or 7 days. Uses: once (default) or up to 5. Starting role is member, or moderator if chosen.
- **Link format:** `https://<server>/join?code=…`. The page shows **Open in Treehouse** (`treehouse://join?server=…&code=…`) and a download link.
- **Invite list:** each invite shows as waiting, used (by whom) or expired, and admins can cancel any waiting invite.

## 4. Moderation

All actions are available from **right-clicking a person**: on their voice tile, their name in the sidebar, or their name on a message. Each action asks for a **reason**, which is required for timeouts and blocks and optional for the rest. Reasons show to the person affected and in the moderation log.

| Action | Who | What happens |
|---|---|---|
| **Mute in voice** | Mod, admin | Their microphone is cut off by the server and they can't unmute. Their tile shows a lock on the mic. Lasts until unmuted, they leave the room, or for a chosen time (5 min, 15 min, 1 h). |
| **Kick from room** | Mod, admin | They're disconnected from voice and land in The Deck with a notice: "You were moved out of Gaming Loft by Ana: too loud." They can rejoin right away. |
| **Timeout from voice** | Mod (≤ 24 h), admin (≤ 7 d) | Kicked from voice, and voice rooms show as locked with the end time. They can still chat in The Deck. |
| **Timeout from treehouse** | Mod (≤ 24 h), admin (≤ 7 d) | Kicked from voice and can't post anywhere. They can still read, and a banner shows the reason and when it ends. |
| **Delete message** | Author, mod, admin | Removed for everyone. Mod and admin deletions go in the log. |
| **Block** | Admin | Account suspended until unblocked. Every session is signed out immediately, and signing in shows: "This account is blocked. Talk to your crew admin." |

Durations: 5 min, 15 min, 1 h, 3 h, 24 h, 3 days and 7 days. Moderators see only the options up to 24 h.

**Moderation log**
- Records who did what, to whom, the reason, when, and until when.
- Admins and moderators can see it.
- Kept for **90 days**, separately from message expiry, so parents can review incidents.

**Undo**
- Any timeout or mute can be lifted early by someone allowed to apply it.
- Lifting is logged too.

## 5. Rooms

### The Deck (text)
- Always exists, can't be deleted, and admins can rename it.
- Everyone can read and post unless timed out.
- The header says how long messages last: "Messages disappear after 3 days."

### Voice rooms
- **Two by default:** Gaming Loft and Quiet Nook.
- **Limit:** 3 voice rooms by default (`MAX_VOICE_ROOMS`), with a hard ceiling of 6.
- **At the limit,** the **New room** button is replaced by: "You have 3 rooms. Delete one to add another."
- **Deleting a room** works only while it's empty, or with **Move everyone to The Deck and delete**.
- **Rooms list:** shows when each room was last used, so old ones are easy to spot and remove.
- **Capacity:** each room holds up to 10 people by default, and admins can lower that per room.
- **Room chat:** each voice room has its own chat, visible only to people currently in the room. It's cleared when the last person leaves, and the message expiry limit applies on top of that.

## 6. Messages and expiry

- **Expiry:** messages in The Deck are deleted for good after the **message lifetime**, 3 days by default. Admins can set it from 1 to 7 days.
- **Room chat** is cleared when a room empties, and is capped by the same lifetime.
- **Cleanup:** a background job runs every 10 minutes and deletes expired messages in batches. Reactions are deleted with their message.
- **Nothing heavy is stored:**
  - GIFs are saved only as the GIPHY ID and preview link.
  - There are no file uploads in v1.
  - Emoji are just text.
- **Clients don't keep history.** They hold messages in memory only and drop anything past the lifetime.
- **Storage estimate:** 15 people, 3,000 messages a day, 7-day maximum, about 400 bytes each comes to roughly 10 MB. The database stays tiny with no upkeep.
- **Kept longer than messages:** the moderation log (90 days) and accounts.

### Chat features
- **@mentions:** friend autocomplete. A message that mentions you is highlighted, and The Deck shows an `@` badge in the sidebar.
- **#room links:** render as chips showing how many people are in voice. Clicking one previews the room with a Join button.
- **Slash commands:**
  - `/giphy words`: a GIF picker with Shuffle. Click to send, or Enter sends the first.
  - `/shrug message`
  - `/roll`: a number from 1 to 100.
  - `/me action`
- **GIFs** are fetched by the server, never by the clients directly. The rating filter is PG-13 and the admin can lower it to G. The API key stays on the server.
- **Emoji:** a picker, `:shortcode` autocomplete, and big display when a message is only emoji (up to 8).
- **Reactions:** add from the picker; click a chip to add or remove your own. They're limited to 20 different emoji per message.
- **Rate limit:** 5 messages per 5 seconds per person, and 10 GIFs per minute.

## 7. App screens

The screens are on the Treehouse canvas.

1. **Find your treehouse:** enter the server address. Treehouses used before are listed for one-tap return.
2. **Sign in:** a server chip with **Change**, and "Keep me signed in" (90 days).
   - **2b. Join with an invite:** a live preview tile, and a color choice.
3. **Two-step code:** six boxes, auto-submit, and backup codes as a fallback.
4. **The Deck and voice rooms:**
   - **Sidebar:** The Deck with a mention badge; voice rooms with who's in each; a "Voice connected" strip while in a call; your controls (Mute and Deafen) at the bottom.
   - **Stage:** tiles split the space evenly. One person fills it, two sit side by side, three or four make a 2 × 2 grid, and five or six make a 3 × 2 grid.
   - **Tiles:** the lantern glow shows who's talking, and each tile's name bar has an avatar plus mic and camera status. Your own name bar has working mic and camera buttons.
   - **Room chat** opens on the right.
5. **Settings:** profile, sound and hotkeys, security, invites (admins), and this computer. **This computer** has Sign out, Switch treehouse, and the list of signed-in devices.
6. **New for v0.3, still to be designed:**
   - A **Crew** settings tab for admins: people, roles, block, two-step reset.
   - A **Rooms** settings tab for admins.
   - The **moderation menu** and **reason dialog**.
   - The **moderation log**.
   - **Banners shown to the affected person:** timed out, moved out, blocked.

## 8. Look and feel

These are unchanged from 0.2. Summary:

- **Colors:**

  | Token | Hex |
  |---|---|
  | `night` | `#0E1322` |
  | `canopy` | `#121A2E` |
  | `surface` | `#182238` |
  | `moon` | `#ECEFF8` |
  | `mist` | `#A9B1CC` |
  | `lantern` | `#FFB347` |
  | `leaf` | `#63D69E` |
  | `ember` | `#FF8A7E` |

- **Fonts:** Bricolage Grotesque for headings and Atkinson Hyperlegible for text, both bundled with the app.
- **Animated treehouse** on the first screen: twinkling stars, a friend climbing the ladder, one electric window, one candle window, fireflies. It stays still when reduced motion is on.
- **Accessibility:**
  - Real buttons and inputs throughout, with a visible amber focus ring.
  - Labels on icon buttons.
  - Status shown by icon and text, never by color alone.
  - Targets at least 44 px.

## 9. Server

### 9.1 Stack

One small machine (1 vCPU, 1–2 GB RAM) running four containers:

| Container | Job |
|---|---|
| `treehouse` | Rust server: accounts, invites, roles, moderation, rooms, chat, presence, GIF search proxy. axum + tokio + sqlx. |
| `postgres` | Postgres 16. The only source of truth. |
| `livekit` | Voice and video forwarding, with built-in TURN relay. |
| `caddy` | HTTPS with automatic certificates. |

**Backups**
- A nightly `pg_dump`, kept for 7 days, takes a few MB.
- Restoring is a single command.

### 9.2 Built to be race-free

Every rule that matters is enforced inside Postgres. That way two clicks at the same moment, or two server processes, can never break it.

- **One action, one transaction.** Every change, such as using an invite, promoting someone, applying a timeout or deleting a room, is a single database transaction that both checks the rule and makes the change.
- **Constraints the database itself enforces:**
  - Usernames are unique regardless of case.
  - Each invite use is a single `UPDATE … WHERE uses < max_uses AND expires_at > now() RETURNING`, so an invite can never be used twice.
  - The Deck can't be deleted, enforced by a check constraint.
- **Invariants that span rows** are checked under `SELECT … FOR UPDATE` on the treehouse row:
  - The voice room limit.
  - Always at least one admin.
  - Room capacity.
- **No duplicate messages.** Each message carries a client-generated ID that's unique per author, so a retry after a dropped connection never posts twice.
- **Side effects after commit (outbox).** Moderation actions also write an `outbox` row in the same transaction. A worker then calls LiveKit (remove participant, mute track, change permissions) and retries until it succeeds. The database decision and the voice enforcement can never disagree for long.
- **Short voice tokens.** Voice tokens expire after 15 minutes and are renewed by the client. Renewal is refused while a timeout or block is active, as a second safety net.
- **One background job runner at a time.** Background jobs (message expiry, room chat clearing, outbox) take a Postgres advisory lock first. Running a second server copy is safe.
- **Realtime events in order.** Events go through Postgres `LISTEN/NOTIFY` and each carries a per-channel sequence number. After reconnecting, a client asks for "everything since #1234" and can't miss or double-apply an event.

### 9.3 API outline

JSON over HTTPS for actions, plus one WebSocket per client for live events.

| Area | Endpoints |
|---|---|
| Server | `GET /api/server-info` |
| Auth | `POST /api/login`, `/api/login/mfa`, `/api/join`, `/api/logout` |
| Me | `GET/PATCH /api/me`, `/api/me/password`, `/api/me/mfa/*`, `GET/DELETE /api/me/devices[/{id}]` |
| Rooms | `GET /api/rooms`, `POST /api/rooms` (admin), `PATCH/DELETE /api/rooms/{id}` (admin), `POST /api/rooms/{id}/voice-token` |
| Messages | `GET /api/channels/{id}/messages?since=`, `POST /api/channels/{id}/messages` (with `client_id`), `DELETE /api/messages/{id}`, `PUT/DELETE /api/messages/{id}/reactions/{emoji}` |
| GIFs | `GET /api/gifs?q=` (server proxy, rating filter, cached 10 min) |
| Invites | `GET/POST /api/invites`, `DELETE /api/invites/{code}` (admin) |
| People | `GET /api/people`, `PATCH /api/people/{id}/role` (admin), `POST /api/people/{id}/block` and `/unblock` (admin), `/reset-mfa` (admin) |
| Moderation | `POST /api/moderation` with `{target, action: mute|kick_room|timeout_voice|timeout_all, room?, duration?, reason}`, `DELETE /api/moderation/{id}` (lift), `GET /api/moderation/log` |
| Settings | `GET/PATCH /api/settings` (admin): name, message lifetime, room limit, GIF rating, who can invite |
| Live events | `WS /api/events`: presence, voice room occupancy, new, edited and deleted messages, reactions, moderation notices, room changes |

### 9.4 Data model

| Table | Main columns |
|---|---|
| `treehouse` | name, message_ttl_hours, max_voice_rooms, gif_rating, mods_can_invite, version |
| `users` | username (case-insensitive unique), display_name, color, password_hash, role, is_owner, blocked_at, blocked_reason |
| `mfa` | user_id, totp_secret, backup_code_hashes |
| `sessions` | token_hash, user_id, device_name, remember, expires_at, last_seen |
| `invites` | code_hash, role, max_uses, uses, expires_at, created_by |
| `rooms` | kind (deck, voice), name, slug, position, capacity, last_used_at |
| `messages` | channel_id, author_id, client_id, body or gif or roll or action, created_at, deleted_at. Indexed on created_at for expiry. |
| `reactions` | message_id, user_id, emoji, with primary key (message_id, user_id, emoji) |
| `sanctions` | target_id, kind, room_id, reason, by_id, starts_at, ends_at, lifted_by, lifted_at |
| `mod_log` | action, actor, target, reason, details, at (kept 90 days) |
| `outbox` | kind, payload, attempts, next_try_at, done_at |

## 10. Client

The client is kept deliberately simple.

- **App:** Tauri 2 for Windows and macOS. Linux is best effort.
- **What it holds:**
  - The device token, in the OS keychain.
  - One WebSocket for everything live.
  - LiveKit for voice and camera.
  - An in-memory message cache.
- **No local database, no business rules.** The server decides everything and the client renders it and handles input.
- **Voice quality is fixed:** echo, noise and gain processing; Opus 48 kbit/s with DTX and RED; no re-encoding.
- **Camera:** off by default, 720p at most, and lower automatically on weak connections.
- **Hotkeys:** Ctrl+M mute, Ctrl+D deafen.

## 11. Later

- Push to talk.
- A per-person volume slider.
- Quiet hours, so voice and posting close on school nights.
- Screen share.
- Phone apps from the same Tauri project.
- Image uploads, with their own short expiry.

## 12. Open questions

1. Should moderators be able to create invites if an admin turns it on, or should that stay admin-only for good?
2. Is a 3-day message lifetime right, or should The Deck default to 24 hours?
3. Should two-step sign-in be required for moderators as well as admins?
4. Should a timed-out person still be able to read The Deck, or see nothing until the timeout ends?

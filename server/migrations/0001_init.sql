-- Treehouse schema (spec §9.4). Forward-only: change it with new migrations
-- once a real server has run this one.

CREATE EXTENSION IF NOT EXISTS citext;

-- Rooms first: the treehouse row points at The Deck.
CREATE TABLE rooms (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         text NOT NULL CHECK (kind IN ('deck', 'voice')),
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    slug         citext NOT NULL UNIQUE,
    position     int NOT NULL DEFAULT 0,
    -- Voice rooms hold up to 10 people by default; The Deck has no capacity.
    capacity     int CHECK ((kind = 'deck' AND capacity IS NULL)
                         OR (kind = 'voice' AND capacity BETWEEN 2 AND 10)),
    last_used_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
-- Exactly one Deck.
CREATE UNIQUE INDEX rooms_one_deck ON rooms (kind) WHERE kind = 'deck';

INSERT INTO rooms (kind, name, slug, position, capacity) VALUES
    ('deck', 'The Deck', 'the-deck', 0, NULL),
    ('voice', 'Gaming Loft', 'gaming-loft', 1, 10),
    ('voice', 'Quiet Nook', 'quiet-nook', 2, 10);

-- The single treehouse row. Rules that span rows lock it: SELECT … FOR UPDATE.
CREATE TABLE treehouse (
    id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    name              text NOT NULL DEFAULT 'Treehouse' CHECK (char_length(name) BETWEEN 1 AND 40),
    message_ttl_hours int NOT NULL DEFAULT 72 CHECK (message_ttl_hours BETWEEN 24 AND 168),
    max_voice_rooms   int NOT NULL DEFAULT 3 CHECK (max_voice_rooms BETWEEN 1 AND 6),
    gif_rating        text NOT NULL DEFAULT 'pg-13' CHECK (gif_rating IN ('g', 'pg', 'pg-13')),
    mods_can_invite   boolean NOT NULL DEFAULT false,
    mods_require_mfa  boolean NOT NULL DEFAULT false,
    -- The Deck can't be deleted: this reference has no cascade.
    deck_room_id      bigint NOT NULL UNIQUE REFERENCES rooms (id) ON DELETE RESTRICT,
    version           bigint NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO treehouse (deck_room_id) SELECT id FROM rooms WHERE kind = 'deck';

CREATE TABLE users (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username       citext NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_.-]{2,24}$'),
    display_name   text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 32),
    color          text NOT NULL DEFAULT '#63D69E' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    password_hash  text NOT NULL,
    role           text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
    is_owner       boolean NOT NULL DEFAULT false,
    blocked_at     timestamptz,
    blocked_reason text,
    failed_logins  int NOT NULL DEFAULT 0,
    locked_until   timestamptz,                   -- too many wrong passwords
    invite_id      bigint,                        -- the invite they joined with
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (NOT is_owner OR role = 'admin')
);
CREATE UNIQUE INDEX users_one_owner ON users (is_owner) WHERE is_owner;

CREATE TABLE mfa (
    user_id            bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    totp_secret        text NOT NULL,
    backup_code_hashes bytea[] NOT NULL DEFAULT '{}',
    confirmed_at       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash  bytea NOT NULL UNIQUE,           -- SHA-256 of the device token
    user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_name text NOT NULL,
    remember    boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    last_seen   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Password accepted, waiting for the two-step code (5 minutes).
CREATE TABLE mfa_challenges (
    token_hash  bytea PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_name text NOT NULL,
    remember    boolean NOT NULL,
    attempts    int NOT NULL DEFAULT 0,
    expires_at  timestamptz NOT NULL
);

CREATE TABLE invites (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_hash  bytea NOT NULL UNIQUE,             -- SHA-256 of the invite code
    label      text CHECK (char_length(label) <= 40),  -- who it's for ("Kai"), shown in the invite list
    role       text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
    is_setup   boolean NOT NULL DEFAULT false,    -- first-boot invite: admin + owner
    max_uses   int NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 5),
    uses       int NOT NULL DEFAULT 0 CHECK (uses BETWEEN 0 AND max_uses),
    expires_at timestamptz NOT NULL,
    created_by bigint REFERENCES users (id) ON DELETE SET NULL,  -- NULL for the setup invite
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (NOT is_setup OR (role = 'admin' AND max_uses = 1))
);
ALTER TABLE users ADD FOREIGN KEY (invite_id) REFERENCES invites (id) ON DELETE SET NULL;

CREATE TABLE messages (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id bigint NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    author_id  bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    client_id  uuid NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('text', 'gif', 'roll', 'action')),
    body       text CHECK (char_length(body) <= 2000),
    gif        jsonb,
    roll       jsonb,
    mentions   bigint[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (author_id, client_id),
    CHECK ((kind IN ('text', 'action') AND body IS NOT NULL)
        OR (kind = 'gif' AND gif IS NOT NULL)
        OR (kind = 'roll' AND roll IS NOT NULL))
);
CREATE INDEX messages_created_at ON messages (created_at);   -- expiry
CREATE INDEX messages_channel ON messages (channel_id, id);

CREATE TABLE reactions (
    message_id bigint NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE sanctions (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind      text NOT NULL CHECK (kind IN ('mute', 'kick_room', 'timeout_voice', 'timeout_all')),
    room_id   bigint REFERENCES rooms (id) ON DELETE SET NULL,
    reason    text,
    by_id     bigint REFERENCES users (id) ON DELETE SET NULL,
    starts_at timestamptz NOT NULL DEFAULT now(),
    ends_at   timestamptz NOT NULL,
    lifted_by bigint REFERENCES users (id) ON DELETE SET NULL,
    lifted_at timestamptz,
    CHECK (ends_at > starts_at)
);
CREATE INDEX sanctions_active ON sanctions (target_id, ends_at) WHERE lifted_at IS NULL;

-- Kept 90 days, separately from messages. Names are copied so entries
-- stay readable after an account is gone.
CREATE TABLE mod_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action      text NOT NULL,
    actor_id    bigint REFERENCES users (id) ON DELETE SET NULL,
    actor_name  text NOT NULL,
    target_id   bigint REFERENCES users (id) ON DELETE SET NULL,
    target_name text,
    reason      text,
    details     jsonb NOT NULL DEFAULT '{}',
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mod_log_at ON mod_log (at);

-- Side effects after commit (LiveKit calls), run by the worker with retries.
CREATE TABLE outbox (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        text NOT NULL,
    payload     jsonb NOT NULL,
    attempts    int NOT NULL DEFAULT 0,
    last_error  text,
    next_try_at timestamptz NOT NULL DEFAULT now(),
    done_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due ON outbox (next_try_at) WHERE done_at IS NULL;

-- Who is in which voice room. Written from LiveKit webhooks (milestone 7).
CREATE TABLE voice_members (
    room_id   bigint NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id   bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    muted     boolean NOT NULL DEFAULT false,
    camera    boolean NOT NULL DEFAULT false,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id)                          -- one voice room at a time
);
CREATE INDEX voice_members_room ON voice_members (room_id);

-- Live events, numbered per channel. Written in the same transaction as the
-- change, then NOTIFY 'events' (delivered on commit). Clients resume with since.
CREATE TABLE channel_seq (
    channel text PRIMARY KEY,
    seq     bigint NOT NULL
);
CREATE TABLE events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel    text NOT NULL,
    seq        bigint NOT NULL,
    kind       text NOT NULL,
    payload    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel, seq)
);
CREATE INDEX events_created_at ON events (created_at);

-- Open WebSocket connections, for presence. Rows of a crashed replica go stale
-- (no heartbeat) and are swept by the cleanup job.
CREATE TABLE connections (
    id        uuid PRIMARY KEY,
    user_id   bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    last_ping timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connections_user ON connections (user_id);

-- One JSON shape for a message, used by the API and by live events.
CREATE FUNCTION reactions_json(mid bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('emoji', r.emoji, 'user_ids', r.user_ids) ORDER BY r.first), '[]'::jsonb)
    FROM (SELECT emoji, array_agg(user_id ORDER BY created_at) AS user_ids, min(created_at) AS first
          FROM reactions WHERE message_id = mid GROUP BY emoji) r
$$;

CREATE FUNCTION message_json(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'id', m.id, 'channel_id', m.channel_id, 'author_id', m.author_id, 'client_id', m.client_id,
        'kind', m.kind, 'body', m.body, 'gif', m.gif, 'roll', m.roll, 'mentions', to_jsonb(m.mentions),
        'created_at', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'reactions', reactions_json(m.id))
$$;

-- Voice rooms with who is in them.
CREATE FUNCTION rooms_json() RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'name', r.name, 'slug', r.slug::text, 'capacity', r.capacity,
        'members', COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', v.user_id, 'muted', v.muted, 'camera', v.camera) ORDER BY v.joined_at)
                             FROM voice_members v WHERE v.room_id = r.id), '[]'::jsonb)
    ) ORDER BY r.position, r.id), '[]'::jsonb)
    FROM rooms r
$$;

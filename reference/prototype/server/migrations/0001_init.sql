CREATE TABLE users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name    TEXT NOT NULL,
    color           TEXT NOT NULL DEFAULT '#3F8EFC',
    password_hash   TEXT NOT NULL,
    totp_secret     TEXT,              -- base32, set once MFA is enabled
    totp_pending    TEXT,              -- base32, during setup only
    is_admin        INTEGER NOT NULL DEFAULT 0,
    disabled        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);

CREATE TABLE invites (
    code        TEXT PRIMARY KEY,
    note        TEXT NOT NULL DEFAULT '',
    make_admin  INTEGER NOT NULL DEFAULT 0,
    created_by  INTEGER REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_by     INTEGER REFERENCES users(id),
    used_at     INTEGER
);

-- Browser sessions for the web portal. Only a hash of the cookie value is stored.
CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mfa_ok      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);

-- Desktop apps. Each paired device has its own long-lived, revocable token.
CREATE TABLE devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
);

-- Short pairing codes shown in the web portal and typed into the app.
CREATE TABLE pair_codes (
    code_hash   TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL
);

-- Failed login tracking for simple lockout.
CREATE TABLE login_failures (
    username    TEXT NOT NULL COLLATE NOCASE,
    at          INTEGER NOT NULL
);
CREATE INDEX login_failures_user ON login_failures(username, at);

-- Profile pictures, kept in Postgres. The server re-encodes every upload to a
-- 256×256 JPEG (which also drops EXIF data such as GPS), so rows stay small.
CREATE TABLE avatars (
    user_id    bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    image      bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 100000),
    version    int NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);

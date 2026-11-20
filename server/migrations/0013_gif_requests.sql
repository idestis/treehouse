-- One row per GIF search or GIF send, to hold the 10-per-minute limit (spec §4)
-- in Postgres so it applies across server copies. A user's old rows are pruned
-- whenever that user makes the next request.
CREATE TABLE gif_requests (
    user_id bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gif_requests_user_at ON gif_requests (user_id, at);

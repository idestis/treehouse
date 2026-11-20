-- Voice (milestone 7): screen sharing flag, LiveKit session ids, and
-- tombstones so repeated or out-of-order webhooks can't bring back a
-- participant who already left.

-- Flags are reported by the client (LiveKit webhooks don't carry mute toggles).
ALTER TABLE voice_members ADD COLUMN screen boolean NOT NULL DEFAULT false;
-- LiveKit participant sid of the session that put this row here. A
-- participant_left for another (older) sid leaves the row alone.
ALTER TABLE voice_members ADD COLUMN lk_sid text;

-- Sessions that already left. A participant_joined for one of these arrived
-- late and is ignored. Swept by the cleanup job after a day.
CREATE TABLE voice_left (
    lk_sid  text PRIMARY KEY,
    left_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_left_at ON voice_left (left_at);

-- One JSON shape for who is in a voice room, used by rooms_json() and the
-- "voice" live event.
CREATE FUNCTION voice_members_json(rid bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'user_id', v.user_id, 'muted', v.muted, 'camera', v.camera, 'screen', v.screen)
        ORDER BY v.joined_at, v.user_id), '[]'::jsonb)
    FROM voice_members v WHERE v.room_id = rid
$$;

CREATE OR REPLACE FUNCTION rooms_json() RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'name', r.name, 'slug', r.slug::text, 'capacity', r.capacity,
        'members', voice_members_json(r.id)
    ) ORDER BY r.position, r.id), '[]'::jsonb)
    FROM rooms r
$$;

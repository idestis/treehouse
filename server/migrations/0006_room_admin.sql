-- Rooms list shows when each room was last used (spec §5), so old ones are easy to spot.
CREATE OR REPLACE FUNCTION rooms_json() RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'name', r.name, 'slug', r.slug::text, 'capacity', r.capacity,
        'last_used_at', to_char(r.last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'members', voice_members_json(r.id)
    ) ORDER BY r.position, r.id), '[]'::jsonb)
    FROM rooms r
$$;

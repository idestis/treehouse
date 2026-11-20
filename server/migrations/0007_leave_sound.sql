-- A sound others hear when you leave a voice room, and a bigger sound list
-- that join and leave share (the app ships the files).
ALTER TABLE users DROP CONSTRAINT users_join_sound_check;
ALTER TABLE users ADD CONSTRAINT users_join_sound_check
    CHECK (join_sound IN ('ding', 'fart', 'quack', 'hewya', 'yeah-boy', 'female-bye', 'kiddo-bye', 'mmbye', 'none'));
ALTER TABLE users ADD COLUMN leave_sound text NOT NULL DEFAULT 'mmbye'
    CHECK (leave_sound IN ('ding', 'fart', 'quack', 'hewya', 'yeah-boy', 'female-bye', 'kiddo-bye', 'mmbye', 'none'));

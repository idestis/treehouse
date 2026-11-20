-- The sound others in a voice room hear when you join (the app ships the files).
ALTER TABLE users ADD COLUMN join_sound text NOT NULL DEFAULT 'ding'
    CHECK (join_sound IN ('ding', 'fart', 'quack', 'hewya', 'none'));

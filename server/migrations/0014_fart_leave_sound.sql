-- Fart works as a goodbye too.
ALTER TABLE users DROP CONSTRAINT users_leave_sound_check;
ALTER TABLE users ADD CONSTRAINT users_leave_sound_check
    CHECK (leave_sound IN ('female-bye', 'kiddo-bye', 'mmbye', 'fart', 'none'));

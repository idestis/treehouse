-- Join and leave sounds are separate lists: greetings to come in, goodbyes to go.
UPDATE users SET join_sound = 'ding' WHERE join_sound IN ('female-bye', 'kiddo-bye', 'mmbye');
UPDATE users SET leave_sound = 'mmbye' WHERE leave_sound NOT IN ('female-bye', 'kiddo-bye', 'mmbye', 'none');
ALTER TABLE users DROP CONSTRAINT users_join_sound_check;
ALTER TABLE users ADD CONSTRAINT users_join_sound_check
    CHECK (join_sound IN ('ding', 'doink', 'fart', 'quack', 'hewya', 'yeah-boy', 'none'));
ALTER TABLE users DROP CONSTRAINT users_leave_sound_check;
ALTER TABLE users ADD CONSTRAINT users_leave_sound_check
    CHECK (leave_sound IN ('female-bye', 'kiddo-bye', 'mmbye', 'none'));

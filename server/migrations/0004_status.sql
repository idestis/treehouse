-- Presence people choose (online, away, busy = do not disturb, brb) plus an
-- optional custom status ("🎮 In a game"). Being connected is separate:
-- offline still wins when nobody is connected.
ALTER TABLE users
    ADD COLUMN status text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'away', 'busy', 'brb')),
    ADD COLUMN status_emoji text CHECK (char_length(status_emoji) BETWEEN 1 AND 16),
    ADD COLUMN status_text text CHECK (char_length(status_text) BETWEEN 1 AND 60);

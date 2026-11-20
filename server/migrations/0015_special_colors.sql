-- People can pick any hex color or one of the named gradients.
ALTER TABLE users DROP CONSTRAINT users_color_check;
ALTER TABLE users ADD CONSTRAINT users_color_check
    CHECK (color ~ '^#[0-9A-Fa-f]{6}$' OR color IN ('rainbow', 'sunset', 'ocean', 'aurora'));

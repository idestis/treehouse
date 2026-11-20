-- Wrong two-step codes counted per account, across sign-in attempts. A correct
-- password never clears it; only a correct code does (or reaching the limit,
-- which sets users.locked_until and starts over).
ALTER TABLE users ADD COLUMN failed_mfa int NOT NULL DEFAULT 0;

-- The newest TOTP time step (unix time / 30) accepted for sign-in, so the same
-- code can't be used twice inside its window.
ALTER TABLE mfa ADD COLUMN last_totp_step bigint;

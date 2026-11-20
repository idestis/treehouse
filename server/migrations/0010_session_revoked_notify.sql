-- Open WebSockets authenticate once, at hello. These triggers tell every
-- replica when that identity stops being valid, so the socket is told
-- `signed_out` and closed. NOTIFY is delivered on commit, so a rolled-back
-- delete or block never closes anything.

CREATE FUNCTION notify_session_revoked() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('session_revoked', OLD.id::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Logout, password change, device sign-out, CLI resets, the expiry job and
-- user deletion (ON DELETE CASCADE) all end here.
CREATE TRIGGER sessions_notify_revoked
    AFTER DELETE ON sessions
    FOR EACH ROW EXECUTE FUNCTION notify_session_revoked();

CREATE FUNCTION notify_user_blocked() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('user_blocked', NEW.id::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_notify_blocked
    AFTER UPDATE OF blocked_at ON users
    FOR EACH ROW
    WHEN (OLD.blocked_at IS NULL AND NEW.blocked_at IS NOT NULL)
    EXECUTE FUNCTION notify_user_blocked();

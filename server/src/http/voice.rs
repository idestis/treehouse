//! Voice: tokens for LiveKit, the app's own mute/camera/screen flags, and
//! LiveKit webhooks that say who is in which room.
//!
//! Every change to `voice_members` locks the treehouse row first, so the
//! capacity check and the "voice" snapshots it emits are serialized: a later
//! seq on the `treehouse` channel always carries the newer member list.
//! Nothing here calls LiveKit; signing a token is local.

use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    auth::Authed,
    error::{AppError, AppResult},
    events,
    http::AppState,
    livekit::{self, WebhookEvent},
};

fn voice_off() -> AppError {
    AppError::unavailable("voice_off", "Voice isn't set up on this server yet.")
}

/// Lock the treehouse row: serializes every voice change (see module docs).
async fn lock(conn: &mut PgConnection) -> AppResult<()> {
    sqlx::query!("SELECT id FROM treehouse FOR UPDATE")
        .fetch_one(conn)
        .await?;
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct TokenQuery {
    /// A hidden, watch-only token for the desktop overlay window.
    overlay: bool,
}

/// `POST /api/rooms/{id}/voice-token`: join or refresh. Refused while timed
/// out or when the room is full.
///
/// `?overlay=true` asks for the desktop overlay's token instead (people on
/// top while you share): only while you're in the room, it can't publish,
/// LiveKit hides it, and it neither counts toward capacity nor marks the
/// room as used.
pub async fn voice_token(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Query(q): Query<TokenQuery>,
) -> AppResult<Json<Value>> {
    let mut tx = st.db.begin().await?;
    // The overlay token only reads, so it doesn't need the voice lock.
    if !q.overlay {
        lock(&mut tx).await?;
    }
    let room = sqlx::query!("SELECT kind, name, capacity FROM rooms WHERE id = $1", id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::not_found("That room is gone."))?;
    if room.kind != "voice" {
        return Err(AppError::bad("not_voice", "That isn't a voice room."));
    }
    let lk = st.cfg.livekit.as_ref().ok_or_else(voice_off)?;

    let until = sqlx::query_scalar!(
        "SELECT max(ends_at) FROM sanctions
         WHERE target_id = $1 AND kind IN ('timeout_voice', 'timeout_all')
           AND lifted_at IS NULL AND ends_at > now()",
        user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    if let Some(until) = until {
        return Err(AppError::forbidden(
            "timed_out",
            format!(
                "You're timed out from voice until {}.",
                until_text(until, OffsetDateTime::now_utc())
            ),
        ));
    }

    if q.overlay {
        sqlx::query!(
            "SELECT muted, camera, screen FROM voice_members WHERE user_id = $1 AND room_id = $2",
            user.id,
            id
        )
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::conflict("not_in_room", "Join the room first."))?;
        tx.commit().await?;
        let (token, expires_at) = livekit::overlay_token(
            lk,
            user.id,
            &user.display_name,
            id,
            OffsetDateTime::now_utc(),
        )?;
        return Ok(Json(json!({
            "url": lk.url,
            "token": token,
            "expires_at": expires_at.format(&Rfc3339)?,
            "livekit_room": livekit::room_name(id),
            "identity": livekit::overlay_identity(user.id),
        })));
    }

    let others = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM voice_members WHERE room_id = $1 AND user_id <> $2"#,
        id,
        user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    if others >= i64::from(room.capacity.unwrap_or(10)) {
        return Err(AppError::conflict(
            "room_full",
            format!("{} is full. Try another room.", room.name),
        ));
    }
    sqlx::query!("UPDATE rooms SET last_used_at = now() WHERE id = $1", id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let (token, expires_at) = livekit::voice_token(
        lk,
        user.id,
        &user.display_name,
        id,
        OffsetDateTime::now_utc(),
    )?;
    Ok(Json(json!({
        "url": lk.url,
        "token": token,
        "expires_at": expires_at.format(&Rfc3339)?,
        "livekit_room": livekit::room_name(id),
        "identity": user.id.to_string(),
    })))
}

/// "21:30 UTC" today, "November 22, 21:30 UTC" further out. The server
/// doesn't know the person's time zone.
fn until_text(until: OffsetDateTime, now: OffsetDateTime) -> String {
    let t = until.to_offset(time::UtcOffset::UTC);
    let hm = format!("{:02}:{:02} UTC", t.hour(), t.minute());
    if t.date() == now.to_offset(time::UtcOffset::UTC).date() {
        hm
    } else {
        format!("{} {}, {hm}", t.month(), t.day())
    }
}

#[derive(Deserialize)]
pub struct VoiceStateIn {
    muted: bool,
    camera: bool,
    screen: bool,
}

/// `POST /api/rooms/{id}/voice-state`: the app reports its own mic, camera
/// and screen share (LiveKit webhooks don't carry mute toggles).
pub async fn voice_state(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(inp): Json<VoiceStateIn>,
) -> AppResult<StatusCode> {
    let mut tx = st.db.begin().await?;
    lock(&mut tx).await?;
    let row = sqlx::query!(
        "SELECT muted, camera, screen FROM voice_members WHERE user_id = $1 AND room_id = $2",
        user.id,
        id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::conflict("not_in_room", "You're not in that room. Join it first."))?;
    if (row.muted, row.camera, row.screen) != (inp.muted, inp.camera, inp.screen) {
        sqlx::query!(
            "UPDATE voice_members SET muted = $3, camera = $4, screen = $5 WHERE user_id = $1 AND room_id = $2",
            user.id,
            id,
            inp.muted,
            inp.camera,
            inp.screen
        )
        .execute(&mut *tx)
        .await?;
        emit_voice(&mut tx, id).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `voice` on the treehouse channel: who is in this room now.
async fn emit_voice(conn: &mut PgConnection, room_id: i64) -> AppResult<()> {
    let members = sqlx::query_scalar!(r#"SELECT voice_members_json($1) AS "m!""#, room_id)
        .fetch_one(&mut *conn)
        .await?;
    events::emit(
        conn,
        events::TREEHOUSE,
        "voice",
        json!({ "room_id": room_id, "members": members }),
    )
    .await
}

/// After someone left `room_id`: tell everyone, and clear the room's chat
/// if nobody is left (spec §5).
async fn after_leave(conn: &mut PgConnection, room_id: i64) -> AppResult<()> {
    emit_voice(conn, room_id).await?;
    clear_chat_if_empty(conn, room_id).await
}

async fn clear_chat_if_empty(conn: &mut PgConnection, room_id: i64) -> AppResult<()> {
    sqlx::query!(
        "DELETE FROM messages WHERE channel_id = $1
           AND EXISTS (SELECT 1 FROM rooms WHERE id = $1 AND kind = 'voice')
           AND NOT EXISTS (SELECT 1 FROM voice_members WHERE room_id = $1)",
        room_id
    )
    .execute(conn)
    .await?;
    Ok(())
}

/// `POST /api/livekit/webhook`: signed by LiveKit with our API secret.
/// Webhooks can repeat or arrive out of order, so every handler is
/// idempotent and keyed on the participant sid.
pub async fn webhook(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<StatusCode> {
    let lk = st.cfg.livekit.as_ref().ok_or_else(voice_off)?;
    let auth = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok());
    let now = OffsetDateTime::now_utc().unix_timestamp();
    if !livekit::verify_webhook(lk, auth, &body, now) {
        return Err(AppError::unauthorized(
            "bad_signature",
            "That webhook isn't signed by this server's LiveKit.",
        ));
    }
    let ev: WebhookEvent = serde_json::from_slice(&body)
        .map_err(|_| AppError::bad("bad_webhook", "That webhook isn't valid JSON."))?;
    let action = webhook_action(&ev);
    tracing::debug!(event = %ev.event, ?action, "livekit webhook");
    if action == Action::Ignore {
        return Ok(StatusCode::OK);
    }

    let mut tx = st.db.begin().await?;
    lock(&mut tx).await?;
    match action {
        Action::Joined { room, user, sid } => joined(&mut tx, room, user, sid).await?,
        Action::Left { room, user, sid } => left(&mut tx, room, user, sid).await?,
        Action::Finished { room } => finished(&mut tx, room).await?,
        Action::Ignore => {}
    }
    tx.commit().await?;
    Ok(StatusCode::OK)
}

/// What a webhook means for `voice_members`.
#[derive(Debug, PartialEq, Eq)]
enum Action<'a> {
    Joined { room: i64, user: i64, sid: &'a str },
    Left { room: i64, user: i64, sid: &'a str },
    Finished { room: i64 },
    Ignore,
}

/// Only people's own voice connections (identity = user id) count; the
/// hidden overlay (`<id>-overlay`) and anything else LiveKit reports are
/// ignored, so they never add members or events.
fn webhook_action(ev: &WebhookEvent) -> Action<'_> {
    let Some(room) = ev.room.as_ref().and_then(|r| livekit::room_id(&r.name)) else {
        return Action::Ignore;
    };
    let person = ev
        .participant
        .as_ref()
        .and_then(|p| Some((livekit::user_identity(&p.identity)?, p.sid.as_str())));
    match (ev.event.as_str(), person) {
        ("participant_joined", Some((user, sid))) => Action::Joined { room, user, sid },
        ("participant_left" | "participant_connection_aborted", Some((user, sid))) => {
            Action::Left { room, user, sid }
        }
        ("room_finished", _) => Action::Finished { room },
        _ => Action::Ignore,
    }
}

/// Queue removal of the hidden overlay connection for `user` from `room`
/// (same transaction as the membership change; the outbox worker calls LiveKit).
async fn drop_overlay(conn: &mut PgConnection, room: i64, user: i64) -> AppResult<()> {
    let payload = livekit::remove_participant_payload(room, &livekit::overlay_identity(user));
    sqlx::query!(
        "INSERT INTO outbox (kind, payload) VALUES ('remove_participant', $1)",
        payload
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn joined(conn: &mut PgConnection, room: i64, user: i64, sid: &str) -> AppResult<()> {
    // That session already left: this join arrived late.
    if !sid.is_empty()
        && sqlx::query_scalar!(
            r#"SELECT EXISTS (SELECT 1 FROM voice_left WHERE lk_sid = $1) AS "e!""#,
            sid
        )
        .fetch_one(&mut *conn)
        .await?
    {
        return Ok(());
    }
    let ok = sqlx::query_scalar!(
        r#"SELECT (EXISTS (SELECT 1 FROM rooms WHERE id = $1 AND kind = 'voice')
               AND EXISTS (SELECT 1 FROM users WHERE id = $2 AND blocked_at IS NULL)) AS "ok!""#,
        room,
        user
    )
    .fetch_one(&mut *conn)
    .await?;
    if !ok {
        tracing::warn!(
            room,
            user,
            "livekit join for an unknown room or person, ignored"
        );
        return Ok(());
    }
    let sid = (!sid.is_empty()).then_some(sid);
    let prev = sqlx::query!(
        "SELECT room_id, lk_sid FROM voice_members WHERE user_id = $1",
        user
    )
    .fetch_optional(&mut *conn)
    .await?;
    match prev {
        // A repeat, or a reconnect in the same room: membership is unchanged.
        Some(p) if p.room_id == room => {
            if sid.is_some() && p.lk_sid.as_deref() != sid {
                sqlx::query!(
                    "UPDATE voice_members SET lk_sid = $2 WHERE user_id = $1",
                    user,
                    sid
                )
                .execute(&mut *conn)
                .await?;
            }
        }
        // Moved rooms (one room at a time): the old room may now be empty.
        Some(p) => {
            sqlx::query!(
                "UPDATE voice_members
                 SET room_id = $2, lk_sid = $3, muted = false, camera = false, screen = false, joined_at = now()
                 WHERE user_id = $1",
                user,
                room,
                sid
            )
            .execute(&mut *conn)
            .await?;
            drop_overlay(conn, p.room_id, user).await?;
            after_leave(conn, p.room_id).await?;
            emit_voice(conn, room).await?;
        }
        None => {
            sqlx::query!(
                "INSERT INTO voice_members (room_id, user_id, lk_sid) VALUES ($1, $2, $3)",
                room,
                user,
                sid
            )
            .execute(&mut *conn)
            .await?;
            emit_voice(conn, room).await?;
        }
    }
    Ok(())
}

async fn left(conn: &mut PgConnection, room: i64, user: i64, sid: &str) -> AppResult<()> {
    if !sid.is_empty() {
        sqlx::query!(
            "INSERT INTO voice_left (lk_sid) VALUES ($1) ON CONFLICT DO NOTHING",
            sid
        )
        .execute(&mut *conn)
        .await?;
    }
    // Only the session that is in the row: a late "left" for an older
    // session must not remove someone who has since rejoined.
    let gone = sqlx::query!(
        "DELETE FROM voice_members
         WHERE user_id = $1 AND room_id = $2 AND ($3 = '' OR lk_sid IS NULL OR lk_sid = $3)",
        user,
        room,
        sid
    )
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if gone > 0 {
        drop_overlay(conn, room, user).await?;
        after_leave(conn, room).await?;
    }
    Ok(())
}

async fn finished(conn: &mut PgConnection, room: i64) -> AppResult<()> {
    let sids = sqlx::query_scalar!(
        "DELETE FROM voice_members WHERE room_id = $1 RETURNING lk_sid",
        room
    )
    .fetch_all(&mut *conn)
    .await?;
    if sids.is_empty() {
        // Already empty (a repeat, or everyone's "left" came first).
        return clear_chat_if_empty(conn, room).await;
    }
    let sids: Vec<String> = sids.into_iter().flatten().collect();
    sqlx::query!(
        "INSERT INTO voice_left (lk_sid) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING",
        &sids
    )
    .execute(&mut *conn)
    .await?;
    after_leave(conn, room).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn until_copy() {
        let now = time::Date::from_calendar_date(2026, time::Month::November, 18)
            .unwrap()
            .with_hms(8, 26, 0)
            .unwrap()
            .assume_utc();
        let later = now + time::Duration::hours(2);
        assert_eq!(until_text(later, now), "10:26 UTC");
        let days = now + time::Duration::days(3);
        assert_eq!(until_text(days, now), "November 21, 08:26 UTC");
    }

    fn event(json: &str) -> WebhookEvent {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn webhooks_for_people() {
        let e = event(
            r#"{"event":"participant_joined","room":{"name":"room-2"},"participant":{"sid":"PA_1","identity":"3"}}"#,
        );
        assert_eq!(
            webhook_action(&e),
            Action::Joined {
                room: 2,
                user: 3,
                sid: "PA_1"
            }
        );
        for ev in ["participant_left", "participant_connection_aborted"] {
            let e = event(&format!(
                r#"{{"event":"{ev}","room":{{"name":"room-2"}},"participant":{{"sid":"PA_1","identity":"3"}}}}"#
            ));
            assert_eq!(
                webhook_action(&e),
                Action::Left {
                    room: 2,
                    user: 3,
                    sid: "PA_1"
                }
            );
        }
        let e = event(r#"{"event":"room_finished","room":{"name":"room-2"}}"#);
        assert_eq!(webhook_action(&e), Action::Finished { room: 2 });
    }

    #[test]
    fn webhooks_for_overlays_are_ignored() {
        for ev in [
            "participant_joined",
            "participant_left",
            "participant_connection_aborted",
        ] {
            for identity in ["3-overlay", "treehouse-server", "", "-3"] {
                let e = event(&format!(
                    r#"{{"event":"{ev}","room":{{"name":"room-2"}},"participant":{{"sid":"PA_9","identity":"{identity}"}}}}"#
                ));
                assert_eq!(webhook_action(&e), Action::Ignore, "{ev} {identity}");
            }
        }
        // Not one of our rooms.
        let e = event(
            r#"{"event":"participant_joined","room":{"name":"lobby"},"participant":{"sid":"PA_1","identity":"3"}}"#,
        );
        assert_eq!(webhook_action(&e), Action::Ignore);
    }
}

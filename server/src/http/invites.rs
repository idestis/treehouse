//! Invites: list, create, cancel.

use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    auth::{Authed, User},
    error::{AppError, AppResult},
    http::AppState,
    perms::{self, Role},
    util,
};

const HOURS: [i32; 4] = [1, 24, 72, 168];

async fn allowed(st: &AppState, user: &User) -> AppResult<()> {
    let mods_can_invite = sqlx::query_scalar!("SELECT mods_can_invite FROM treehouse")
        .fetch_one(&st.db)
        .await?;
    perms::can_manage_invites(user.actor(), mods_can_invite)?;
    Ok(())
}

pub async fn list(State(st): State<AppState>, Authed(user): Authed) -> AppResult<Json<Value>> {
    allowed(&st, &user).await?;
    let list = sqlx::query_scalar!(
        r#"SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', i.id, 'label', i.label, 'role', i.role, 'max_uses', i.max_uses, 'uses', i.uses,
               'expires_at', to_char(i.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'joined', COALESCE((SELECT jsonb_agg(u.display_name ORDER BY u.created_at) FROM users u WHERE u.invite_id = i.id), '[]'::jsonb)
           ) ORDER BY i.created_at DESC), '[]'::jsonb) AS "list!"
           FROM invites i WHERE NOT i.is_setup AND i.created_at > now() - interval '30 days'"#
    )
    .fetch_one(&st.db)
    .await?;
    Ok(Json(list))
}

#[derive(Deserialize)]
pub struct CreateIn {
    #[serde(default)]
    label: String,
    role: Role,
    max_uses: i32,
    hours: i32,
}

pub async fn create(
    State(st): State<AppState>,
    Authed(user): Authed,
    Json(inp): Json<CreateIn>,
) -> AppResult<Json<Value>> {
    allowed(&st, &user).await?;
    perms::can_invite_as(user.actor(), inp.role)?;
    if !HOURS.contains(&inp.hours) {
        return Err(AppError::bad(
            "bad_expiry",
            "Invites last 1 hour, 1 day, 3 days or 7 days.",
        ));
    }
    if !(1..=5).contains(&inp.max_uses) {
        return Err(AppError::bad(
            "bad_uses",
            "An invite works for 1 to 5 people.",
        ));
    }
    let label: String = inp.label.trim().chars().take(40).collect();
    let code = util::invite_code();
    let id = sqlx::query_scalar!(
        "INSERT INTO invites (code_hash, label, role, max_uses, expires_at, created_by)
         VALUES ($1, NULLIF($2, ''), $3, $4, now() + make_interval(hours => $5), $6) RETURNING id",
        util::sha256(&code),
        label,
        inp.role.as_str(),
        inp.max_uses,
        inp.hours,
        user.id
    )
    .fetch_one(&st.db)
    .await?;
    let expires_at = sqlx::query_scalar!(
        r#"SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "e!" FROM invites WHERE id = $1"#,
        id
    )
    .fetch_one(&st.db)
    .await?;
    Ok(Json(json!({
        "id": id, "label": if label.is_empty() { Value::Null } else { Value::String(label) },
        "role": inp.role, "max_uses": inp.max_uses, "uses": 0, "joined": [], "expires_at": expires_at,
        "code": code, "link": join_link(&st.cfg.public_url, &code),
    })))
}

pub fn join_link(public_url: &str, code: &str) -> String {
    format!("{public_url}/join?code={code}")
}

/// Cancel a waiting invite (it simply stops working).
pub async fn cancel(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    allowed(&st, &user).await?;
    let done = sqlx::query!(
        "UPDATE invites SET expires_at = least(expires_at, now()) WHERE id = $1 AND NOT is_setup AND uses < max_uses",
        id
    )
    .execute(&st.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::not_found(
            "invite_gone",
            "That invite was already used or cancelled.",
        ));
    }
    Ok(Json(json!({})))
}

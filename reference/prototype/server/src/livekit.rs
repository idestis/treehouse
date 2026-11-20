//! LiveKit: signing access tokens (HS256 JWTs) and asking the server who is
//! in each room. Token format: https://docs.livekit.io/home/get-started/authentication/

use std::time::Duration;

use jsonwebtoken::{encode, EncodingKey, Header};
use serde::{Deserialize, Serialize};

use crate::auth::User;
use crate::util::now;
use crate::{Config, RoomDef};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct VideoGrant {
    room: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_join: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_admin: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    can_subscribe: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    can_publish: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    can_publish_data: bool,
    /// Lets the app set its own attributes (used for "deafened").
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    can_update_own_metadata: bool,
    /// Voice only for now. Add "camera" and "screen_share" here for video.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    can_publish_sources: Vec<String>,
}

#[derive(Serialize)]
struct Claims {
    iss: String,
    sub: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    metadata: String,
    nbf: i64,
    exp: i64,
    video: VideoGrant,
}

fn sign(config: &Config, claims: &Claims) -> anyhow::Result<String> {
    Ok(encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(config.livekit_api_secret.as_bytes()),
    )?)
}

pub fn voice_token(config: &Config, user: &User, room: &RoomDef) -> anyhow::Result<String> {
    sign(
        config,
        &Claims {
            iss: config.livekit_api_key.clone(),
            sub: user.username.clone(),
            name: user.display_name.clone(),
            // Everyone in the room sees this, so tiles get the right color.
            metadata: serde_json::json!({ "color": user.color }).to_string(),
            nbf: now() - 10,
            exp: now() + 6 * 3600,
            video: VideoGrant {
                room: room.id.clone(),
                room_join: true,
                can_subscribe: true,
                can_publish: true,
                can_publish_data: true,
                can_update_own_metadata: true,
                can_publish_sources: vec!["microphone".into()],
                ..Default::default()
            },
        },
    )
}

fn admin_token(config: &Config, room: &str) -> anyhow::Result<String> {
    sign(
        config,
        &Claims {
            iss: config.livekit_api_key.clone(),
            sub: "treehouse-server".into(),
            name: String::new(),
            metadata: String::new(),
            nbf: now() - 10,
            exp: now() + 60,
            video: VideoGrant { room: room.into(), room_admin: true, ..Default::default() },
        },
    )
}

#[derive(Serialize, Clone)]
pub struct Occupant {
    pub username: String,
    pub name: String,
    pub color: String,
    pub muted: bool,
}

#[derive(Deserialize)]
struct ListReply {
    #[serde(default)]
    participants: Vec<LkParticipant>,
}

#[derive(Deserialize)]
struct LkParticipant {
    #[serde(default)]
    identity: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    metadata: String,
    #[serde(default)]
    tracks: Vec<LkTrack>,
}

#[derive(Deserialize)]
struct LkTrack {
    #[serde(default)]
    muted: bool,
}

/// Who is in a room right now. An empty or not-yet-created room is just `[]`.
pub async fn occupants(config: &Config, http: &reqwest::Client, room: &str) -> Vec<Occupant> {
    let result = async {
        let resp = http
            .post(format!(
                "{}/twirp/livekit.RoomService/ListParticipants",
                config.livekit_api_url.trim_end_matches('/')
            ))
            .bearer_auth(admin_token(config, room)?)
            .timeout(Duration::from_secs(3))
            .json(&serde_json::json!({ "room": room }))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(vec![]);
        }
        let reply: ListReply = resp.error_for_status()?.json().await?;
        Ok::<_, anyhow::Error>(
            reply
                .participants
                .into_iter()
                .map(|p| {
                    let color = serde_json::from_str::<serde_json::Value>(&p.metadata)
                        .ok()
                        .and_then(|v| v.get("color")?.as_str().map(String::from))
                        .unwrap_or_else(|| "#64748B".into());
                    Occupant {
                        name: if p.name.is_empty() { p.identity.clone() } else { p.name },
                        username: p.identity,
                        color,
                        muted: p.tracks.is_empty() || p.tracks.iter().all(|t| t.muted),
                    }
                })
                .collect(),
        )
    }
    .await;
    result.unwrap_or_else(|e| {
        tracing::warn!("couldn't list room {room}: {e:#}");
        vec![]
    })
}

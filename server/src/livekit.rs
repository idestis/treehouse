//! LiveKit: access tokens for the app and webhook signature checks. Both are
//! HS256 JWTs signed with the API secret, done here with `hmac` + `sha2`.
//! Token format: https://docs.livekit.io/home/get-started/authentication/
//!
//! Each voice room is the LiveKit room `room-<id>`; each person joins with
//! their user id (as a string) as the identity. The desktop overlay (people
//! on top while you share) joins as `<user id>-overlay`, hidden and
//! watch-only; webhooks ignore every identity that isn't a plain user id.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::config::LiveKit;

/// Voice tokens are short; the app asks for a new one about every 10 minutes.
pub const TOKEN_TTL_SECS: i64 = 15 * 60;
/// Clock difference tolerated on webhook tokens.
const LEEWAY_SECS: i64 = 60;

pub fn room_name(room_id: i64) -> String {
    format!("room-{room_id}")
}

pub fn room_id(name: &str) -> Option<i64> {
    name.strip_prefix("room-")?.parse().ok()
}

/// A token that lets this user join `room-<id>` and publish microphone,
/// camera and screen share. Returns the token and its expiry.
pub fn voice_token(
    lk: &LiveKit,
    user_id: i64,
    display_name: &str,
    room_id: i64,
    now: OffsetDateTime,
) -> anyhow::Result<(String, OffsetDateTime)> {
    sign_grant(
        lk,
        &user_id.to_string(),
        display_name,
        json!({
            "room": room_name(room_id),
            "roomJoin": true,
            "canPublish": true,
            "canSubscribe": true,
            "canPublishData": false,
            "canPublishSources": ["microphone", "camera", "screen_share", "screen_share_audio"],
        }),
        now,
    )
}

/// The identity of someone's overlay connection: `<user id>-overlay`.
pub fn overlay_identity(user_id: i64) -> String {
    format!("{user_id}-overlay")
}

/// Outbox payload for the `remove_participant` job: kick `identity` out of
/// the LiveKit room for `room_id`.
pub fn remove_participant_payload(room_id: i64, identity: &str) -> Value {
    json!({ "room": room_name(room_id), "identity": identity })
}

/// A watch-only token for the desktop "people on top" window: it can
/// subscribe but never publish, and LiveKit hides it from everyone else.
/// Its identity isn't a plain user id, so webhooks ignore it.
pub fn overlay_token(
    lk: &LiveKit,
    user_id: i64,
    display_name: &str,
    room_id: i64,
    now: OffsetDateTime,
) -> anyhow::Result<(String, OffsetDateTime)> {
    sign_grant(
        lk,
        &overlay_identity(user_id),
        display_name,
        json!({
            "room": room_name(room_id),
            "roomJoin": true,
            "canPublish": false,
            "canSubscribe": true,
            "canPublishData": false,
            "hidden": true,
        }),
        now,
    )
}

/// The user id behind a LiveKit identity, only for people's own voice
/// connections (all digits). Overlay and any other identities give `None`.
pub fn user_identity(identity: &str) -> Option<i64> {
    if identity.is_empty() || !identity.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    identity.parse().ok()
}

fn sign_grant(
    lk: &LiveKit,
    identity: &str,
    display_name: &str,
    video: Value,
    now: OffsetDateTime,
) -> anyhow::Result<(String, OffsetDateTime)> {
    let nbf = now.unix_timestamp();
    let exp = nbf + TOKEN_TTL_SECS;
    let claims = json!({
        "iss": lk.api_key,
        "sub": identity,
        "name": display_name,
        "nbf": nbf,
        "exp": exp,
        "video": video,
    });
    Ok((
        sign_hs256(&lk.api_secret, &claims)?,
        OffsetDateTime::from_unix_timestamp(exp)?,
    ))
}

fn mac(secret: &str) -> anyhow::Result<Hmac<Sha256>> {
    Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| anyhow::anyhow!("hmac key: {e}"))
}

pub fn sign_hs256(secret: &str, claims: &Value) -> anyhow::Result<String> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims)?);
    let signing_input = format!("{header}.{body}");
    let mut m = mac(secret)?;
    m.update(signing_input.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(m.finalize().into_bytes());
    Ok(format!("{signing_input}.{sig}"))
}

/// The claims of an HS256 JWT if its signature, `nbf` and `exp` hold.
pub fn verify_hs256(secret: &str, token: &str, now: i64) -> Option<Value> {
    let mut parts = token.split('.');
    let (h, b, s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(h).ok()?).ok()?;
    if header.get("alg")?.as_str()? != "HS256" {
        return None;
    }
    let sig = URL_SAFE_NO_PAD.decode(s).ok()?;
    let mut m = mac(secret).ok()?;
    m.update(h.as_bytes());
    m.update(b".");
    m.update(b.as_bytes());
    m.verify_slice(&sig).ok()?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(b).ok()?).ok()?;
    if let Some(exp) = claims.get("exp").and_then(Value::as_i64)
        && now > exp + LEEWAY_SECS
    {
        return None;
    }
    if let Some(nbf) = claims.get("nbf").and_then(Value::as_i64)
        && now + LEEWAY_SECS < nbf
    {
        return None;
    }
    Some(claims)
}

/// LiveKit signs each webhook: the Authorization header is a JWT from our
/// API key whose `sha256` claim is base64(SHA-256(raw body)).
pub fn verify_webhook(lk: &LiveKit, authorization: Option<&str>, body: &[u8], now: i64) -> bool {
    let Some(auth) = authorization.map(str::trim) else {
        return false;
    };
    let token = auth.strip_prefix("Bearer ").unwrap_or(auth);
    let Some(claims) = verify_hs256(&lk.api_secret, token, now) else {
        return false;
    };
    if claims.get("iss").and_then(Value::as_str) != Some(lk.api_key.as_str()) {
        return false;
    }
    let want = STANDARD.encode(Sha256::digest(body));
    claims.get("sha256").and_then(Value::as_str) == Some(want.as_str())
}

/// The parts of a LiveKit webhook we use (protobuf JSON, camelCase).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct WebhookEvent {
    pub event: String,
    pub room: Option<WebhookRoom>,
    pub participant: Option<WebhookParticipant>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct WebhookRoom {
    pub name: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct WebhookParticipant {
    pub sid: String,
    pub identity: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lk() -> LiveKit {
        LiveKit {
            url: "ws://localhost:7880".into(),
            api_key: "devkey".into(),
            api_secret: "a-test-secret-that-is-long-enough-1234".into(),
        }
    }

    #[test]
    fn room_names_round_trip() {
        assert_eq!(room_name(7), "room-7");
        assert_eq!(room_id("room-7"), Some(7));
        assert_eq!(room_id("room-x"), None);
        assert_eq!(room_id("lobby"), None);
    }

    #[test]
    fn voice_token_claims() {
        let lk = lk();
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let (token, exp) = voice_token(&lk, 42, "Kai", 3, now).unwrap();
        assert_eq!(exp.unix_timestamp(), 1_800_000_000 + 15 * 60);

        let c = verify_hs256(&lk.api_secret, &token, 1_800_000_000).unwrap();
        assert_eq!(c["iss"], "devkey");
        assert_eq!(c["sub"], "42");
        assert_eq!(c["name"], "Kai");
        assert_eq!(c["nbf"], 1_800_000_000);
        assert_eq!(c["exp"], 1_800_000_000 + 900);
        let v = &c["video"];
        assert_eq!(v["room"], "room-3");
        assert_eq!(v["roomJoin"], true);
        assert_eq!(v["canPublish"], true);
        assert_eq!(v["canSubscribe"], true);
        assert_eq!(v["canPublishData"], false);
        assert_eq!(
            v["canPublishSources"],
            json!(["microphone", "camera", "screen_share", "screen_share_audio"])
        );

        // Header is HS256, and another secret doesn't verify it.
        let header = token.split('.').next().unwrap();
        let header: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap();
        assert_eq!(header["alg"], "HS256");
        assert!(verify_hs256("another-secret-another-secret-123", &token, 1_800_000_000).is_none());
        // Expired a while ago.
        assert!(verify_hs256(&lk.api_secret, &token, 1_800_000_000 + 900 + 120).is_none());
    }

    #[test]
    fn overlay_token_claims() {
        let lk = lk();
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let (token, exp) = overlay_token(&lk, 42, "Kai", 3, now).unwrap();
        assert_eq!(exp.unix_timestamp(), 1_800_000_000 + 15 * 60);

        let c = verify_hs256(&lk.api_secret, &token, 1_800_000_000).unwrap();
        assert_eq!(c["iss"], "devkey");
        assert_eq!(c["sub"], "42-overlay");
        assert_eq!(c["name"], "Kai");
        assert_eq!(c["nbf"], 1_800_000_000);
        assert_eq!(c["exp"], 1_800_000_000 + 900);
        let v = &c["video"];
        assert_eq!(v["room"], "room-3");
        assert_eq!(v["roomJoin"], true);
        assert_eq!(v["canSubscribe"], true);
        assert_eq!(v["canPublish"], false);
        assert_eq!(v["canPublishData"], false);
        assert_eq!(v["hidden"], true);
        assert!(v.get("canPublishSources").is_none());
        // Webhooks never take it for a person.
        assert_eq!(user_identity(c["sub"].as_str().unwrap()), None);
    }

    #[test]
    fn remove_participant_payload_names_room_and_identity() {
        let p = remove_participant_payload(7, &overlay_identity(3));
        assert_eq!(p["room"], room_name(7));
        assert_eq!(p["identity"], "3-overlay");
    }

    #[test]
    fn user_identities() {
        assert_eq!(user_identity("5"), Some(5));
        assert_eq!(user_identity("123456"), Some(123_456));
        assert_eq!(user_identity(&overlay_identity(3)), None);
        assert_eq!(user_identity("3-overlay"), None);
        assert_eq!(user_identity("+3"), None);
        assert_eq!(user_identity("-3"), None);
        assert_eq!(user_identity(" 3"), None);
        assert_eq!(user_identity(""), None);
        assert_eq!(user_identity("99999999999999999999999"), None);
    }

    fn webhook_auth(lk: &LiveKit, body: &[u8]) -> String {
        let claims = json!({
            "iss": lk.api_key,
            "nbf": 1_800_000_000,
            "exp": 1_800_000_000 + 300,
            "sha256": STANDARD.encode(Sha256::digest(body)),
        });
        sign_hs256(&lk.api_secret, &claims).unwrap()
    }

    #[test]
    fn webhook_signature() {
        let lk = lk();
        let now = 1_800_000_010;
        let body = br#"{"event":"participant_joined","room":{"name":"room-2"},"participant":{"sid":"PA_1","identity":"5"}}"#;
        let auth = webhook_auth(&lk, body);

        // Good signature, with or without "Bearer ".
        assert!(verify_webhook(&lk, Some(&auth), body, now));
        assert!(verify_webhook(
            &lk,
            Some(&format!("Bearer {auth}")),
            body,
            now
        ));

        // Missing header.
        assert!(!verify_webhook(&lk, None, body, now));
        // Tampered body.
        let tampered = br#"{"event":"participant_joined","room":{"name":"room-2"},"participant":{"sid":"PA_1","identity":"6"}}"#;
        assert!(!verify_webhook(&lk, Some(&auth), tampered, now));
        // Signed with another secret.
        let other = LiveKit {
            api_secret: "not-the-right-secret-not-the-right".into(),
            ..lk.clone()
        };
        assert!(!verify_webhook(
            &lk,
            Some(&webhook_auth(&other, body)),
            body,
            now
        ));
        // Another API key.
        let other_key = LiveKit {
            api_key: "otherkey".into(),
            ..lk.clone()
        };
        assert!(!verify_webhook(
            &lk,
            Some(&webhook_auth(&other_key, body)),
            body,
            now
        ));
        // Signature bytes flipped.
        let mut bad = auth.clone();
        bad.pop();
        bad.push(if auth.ends_with('A') { 'B' } else { 'A' });
        assert!(!verify_webhook(&lk, Some(&bad), body, now));
        // Expired.
        assert!(!verify_webhook(&lk, Some(&auth), body, now + 3600));
        // alg none is refused.
        let none = format!(
            "{}.{}.",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
            auth.split('.').nth(1).unwrap()
        );
        assert!(!verify_webhook(&lk, Some(&none), body, now));
    }

    #[test]
    fn webhook_event_parses() {
        let e: WebhookEvent = serde_json::from_str(
            r#"{"event":"participant_left","id":"EV_1","createdAt":"1800000000",
                "room":{"sid":"RM_1","name":"room-2","emptyTimeout":300},
                "participant":{"sid":"PA_1","identity":"5","state":"DISCONNECTED","joinedAt":"1800000000"}}"#,
        )
        .unwrap();
        assert_eq!(e.event, "participant_left");
        assert_eq!(e.room.unwrap().name, "room-2");
        let p = e.participant.unwrap();
        assert_eq!((p.sid.as_str(), p.identity.as_str()), ("PA_1", "5"));
    }
}

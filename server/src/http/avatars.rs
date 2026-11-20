//! Profile pictures: uploaded through the API, re-encoded here, stored in
//! Postgres, served only to signed-in members.

use std::io::Cursor;

use axum::{
    Json,
    extract::{Path, State},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageReader, Limits, codecs::jpeg::JpegEncoder, imageops::FilterType};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    auth::{Authed, MeOut},
    error::{AppError, AppResult},
    events,
    http::AppState,
};

const MAX_UPLOAD: usize = 3 * 1024 * 1024;
/// Smaller pictures would be blown up into blur.
const MIN_SIDE: u32 = 64;
/// Decoding refuses anything larger (and bounds memory), so a crafted file can't exhaust the server.
const MAX_SIDE: u32 = 8000;
const SIZE: u32 = 256;
const QUALITY: u8 = 85;

/// Decode with limits (no decompression bombs), crop to a centered square,
/// resize, and re-encode as JPEG. Re-encoding drops EXIF (GPS and the like).
pub fn process(bytes: &[u8]) -> AppResult<Vec<u8>> {
    let bad = || {
        AppError::bad(
            "bad_image",
            "That file isn't a picture we can use. Try a JPEG or PNG.",
        )
    };
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| bad())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|_| bad())?;
    if img.width() < MIN_SIDE || img.height() < MIN_SIDE {
        return Err(AppError::bad(
            "too_small",
            format!("That picture is too small. Use one at least {MIN_SIDE}×{MIN_SIDE} pixels."),
        ));
    }
    let square = img
        .resize_to_fill(SIZE, SIZE, FilterType::Lanczos3)
        .to_rgb8();
    let mut out = Vec::with_capacity(32 * 1024);
    JpegEncoder::new_with_quality(&mut out, QUALITY)
        .encode_image(&square)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("encoding avatar: {e}")))?;
    Ok(out)
}

#[derive(Deserialize)]
pub struct UploadIn {
    /// Base64 (a data: URL prefix is fine too).
    image: String,
}

pub async fn upload(
    State(st): State<AppState>,
    Authed(user): Authed,
    Json(inp): Json<UploadIn>,
) -> AppResult<Json<MeOut>> {
    let b64 = inp
        .image
        .split_once(',')
        .map_or(inp.image.as_str(), |(_, d)| d);
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|_| AppError::bad("bad_image", "That upload didn't come through. Try again."))?;
    if bytes.len() > MAX_UPLOAD {
        return Err(AppError::bad(
            "too_big",
            "That picture is too big. Use one under 3 MB.",
        ));
    }
    let jpeg = tokio::task::spawn_blocking(move || process(&bytes))
        .await
        .map_err(|e| AppError::Internal(e.into()))??;

    let mut tx = st.db.begin().await?;
    let version = sqlx::query_scalar!(
        "INSERT INTO avatars (user_id, image) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET image = $2, version = avatars.version + 1, updated_at = now()
         RETURNING version",
        user.id,
        jpeg
    )
    .fetch_one(&mut *tx)
    .await?;
    events::emit(&mut tx, events::TREEHOUSE, "people", json!({})).await?;
    tx.commit().await?;
    let mut me = user.me();
    me.avatar = Some(version);
    Ok(Json(me))
}

pub async fn remove(State(st): State<AppState>, Authed(user): Authed) -> AppResult<Json<MeOut>> {
    let mut tx = st.db.begin().await?;
    sqlx::query!("DELETE FROM avatars WHERE user_id = $1", user.id)
        .execute(&mut *tx)
        .await?;
    events::emit(&mut tx, events::TREEHOUSE, "people", json!({})).await?;
    tx.commit().await?;
    let mut me = user.me();
    me.avatar = None;
    Ok(Json(me))
}

/// `{ "version": 3, "data_url": "data:image/jpeg;base64,..." }`. JSON rather than
/// raw bytes so it travels the same authenticated path as every other call.
pub async fn get(
    State(st): State<AppState>,
    Authed(_): Authed,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let row = sqlx::query!("SELECT image, version FROM avatars WHERE user_id = $1", id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::not_found("No picture."))?;
    Ok(Json(json!({
        "version": row.version,
        "data_url": format!("data:image/jpeg;base64,{}", STANDARD.encode(row.image)),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reencodes_to_small_square_jpeg() {
        let mut png = Vec::new();
        image::RgbImage::from_fn(900, 500, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 120])
        })
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
        let out = process(&png).unwrap();
        let back = image::load_from_memory(&out).unwrap();
        assert_eq!((back.width(), back.height()), (SIZE, SIZE));
        assert!(out.starts_with(&[0xFF, 0xD8]), "jpeg");
        assert!(out.len() < 100_000);
    }

    #[test]
    fn rejects_tiny_and_huge() {
        let mut png = Vec::new();
        image::RgbImage::new(40, 40)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        assert!(process(&png).is_err(), "too small");
        let mut big = Vec::new();
        image::GrayImage::new(MAX_SIDE + 1, 10)
            .write_to(&mut Cursor::new(&mut big), image::ImageFormat::Png)
            .unwrap();
        assert!(process(&big).is_err(), "too wide");
    }

    #[test]
    fn rejects_non_images() {
        assert!(process(b"definitely not a picture").is_err());
    }
}

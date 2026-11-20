//! GIPHY proxy. The API key never leaves the server; results are cached for
//! 10 minutes (a throwaway cache, fine to lose on restart).

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use crate::error::{AppError, AppResult};

const TTL: Duration = Duration::from_secs(600);

pub struct Gifs {
    key: Option<String>,
    http: reqwest::Client,
    cache: Mutex<HashMap<String, (Instant, Value)>>,
}

impl Gifs {
    pub fn new(key: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_default();
        Self {
            key,
            http,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.key.is_some()
    }

    fn key(&self) -> AppResult<&str> {
        self.key
            .as_deref()
            .ok_or_else(|| AppError::unavailable("gifs_off", "GIFs are off on this server."))
    }

    fn cached(&self, k: &str) -> Option<Value> {
        let mut c = self.cache.lock().ok()?;
        c.retain(|_, (at, _)| at.elapsed() < TTL);
        c.get(k).map(|(_, v)| v.clone())
    }

    fn store(&self, k: String, v: &Value) {
        if let Ok(mut c) = self.cache.lock() {
            if c.len() > 500 {
                c.clear();
            }
            c.insert(k, (Instant::now(), v.clone()));
        }
    }

    pub async fn search(&self, q: &str, rating: &str) -> AppResult<Value> {
        let key = self.key()?;
        if q.is_empty() {
            return Ok(json!([]));
        }
        let ck = format!("s:{rating}:{}", q.to_lowercase());
        if let Some(v) = self.cached(&ck) {
            return Ok(v);
        }
        let res: Value = self
            .http
            .get("https://api.giphy.com/v1/gifs/search")
            .query(&[
                ("api_key", key),
                ("q", q),
                ("rating", rating),
                ("limit", "12"),
            ])
            .send()
            .await
            .map_err(|_| unreachable_giphy())?
            .json()
            .await
            .map_err(|_| unreachable_giphy())?;
        let list: Vec<Value> = res["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(simplify)
            .collect();
        let v = Value::Array(list);
        self.store(ck, &v);
        Ok(v)
    }

    /// Look up one GIF to store with a message (its ID and links only).
    pub async fn by_id(&self, id: &str, rating: &str) -> AppResult<Value> {
        let key = self.key()?;
        if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(AppError::bad("bad_gif", "That GIF isn't available."));
        }
        let ck = format!("g:{id}");
        let g = match self.cached(&ck) {
            Some(v) => v,
            None => {
                let res: Value = self
                    .http
                    .get(format!("https://api.giphy.com/v1/gifs/{id}"))
                    .query(&[("api_key", key)])
                    .send()
                    .await
                    .map_err(|_| unreachable_giphy())?
                    .json()
                    .await
                    .map_err(|_| unreachable_giphy())?;
                let v = simplify(&res["data"])
                    .ok_or_else(|| AppError::bad("bad_gif", "That GIF isn't available."))?;
                self.store(ck, &v);
                v
            }
        };
        if !rating_ok(g["rating"].as_str().unwrap_or("r"), rating) {
            return Err(AppError::bad("bad_gif", "That GIF isn't available."));
        }
        Ok(g)
    }
}

fn unreachable_giphy() -> AppError {
    AppError::unavailable(
        "gifs_down",
        "GIF search isn't answering. Try again in a bit.",
    )
}

fn rating_ok(gif: &str, allowed: &str) -> bool {
    let rank = |r: &str| match r {
        "g" => 0,
        "pg" => 1,
        "pg-13" => 2,
        _ => 3,
    };
    rank(gif) <= rank(allowed)
}

fn simplify(g: &Value) -> Option<Value> {
    let img = &g["images"]["fixed_height"];
    let preview = &g["images"]["fixed_height_small"];
    Some(json!({
        "id": g["id"].as_str()?,
        "title": g["title"].as_str().unwrap_or("GIF"),
        "url": img["url"].as_str()?,
        "preview_url": preview["url"].as_str().or(img["url"].as_str())?,
        "width": img["width"].as_str().and_then(|w| w.parse::<u32>().ok()).unwrap_or(0),
        "height": img["height"].as_str().and_then(|h| h.parse::<u32>().ok()).unwrap_or(0),
        "rating": g["rating"].as_str().unwrap_or("g"),
    }))
}

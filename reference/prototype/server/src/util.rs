use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use rand::Rng;
use sha2::{Digest, Sha256};

/// Unix time in seconds.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 32 random bytes as hex. Used for session cookies and device tokens.
pub fn random_token() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}

/// Tokens are stored only as SHA-256 hashes, so a leaked database
/// does not leak working logins.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// No 0/O, 1/I/L, so codes are easy to read aloud and type.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// A human-friendly code like `K7MQ-PX2D` (groups of `group` chars).
pub fn human_code(groups: usize, group: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..groups)
        .map(|_| {
            (0..group)
                .map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("-")
}

/// Uppercase and strip spaces and dashes so `k7mq px2d` matches `K7MQ-PX2D`.
pub fn normalize_code(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

pub fn format_date(ts: i64) -> String {
    // Days since epoch -> civil date (Howard Hinnant's algorithm), no extra deps.
    let days = ts.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!("{} {} {}", d, MONTHS[(m - 1) as usize], y)
}

/// Any internal failure becomes a plain 500; details go to the log only.
pub struct AppError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        tracing::error!("internal error: {:#}", self.0);
        (StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong on the server.").into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

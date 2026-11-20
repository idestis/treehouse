//! One error type for every handler: maps to an HTTP status and
//! `{ "error": "code", "message": "Human sentence." }`, plus `"params"` when
//! the sentence has values in it. The app translates by code (each code has
//! one sentence) and fills the params in; `message` stays English.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    /// A refusal the user should read: status, short code, sentence, and the
    /// values in that sentence (for translations).
    User(StatusCode, &'static str, String, Option<serde_json::Value>),
    Internal(anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn bad(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::BAD_REQUEST, code, msg.into(), None)
    }
    pub fn unauthorized(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::UNAUTHORIZED, code, msg.into(), None)
    }
    pub fn forbidden(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::FORBIDDEN, code, msg.into(), None)
    }
    pub fn not_found(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::NOT_FOUND, code, msg.into(), None)
    }
    pub fn conflict(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::CONFLICT, code, msg.into(), None)
    }
    pub fn too_many(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::TOO_MANY_REQUESTS, code, msg.into(), None)
    }
    pub fn unavailable(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::SERVICE_UNAVAILABLE, code, msg.into(), None)
    }
    /// Attach the values used in the sentence, e.g. `json!({ "room": name })`.
    pub fn with(self, params: serde_json::Value) -> Self {
        match self {
            Self::User(status, code, msg, _) => Self::User(status, code, msg, Some(params)),
            other => other,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message, params) = match self {
            AppError::User(status, code, msg, params) => (status, code, msg, params),
            AppError::Internal(err) => {
                tracing::error!(error = %format!("{err:#}"), "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "Something went wrong on the server. Try again.".to_string(),
                    None,
                )
            }
        };
        let body = match params {
            Some(p) => json!({ "error": code, "message": message, "params": p }),
            None => json!({ "error": code, "message": message }),
        };
        (status, Json(body)).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(err: E) -> Self {
        AppError::Internal(err.into())
    }
}

/// True when a database error is a unique-constraint violation.
pub fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(e) if e.code().as_deref() == Some("23505"))
}

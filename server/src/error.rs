//! One error type for every handler: maps to an HTTP status and
//! `{ "error": "code", "message": "Human sentence." }`.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    /// A refusal the user should read: status, short code, sentence.
    User(StatusCode, &'static str, String),
    Internal(anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn bad(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::BAD_REQUEST, code, msg.into())
    }
    pub fn unauthorized(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::UNAUTHORIZED, code, msg.into())
    }
    pub fn forbidden(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::FORBIDDEN, code, msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::User(StatusCode::NOT_FOUND, "not_found", msg.into())
    }
    pub fn conflict(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::CONFLICT, code, msg.into())
    }
    pub fn too_many(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::TOO_MANY_REQUESTS, code, msg.into())
    }
    pub fn unavailable(code: &'static str, msg: impl Into<String>) -> Self {
        Self::User(StatusCode::SERVICE_UNAVAILABLE, code, msg.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            AppError::User(status, code, msg) => (status, code, msg),
            AppError::Internal(err) => {
                tracing::error!(error = %format!("{err:#}"), "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "Something went wrong on the server. Try again.".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": code, "message": message }))).into_response()
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

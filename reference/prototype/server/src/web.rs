use askama::Template;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Form, Router};
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use crate::auth::{self, AdminUser, PendingMfaUser, User, WebUser};
use crate::util::{format_date, hash_token, human_code, normalize_code, now, AppResult};
use crate::AppState;

pub const ISSUER: &str = "Treehouse";

pub const COLORS: [(&str, &str); 8] = [
    ("#3F8EFC", "Sky"),
    ("#12A594", "Teal"),
    ("#2FA84F", "Leaf"),
    ("#E8A317", "Sun"),
    ("#F0663A", "Tangerine"),
    ("#E5487D", "Berry"),
    ("#8B5CF6", "Grape"),
    ("#64748B", "Slate"),
];

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(home))
        .route("/static/style.css", get(stylesheet))
        .route("/login", get(login_page).post(login_submit))
        .route("/login/mfa", get(mfa_page).post(mfa_submit))
        .route("/logout", post(logout))
        .route("/join", get(join_page).post(join_submit))
        .route("/account", get(account_page))
        .route("/account/profile", post(save_profile))
        .route("/account/password", post(change_password))
        .route("/account/mfa", get(mfa_setup_page).post(mfa_enable))
        .route("/account/mfa/disable", post(mfa_disable))
        .route("/account/pair", post(create_pair_code))
        .route("/account/devices/{id}/remove", post(remove_device))
        .route("/admin", get(admin_page))
        .route("/admin/invites", post(create_invite))
        .route("/admin/invites/{code}/delete", post(delete_invite))
        .route("/admin/users/{id}/toggle", post(toggle_user))
        .route("/admin/users/{id}/reset-mfa", post(reset_user_mfa))
}

// ---------- shared bits ----------

pub struct Nav {
    pub signed_in: bool,
    pub admin: bool,
}

impl Nav {
    fn guest() -> Self {
        Nav { signed_in: false, admin: false }
    }
    fn for_user(u: &User) -> Self {
        Nav { signed_in: true, admin: u.is_admin }
    }
}

fn initial(name: &str) -> String {
    name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_else(|| "?".into())
}

fn render<T: Template>(t: T) -> AppResult<Response> {
    Ok(Html(t.render()?).into_response())
}

async fn stylesheet() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8"), (header::CACHE_CONTROL, "public, max-age=3600")],
        include_str!("../static/style.css"),
    )
}

async fn home(jar: CookieJar) -> Redirect {
    if jar.get(auth::SESSION_COOKIE).is_some() {
        Redirect::to("/account")
    } else {
        Redirect::to("/login")
    }
}

// ---------- login ----------

#[derive(Template)]
#[template(path = "login.html")]
struct LoginPage {
    nav: Nav,
    username: String,
    error: Option<String>,
}

async fn login_page() -> AppResult<Response> {
    render(LoginPage { nav: Nav::guest(), username: String::new(), error: None })
}

#[derive(Deserialize)]
struct LoginForm {
    username: String,
    password: String,
}

async fn login_submit(
    State(state): State<AppState>,
    jar: CookieJar,
    Form(form): Form<LoginForm>,
) -> AppResult<Response> {
    let username = form.username.trim().to_string();
    let fail = |msg: &str| {
        render(LoginPage { nav: Nav::guest(), username: username.clone(), error: Some(msg.to_string()) })
    };

    if auth::is_locked_out(&state, &username).await? {
        return fail("Too many wrong tries. Wait 15 minutes, then try again.");
    }

    let user: Option<User> = sqlx::query_as("SELECT * FROM users WHERE username = ?")
        .bind(&username)
        .fetch_optional(&state.db)
        .await?;

    let ok = match &user {
        Some(u) => auth::verify_password(&form.password, &u.password_hash),
        None => {
            auth::dummy_verify(&form.password);
            false
        }
    };

    let Some(user) = user.filter(|_| ok) else {
        auth::record_failure(&state, &username).await?;
        return fail("Wrong username or password.");
    };
    if user.disabled {
        return fail("This account is paused. Ask the admin to turn it back on.");
    }

    auth::clear_failures(&state, &username).await?;
    let needs_mfa = user.mfa_enabled();
    let jar = auth::start_session(&state, jar, user.id, !needs_mfa).await?;
    let to = if needs_mfa { "/login/mfa" } else { "/account" };
    Ok((jar, Redirect::to(to)).into_response())
}

#[derive(Template)]
#[template(path = "mfa.html")]
struct MfaPage {
    nav: Nav,
    error: Option<String>,
}

async fn mfa_page(_pending: PendingMfaUser) -> AppResult<Response> {
    render(MfaPage { nav: Nav::guest(), error: None })
}

#[derive(Deserialize)]
struct CodeForm {
    code: String,
}

async fn mfa_submit(
    State(state): State<AppState>,
    pending: PendingMfaUser,
    Form(form): Form<CodeForm>,
) -> AppResult<Response> {
    let user = &pending.user;
    if auth::is_locked_out(&state, &user.username).await? {
        return render(MfaPage {
            nav: Nav::guest(),
            error: Some("Too many wrong codes. Wait 15 minutes, then try again.".into()),
        });
    }
    let secret = user.totp_secret.as_deref().unwrap_or_default();
    if !auth::check_totp(secret, &user.username, ISSUER, &form.code) {
        auth::record_failure(&state, &user.username).await?;
        return render(MfaPage {
            nav: Nav::guest(),
            error: Some("That code didn’t match. Use the newest code from your authenticator app.".into()),
        });
    }
    auth::clear_failures(&state, &user.username).await?;
    sqlx::query("UPDATE sessions SET mfa_ok = 1 WHERE token_hash = ?")
        .bind(&pending.session_hash)
        .execute(&state.db)
        .await?;
    Ok(Redirect::to("/account").into_response())
}

async fn logout(State(state): State<AppState>, jar: CookieJar) -> AppResult<Response> {
    let jar = auth::end_session(&state, jar).await?;
    Ok((jar, Redirect::to("/login")).into_response())
}

// ---------- join with an invite ----------

#[derive(Template)]
#[template(path = "join.html")]
struct JoinPage {
    nav: Nav,
    code: String,
    username: String,
    display_name: String,
    error: Option<String>,
}

#[derive(Deserialize)]
struct JoinQuery {
    code: Option<String>,
}

async fn join_page(Query(q): Query<JoinQuery>) -> AppResult<Response> {
    render(JoinPage {
        nav: Nav::guest(),
        code: q.code.unwrap_or_default(),
        username: String::new(),
        display_name: String::new(),
        error: None,
    })
}

#[derive(Deserialize)]
struct JoinForm {
    code: String,
    username: String,
    display_name: String,
    password: String,
    password2: String,
}

fn username_problem(name: &str) -> Option<&'static str> {
    let len = name.chars().count();
    if !(3..=24).contains(&len) {
        Some("Usernames are 3 to 24 characters long.")
    } else if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        Some("Usernames can use letters, numbers, - and _ only.")
    } else {
        None
    }
}

async fn join_submit(
    State(state): State<AppState>,
    jar: CookieJar,
    Form(form): Form<JoinForm>,
) -> AppResult<Response> {
    let username = form.username.trim().to_string();
    let display_name: String = form.display_name.trim().chars().take(32).collect();
    let fail = |msg: &str| {
        render(JoinPage {
            nav: Nav::guest(),
            code: form.code.clone(),
            username: username.clone(),
            display_name: display_name.clone(),
            error: Some(msg.to_string()),
        })
    };

    if let Some(p) = username_problem(&username) {
        return fail(p);
    }
    if display_name.is_empty() {
        return fail("Pick a name your friends will see.");
    }
    if let Some(p) = auth::password_problem(&form.password) {
        return fail(p);
    }
    if form.password != form.password2 {
        return fail("The two passwords don’t match.");
    }

    let code = normalize_code(&form.code);
    let invite: Option<(String, bool)> = sqlx::query_as(
        "SELECT code, make_admin FROM invites WHERE code = ? AND used_by IS NULL AND expires_at > ?",
    )
    .bind(&code)
    .bind(now())
    .fetch_optional(&state.db)
    .await?;
    let Some((code, make_admin)) = invite else {
        return fail("That invite code is wrong, already used, or expired. Ask for a new one.");
    };

    let taken: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE username = ?")
        .bind(&username)
        .fetch_optional(&state.db)
        .await?;
    if taken.is_some() {
        return fail("That username is taken. Try another one.");
    }

    let hash = auth::hash_password(&form.password)?;
    let color = COLORS[rand::random::<usize>() % COLORS.len()].0;

    let mut tx = state.db.begin().await?;
    let (user_id,): (i64,) = sqlx::query_as(
        "INSERT INTO users (username, display_name, color, password_hash, is_admin, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(&username)
    .bind(&display_name)
    .bind(color)
    .bind(&hash)
    .bind(make_admin)
    .bind(now())
    .fetch_one(&mut *tx)
    .await?;
    let claimed = sqlx::query("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL")
        .bind(user_id)
        .bind(now())
        .bind(&code)
        .execute(&mut *tx)
        .await?;
    if claimed.rows_affected() != 1 {
        tx.rollback().await?;
        return fail("That invite was just used by someone else. Ask for a new one.");
    }
    tx.commit().await?;

    let jar = auth::start_session(&state, jar, user_id, true).await?;
    Ok((jar, Redirect::to("/account?done=welcome")).into_response())
}

// ---------- account ----------

struct ColorOpt {
    hex: &'static str,
    name: &'static str,
    selected: bool,
}

struct DeviceRow {
    id: i64,
    name: String,
    added: String,
    last_seen: String,
}

#[derive(Template)]
#[template(path = "account.html")]
struct AccountPage {
    nav: Nav,
    username: String,
    display_name: String,
    initial: String,
    color: String,
    colors: Vec<ColorOpt>,
    mfa_enabled: bool,
    devices: Vec<DeviceRow>,
    pair_code: Option<String>,
    notice: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct DoneQuery {
    done: Option<String>,
}

async fn build_account(
    state: &AppState,
    user: &User,
    pair_code: Option<String>,
    notice: Option<String>,
    error: Option<String>,
) -> AppResult<AccountPage> {
    let rows: Vec<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT id, name, created_at, last_seen FROM devices WHERE user_id = ? ORDER BY created_at",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(AccountPage {
        nav: Nav::for_user(user),
        username: user.username.clone(),
        display_name: user.display_name.clone(),
        initial: initial(&user.display_name),
        color: user.color.clone(),
        colors: COLORS
            .iter()
            .map(|(hex, name)| ColorOpt { hex, name, selected: user.color.eq_ignore_ascii_case(hex) })
            .collect(),
        mfa_enabled: user.mfa_enabled(),
        devices: rows
            .into_iter()
            .map(|(id, name, added, seen)| DeviceRow {
                id,
                name,
                added: format_date(added),
                last_seen: format_date(seen),
            })
            .collect(),
        pair_code,
        notice,
        error,
    })
}

async fn account_page(
    State(state): State<AppState>,
    WebUser(user): WebUser,
    Query(q): Query<DoneQuery>,
) -> AppResult<Response> {
    let notice = q.done.as_deref().and_then(|d| match d {
        "welcome" => Some("You’re in. Next, pair the desktop app so you can talk with your friends."),
        "profile" => Some("Profile saved."),
        "password" => Some("Password changed."),
        "mfa-on" => Some("Two-step sign-in is on."),
        "mfa-off" => Some("Two-step sign-in is off."),
        "device-removed" => Some("Device removed. It can’t connect anymore."),
        _ => None,
    });
    render(build_account(&state, &user, None, notice.map(String::from), None).await?)
}

#[derive(Deserialize)]
struct ProfileForm {
    display_name: String,
    color: String,
}

async fn save_profile(
    State(state): State<AppState>,
    WebUser(user): WebUser,
    Form(form): Form<ProfileForm>,
) -> AppResult<Response> {
    let name: String = form.display_name.trim().chars().take(32).collect();
    if name.is_empty() {
        let page = build_account(&state, &user, None, None, Some("Your name can’t be empty.".into())).await?;
        return render(page);
    }
    let color = COLORS
        .iter()
        .find(|(hex, _)| hex.eq_ignore_ascii_case(&form.color))
        .map(|(hex, _)| *hex)
        .unwrap_or(COLORS[0].0);
    sqlx::query("UPDATE users SET display_name = ?, color = ? WHERE id = ?")
        .bind(&name)
        .bind(color)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Ok(Redirect::to("/account?done=profile").into_response())
}

#[derive(Deserialize)]
struct PasswordForm {
    current: String,
    new_password: String,
    new_password2: String,
}

async fn change_password(
    State(state): State<AppState>,
    WebUser(user): WebUser,
    Form(form): Form<PasswordForm>,
) -> AppResult<Response> {
    let problem = if !auth::verify_password(&form.current, &user.password_hash) {
        Some("Your current password is wrong.")
    } else if form.new_password != form.new_password2 {
        Some("The new passwords don’t match.")
    } else {
        auth::password_problem(&form.new_password)
    };
    if let Some(p) = problem {
        return render(build_account(&state, &user, None, None, Some(p.into())).await?);
    }
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(auth::hash_password(&form.new_password)?)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Ok(Redirect::to("/account?done=password").into_response())
}

// ---------- two-step sign-in (TOTP) ----------

#[derive(Template)]
#[template(path = "mfa_setup.html")]
struct MfaSetupPage {
    nav: Nav,
    qr_png_base64: String,
    secret: String,
    error: Option<String>,
}

async fn mfa_setup_view(state: &AppState, user: &User, error: Option<String>) -> AppResult<Response> {
    let secret = match &user.totp_pending {
        Some(s) => s.clone(),
        None => {
            let s = auth::new_totp_secret();
            sqlx::query("UPDATE users SET totp_pending = ? WHERE id = ?")
                .bind(&s)
                .bind(user.id)
                .execute(&state.db)
                .await?;
            s
        }
    };
    let totp = auth::totp_for(&secret, &user.username, ISSUER)?;
    let qr = totp.get_qr_base64().map_err(|e| anyhow::anyhow!("qr: {e}"))?;
    render(MfaSetupPage { nav: Nav::for_user(user), qr_png_base64: qr, secret, error })
}

async fn mfa_setup_page(State(state): State<AppState>, WebUser(user): WebUser) -> AppResult<Response> {
    if user.mfa_enabled() {
        return Ok(Redirect::to("/account").into_response());
    }
    mfa_setup_view(&state, &user, None).await
}

async fn mfa_enable(
    State(state): State<AppState>,
    WebUser(user): WebUser,
    Form(form): Form<CodeForm>,
) -> AppResult<Response> {
    let Some(pending) = user.totp_pending.clone() else {
        return Ok(Redirect::to("/account/mfa").into_response());
    };
    if !auth::check_totp(&pending, &user.username, ISSUER, &form.code) {
        let msg = "That code didn’t match. Check that your phone’s clock is right and try the newest code.";
        return mfa_setup_view(&state, &user, Some(msg.into())).await;
    }
    sqlx::query("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL WHERE id = ?")
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Ok(Redirect::to("/account?done=mfa-on").into_response())
}

async fn mfa_disable(
    State(state): State<AppState>,
    WebUser(user): WebUser,
    Form(form): Form<CodeForm>,
) -> AppResult<Response> {
    let secret = user.totp_secret.clone().unwrap_or_default();
    if !auth::check_totp(&secret, &user.username, ISSUER, &form.code) {
        let msg = "That code didn’t match, so two-step sign-in is still on.";
        return render(build_account(&state, &user, None, None, Some(msg.into())).await?);
    }
    sqlx::query("UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?")
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Ok(Redirect::to("/account?done=mfa-off").into_response())
}

// ---------- devices ----------

async fn create_pair_code(State(state): State<AppState>, WebUser(user): WebUser) -> AppResult<Response> {
    sqlx::query("DELETE FROM pair_codes WHERE user_id = ? OR expires_at < ?")
        .bind(user.id)
        .bind(now())
        .execute(&state.db)
        .await?;
    let code = human_code(2, 4);
    sqlx::query("INSERT INTO pair_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(hash_token(&normalize_code(&code)))
        .bind(user.id)
        .bind(now() + 10 * 60)
        .execute(&state.db)
        .await?;
    render(build_account(&state, &user, Some(code), None, None).await?)
}

async fn remove_device(
    State(state): State<AppState>,
    WebUser(user): WebUser,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    sqlx::query("DELETE FROM devices WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Ok(Redirect::to("/account?done=device-removed").into_response())
}

// ---------- admin ----------

struct InviteRow {
    code: String,
    link: String,
    note: String,
    status: String,
    open: bool,
    admin: bool,
}

struct UserRow {
    id: i64,
    username: String,
    display_name: String,
    initial: String,
    color: String,
    admin: bool,
    disabled: bool,
    mfa: bool,
    devices: i64,
    is_self: bool,
}

#[derive(Template)]
#[template(path = "admin.html")]
struct AdminPage {
    nav: Nav,
    invites: Vec<InviteRow>,
    users: Vec<UserRow>,
    new_link: Option<String>,
}

#[derive(Deserialize)]
struct AdminQuery {
    new: Option<String>,
}

fn display_code(code: &str) -> String {
    if code.len() == 10 {
        format!("{}-{}", &code[..5], &code[5..])
    } else {
        code.to_string()
    }
}

async fn admin_page(
    State(state): State<AppState>,
    AdminUser(me): AdminUser,
    Query(q): Query<AdminQuery>,
) -> AppResult<Response> {
    let base = state.config.public_url.trim_end_matches('/');

    let invite_rows: Vec<(String, String, bool, i64, Option<String>)> = sqlx::query_as(
        "SELECT i.code, i.note, i.make_admin, i.expires_at, u.display_name
         FROM invites i LEFT JOIN users u ON u.id = i.used_by
         ORDER BY i.created_at DESC LIMIT 50",
    )
    .fetch_all(&state.db)
    .await?;
    let invites = invite_rows
        .into_iter()
        .map(|(code, note, admin, expires, used_by)| {
            let (status, open) = match used_by {
                Some(name) => (format!("Used by {name}"), false),
                None if expires < now() => ("Expired".to_string(), false),
                None => (format!("Open until {}", format_date(expires)), true),
            };
            let shown = display_code(&code);
            InviteRow { link: format!("{base}/join?code={shown}"), code: shown, note, status, open, admin }
        })
        .collect();

    let user_rows: Vec<(i64, String, String, String, bool, bool, Option<String>, i64)> = sqlx::query_as(
        "SELECT u.id, u.username, u.display_name, u.color, u.is_admin, u.disabled, u.totp_secret,
                (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id)
         FROM users u ORDER BY u.created_at",
    )
    .fetch_all(&state.db)
    .await?;
    let users = user_rows
        .into_iter()
        .map(|(id, username, display_name, color, admin, disabled, totp, devices)| UserRow {
            is_self: id == me.id,
            id,
            username,
            initial: initial(&display_name),
            display_name,
            color,
            admin,
            disabled,
            mfa: totp.is_some(),
            devices,
        })
        .collect();

    let new_link = q.new.map(|c| format!("{base}/join?code={}", display_code(&normalize_code(&c))));
    render(AdminPage { nav: Nav::for_user(&me), invites, users, new_link })
}

#[derive(Deserialize)]
struct InviteForm {
    note: String,
    days: i64,
    make_admin: Option<String>,
}

async fn create_invite(
    State(state): State<AppState>,
    AdminUser(me): AdminUser,
    Form(form): Form<InviteForm>,
) -> AppResult<Response> {
    let code = normalize_code(&human_code(2, 5));
    let days = form.days.clamp(1, 30);
    sqlx::query(
        "INSERT INTO invites (code, note, make_admin, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&code)
    .bind(form.note.trim().chars().take(60).collect::<String>())
    .bind(form.make_admin.is_some())
    .bind(me.id)
    .bind(now())
    .bind(now() + days * 86_400)
    .execute(&state.db)
    .await?;
    Ok(Redirect::to(&format!("/admin?new={code}")).into_response())
}

async fn delete_invite(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(code): Path<String>,
) -> AppResult<Response> {
    sqlx::query("DELETE FROM invites WHERE code = ? AND used_by IS NULL")
        .bind(normalize_code(&code))
        .execute(&state.db)
        .await?;
    Ok(Redirect::to("/admin").into_response())
}

async fn toggle_user(
    State(state): State<AppState>,
    AdminUser(me): AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    if id != me.id {
        sqlx::query("UPDATE users SET disabled = 1 - disabled WHERE id = ?")
            .bind(id)
            .execute(&state.db)
            .await?;
        // A paused account is signed out everywhere and its apps must be paired again.
        let (disabled,): (bool,) = sqlx::query_as("SELECT disabled FROM users WHERE id = ?")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
        if disabled {
            auth::revoke_everything(&state, id).await?;
        }
    }
    Ok(Redirect::to("/admin").into_response())
}

async fn reset_user_mfa(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    sqlx::query("UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Redirect::to("/admin").into_response())
}

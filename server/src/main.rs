use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    net::{IpAddr, SocketAddr},
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Context;
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, NaiveDate, Utc};
use flate2::read::GzDecoder;
use maxminddb::{geoip2, Reader};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use tokio::{net::{lookup_host, TcpListener}, sync::{Mutex, RwLock}};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{error, info, warn};
use uuid::Uuid;

const DEFAULT_GEOIP_MMDB_URL: &str = "https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz";
const MAX_GEOIP_DOWNLOAD_BYTES: usize = 128 * 1024 * 1024;
const MAX_GEOIP_DATABASE_BYTES: usize = 256 * 1024 * 1024;
const MAX_BACKGROUND_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_API_JSON_BYTES: usize = 256 * 1024;
const MAX_AGENT_PING_RESULTS: usize = 64;
const AUTH_RATE_LIMIT_ATTEMPTS: usize = 10;
const AUTH_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(15 * 60);
const AGENT_RATE_LIMIT_REQUESTS: usize = 120;
const AGENT_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const CENTER_AUTO_LOCATION_TTL_HOURS: i64 = 6;
const MIN_PUBLIC_REFRESH_SECONDS: i64 = 2;
const MAX_PUBLIC_REFRESH_SECONDS: i64 = 60;
const DEFAULT_PUBLIC_REFRESH_SECONDS: i64 = 5;
const AGENT_INSTALLER_SCRIPT: &str = include_str!("../../agent/install.sh");

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    config: Arc<Config>,
    http: reqwest::Client,
    geoip: Arc<RwLock<Option<GeoIp>>>,
    auth_limiter: Arc<AuthRateLimiter>,
    agent_limiter: Arc<AgentRateLimiter>,
    dummy_password_hash: Arc<String>,
}

#[derive(Default)]
struct AuthRateLimiter {
    failures: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl AuthRateLimiter {
    async fn check(&self, key: &str) -> Result<(), AppError> {
        let mut failures = self.failures.lock().await;
        let now = Instant::now();
        let attempts = failures.entry(key.to_string()).or_default();
        attempts.retain(|at| now.duration_since(*at) < AUTH_RATE_LIMIT_WINDOW);
        if attempts.len() >= AUTH_RATE_LIMIT_ATTEMPTS {
            return Err(AppError::too_many_requests("尝试次数过多，请 15 分钟后重试"));
        }
        Ok(())
    }

    async fn record_failure(&self, key: &str) {
        let mut failures = self.failures.lock().await;
        if failures.len() >= 10_000 {
            let now = Instant::now();
            failures.retain(|_, attempts| {
                attempts.retain(|at| now.duration_since(*at) < AUTH_RATE_LIMIT_WINDOW);
                !attempts.is_empty()
            });
        }
        failures.entry(key.to_string()).or_default().push_back(Instant::now());
    }

    async fn clear(&self, key: &str) {
        self.failures.lock().await.remove(key);
    }
}

#[derive(Default)]
struct AgentRateLimiter {
    requests: Mutex<HashMap<Uuid, VecDeque<Instant>>>,
}

impl AgentRateLimiter {
    async fn check_and_record(&self, server_id: Uuid) -> Result<(), AppError> {
        let mut requests = self.requests.lock().await;
        let now = Instant::now();
        if requests.len() >= 10_000 {
            requests.retain(|_, timestamps| {
                timestamps.retain(|at| now.duration_since(*at) < AGENT_RATE_LIMIT_WINDOW);
                !timestamps.is_empty()
            });
        }
        let timestamps = requests.entry(server_id).or_default();
        timestamps.retain(|at| now.duration_since(*at) < AGENT_RATE_LIMIT_WINDOW);
        if timestamps.len() >= AGENT_RATE_LIMIT_REQUESTS {
            return Err(AppError::too_many_requests("Agent 请求过于频繁"));
        }
        timestamps.push_back(now);
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct Config {
    bind_addr: SocketAddr,
    database_url: String,
    setup_token: String,
    base_url: String,
    static_dir: PathBuf,
    agent_image: String,
    agent_installer_url: String,
    agent_release_repository: String,
    agent_release_tag: String,
    cookie_secure: bool,
    trust_proxy_headers: bool,
    geoip_mmdb_path: PathBuf,
    background_dir: PathBuf,
}

impl Config {
    fn from_env() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();
        let bind_addr = std::env::var("BIND_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
            .parse()
            .context("BIND_ADDR 格式错误")?;
        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL 未设置")?;
        let setup_token = std::env::var("SETUP_TOKEN").context("SETUP_TOKEN 未设置")?;
        if setup_token.chars().count() < 32 {
            anyhow::bail!("SETUP_TOKEN 至少需要 32 个字符");
        }
        let base_url = std::env::var("BASE_URL")
            .unwrap_or_else(|_| format!("http://{}", bind_addr))
            .trim_end_matches('/')
            .to_string();
        validate_secure_http_url("BASE_URL", &base_url)?;
        let static_dir = PathBuf::from(std::env::var("STATIC_DIR").unwrap_or_else(|_| "web/dist".to_string()));
        let agent_image = std::env::var("AGENT_IMAGE").unwrap_or_else(|_| "vps-monitor-agent:latest".to_string());
        let agent_installer_url = std::env::var("AGENT_INSTALLER_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| format!("{}/install.sh", base_url));
        validate_secure_http_url("AGENT_INSTALLER_URL", &agent_installer_url)?;
        let agent_release_repository = std::env::var("AGENT_RELEASE_REPOSITORY")
            .unwrap_or_default()
            .trim()
            .to_string();
        let agent_release_tag = std::env::var("AGENT_RELEASE_TAG")
            .unwrap_or_default()
            .trim()
            .to_string();
        let geoip_mmdb_path = std::env::var("GEOIP_MMDB_PATH")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("data/GeoLite2-City.mmdb"));
        let background_dir = std::env::var("BACKGROUND_DIR")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("data/backgrounds"));
        let cookie_secure = std::env::var("COOKIE_SECURE")
            .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes"))
            .unwrap_or_else(|_| base_url.starts_with("https://"));
        let trust_proxy_headers = std::env::var("TRUST_PROXY_HEADERS")
            .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes"))
            .unwrap_or(false);
        Ok(Self {
            bind_addr,
            database_url,
            setup_token,
            base_url,
            static_dir,
            agent_image,
            agent_installer_url,
            agent_release_repository,
            agent_release_tag,
            cookie_secure,
            trust_proxy_headers,
            geoip_mmdb_path,
            background_dir,
        })
    }
}

fn validate_secure_http_url(name: &str, value: &str) -> anyhow::Result<()> {
    let parsed = reqwest::Url::parse(value).with_context(|| format!("{} 格式错误", name))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("{} 缺少主机名", name))?
        .trim_matches(|character| character == '[' || character == ']');
    let is_loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && is_loopback) {
        anyhow::bail!("{} 必须使用 HTTPS（仅本机回环地址允许 HTTP）", name);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        anyhow::bail!("{} 不能包含用户名或密码", name);
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        anyhow::bail!("{} 不能包含查询参数或片段", name);
    }
    Ok(())
}

struct GeoIp {
    reader: Reader<Vec<u8>>,
}

#[derive(Debug, Clone)]
struct GeoIpLocation {
    country: Option<String>,
    region: Option<String>,
    city: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

#[derive(Debug, Clone)]
struct GeoIpSettings {
    enabled: bool,
    provider: String,
    download_url: String,
}

#[derive(Debug, Deserialize)]
struct IpApiResponse {
    status: Option<String>,
    message: Option<String>,
    country: Option<String>,
    #[serde(rename = "regionName")]
    region_name: Option<String>,
    city: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct GeoJsResponse {
    country: Option<String>,
    region: Option<String>,
    city: Option<String>,
    latitude: Option<String>,
    longitude: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpInfoResponse {
    country: Option<String>,
    region: Option<String>,
    city: Option<String>,
    loc: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let config = Arc::new(Config::from_env()?);
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await
        .context("无法连接 PostgreSQL")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("数据库迁移失败")?;

    let geoip = Arc::new(RwLock::new(open_geoip(&config.geoip_mmdb_path)?));
    tokio::fs::create_dir_all(&config.background_dir)
        .await
        .context("无法创建背景图片目录")?;
    let state = AppState {
        pool,
        config: config.clone(),
        http: reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?,
        geoip,
        auth_limiter: Arc::new(AuthRateLimiter::default()),
        agent_limiter: Arc::new(AgentRateLimiter::default()),
        dummy_password_hash: Arc::new(
            hash_password("not-a-real-password-for-timing-only")
                .map_err(|err| anyhow::anyhow!(err.message))?,
        ),
    };

    spawn_housekeeping(state.clone());
    spawn_center_auto_location_refresh(state.clone());
    let app = build_router(state);
    let listener = TcpListener::bind(config.bind_addr).await?;
    info!("VPS Monitor server listening on {}", config.bind_addr);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

fn build_router(state: AppState) -> Router {
    let admin_routes = Router::new()
        .route("/me", get(admin_me))
        .route("/servers", get(admin_list_servers).post(admin_create_server))
        .route("/servers/:id", patch(admin_update_server).delete(admin_delete_server))
        .route("/servers/:id/rotate-token", post(admin_rotate_token))
        .route("/ping-targets", get(admin_list_ping_targets).post(admin_create_ping_target))
        .route("/ping-targets/:id", patch(admin_update_ping_target).delete(admin_delete_ping_target))
        .route("/settings", get(admin_get_settings).put(admin_update_settings))
        .route(
            "/settings/background",
            post(admin_upload_background)
                .delete(admin_delete_background)
                .layer(DefaultBodyLimit::max(MAX_BACKGROUND_IMAGE_BYTES + 1024 * 1024)),
        )
        .route("/settings/geoip/test", post(admin_test_geoip))
        .route("/settings/geoip/update", post(admin_refresh_geoip))
        .route("/alerts", get(admin_list_alerts))
        .layer(middleware::from_fn_with_state(state.clone(), admin_auth));

    let api = Router::new()
        .route("/health", get(health))
        .route("/bootstrap/status", get(bootstrap_status))
        .route("/bootstrap/register", post(bootstrap_register))
        .route("/auth/login", post(login))
        .route("/auth/reset-password", post(reset_admin_password))
        .route("/auth/logout", post(logout))
        .route("/public/summary", get(public_summary))
        .route("/public/servers/:id/history", get(public_server_history))
        .route("/public/ping-series", get(public_ping_series))
        .route("/agent/config", get(agent_config))
        .route("/agent/metrics", post(agent_metrics))
        .nest("/admin", admin_routes)
        .layer(DefaultBodyLimit::max(MAX_API_JSON_BYTES));

    let index = state.config.static_dir.join("index.html");
    Router::new()
        .route("/install.sh", get(agent_install_script))
        .route("/uninstall.sh", get(agent_uninstall_script))
        .nest("/api", api)
        .nest_service("/uploads", ServeDir::new(state.config.background_dir.clone()))
        .fallback_service(ServeDir::new(state.config.static_dir.clone()).fallback(ServeFile::new(index)))
        .layer(middleware::from_fn(security_headers))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn security_headers(req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("strict-transport-security"),
        HeaderValue::from_static("max-age=31536000"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "base-uri 'self'; default-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https://server.arcgisonline.com; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:",
        ),
    );
    if path.starts_with("/api/admin/")
        || path.starts_with("/api/auth/")
        || path.starts_with("/api/bootstrap/")
        || path.starts_with("/api/agent/")
    {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(HeaderName::from_static("pragma"), HeaderValue::from_static("no-cache"));
    }
    response
}

async fn health() -> Json<Value> {
    Json(json!({"ok": true, "service": "vps-monitor"}))
}

async fn agent_install_script(State(state): State<AppState>) -> Response {
    shell_script_response(agent_install_script_body(&state.config))
}

async fn agent_uninstall_script() -> Response {
    shell_script_response(agent_uninstall_script_body())
}

fn shell_script_response(script: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("text/x-shellscript; charset=utf-8")),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        script,
    )
        .into_response()
}

#[derive(Serialize)]
struct BootstrapStatus {
    has_admin: bool,
}

async fn bootstrap_status(State(state): State<AppState>) -> Result<Json<BootstrapStatus>, AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admins")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(BootstrapStatus { has_admin: count > 0 }))
}

#[derive(Deserialize)]
struct RegisterRequest {
    username: String,
    password: String,
    setup_token: String,
}

async fn bootstrap_register(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Value>, AppError> {
    let rate_key = auth_rate_key("register", &headers, peer, state.config.trust_proxy_headers);
    state.auth_limiter.check(&rate_key).await?;
    if req.setup_token != state.config.setup_token {
        state.auth_limiter.record_failure(&rate_key).await;
        return Err(AppError::unauthorized("SETUP_TOKEN 不正确"));
    }
    validate_username_password(&req.username, &req.password)?;

    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(862734901)")
        .execute(&mut *tx)
        .await?;
    let admin_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admins")
        .fetch_one(&mut *tx)
        .await?;
    if admin_count > 0 {
        return Err(AppError::bad_request("管理员已存在，注册入口已关闭"));
    }
    let hash = hash_password(&req.password)?;
    sqlx::query("INSERT INTO admins(username, password_hash) VALUES ($1, $2)")
        .bind(req.username.trim())
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.auth_limiter.clear(&rate_key).await;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Deserialize)]
struct ResetPasswordRequest {
    username: String,
    password: String,
    setup_token: String,
}

async fn reset_admin_password(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<ResetPasswordRequest>,
) -> Result<Json<Value>, AppError> {
    let rate_key = auth_rate_key("reset", &headers, peer, state.config.trust_proxy_headers);
    state.auth_limiter.check(&rate_key).await?;
    if req.setup_token != state.config.setup_token {
        state.auth_limiter.record_failure(&rate_key).await;
        return Err(AppError::unauthorized("SETUP_TOKEN 不正确"));
    }
    validate_username_password(&req.username, &req.password)?;

    let admin_id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM admins ORDER BY created_at ASC LIMIT 1")
        .fetch_optional(&state.pool)
        .await?;
    let Some(admin_id) = admin_id else {
        return Err(AppError::bad_request("尚未创建管理员，请先完成首次注册"));
    };

    let hash = hash_password(&req.password)?;
    sqlx::query("UPDATE admins SET username = $1, password_hash = $2 WHERE id = $3")
        .bind(req.username.trim())
        .bind(hash)
        .bind(admin_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM admin_sessions WHERE admin_id = $1")
        .bind(admin_id)
        .execute(&state.pool)
        .await?;

    state.auth_limiter.clear(&rate_key).await;
    Ok(Json(json!({"ok": true})))
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Result<Response, AppError> {
    validate_login_input(&req.username, &req.password)?;
    let rate_key = auth_rate_key("login", &headers, peer, state.config.trust_proxy_headers);
    state.auth_limiter.check(&rate_key).await?;
    let row = sqlx::query("SELECT id, password_hash FROM admins WHERE username = $1")
        .bind(req.username.trim())
        .fetch_optional(&state.pool)
        .await?;
    let password_hash = row
        .as_ref()
        .map(|value| value.get::<String, _>("password_hash"))
        .unwrap_or_else(|| state.dummy_password_hash.as_ref().clone());
    let valid = verify_password_matches(&req.password, &password_hash);
    if !valid || row.is_none() {
        state.auth_limiter.record_failure(&rate_key).await;
        return Err(AppError::unauthorized("用户名或密码错误"));
    }
    let row = row.expect("row was checked above");
    let admin_id: Uuid = row.get("id");

    let token = random_token();
    let token_hash = hash_secret(&token);
    let expires_at = Utc::now() + ChronoDuration::days(30);
    sqlx::query(
        "INSERT INTO admin_sessions(admin_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(admin_id)
    .bind(token_hash)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;
    state.auth_limiter.clear(&rate_key).await;

    let secure = if state.config.cookie_secure { "; Secure" } else { "" };
    let cookie = format!(
        "vps_monitor_session={}; Path=/; HttpOnly; SameSite=Strict; Max-Age={};{}",
        token,
        30 * 24 * 3600,
        secure
    );
    let mut res = Json(json!({"ok": true})).into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).map_err(|_| AppError::internal("Cookie 构造失败"))?);
    Ok(res)
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    if let Some(token) = extract_admin_token(&headers) {
        sqlx::query("DELETE FROM admin_sessions WHERE token_hash = $1")
            .bind(hash_secret(&token))
            .execute(&state.pool)
            .await?;
    }
    let mut res = Json(json!({"ok": true})).into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("vps_monitor_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
    );
    Ok(res)
}

async fn admin_me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, AppError> {
    let token = extract_admin_token(&headers).ok_or_else(|| AppError::unauthorized("未登录"))?;
    let row = sqlx::query(
        "SELECT a.username FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = $1 AND s.expires_at > now()",
    )
    .bind(hash_secret(&token))
    .fetch_optional(&state.pool)
    .await?;
    let username: String = row.ok_or_else(|| AppError::unauthorized("登录已过期"))?.get("username");
    Ok(Json(json!({ "username": username })))
}

async fn admin_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let token = extract_admin_token(&headers).ok_or_else(|| AppError::unauthorized("未登录"))?;
    let result = sqlx::query("UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1 AND expires_at > now() RETURNING id")
        .bind(hash_secret(&token))
        .fetch_optional(&state.pool)
        .await?;
    if result.is_none() {
        return Err(AppError::unauthorized("登录已过期"));
    }
    Ok(next.run(req).await)
}

#[derive(Deserialize)]
struct CreateServerRequest {
    name: String,
    note: Option<String>,
    server_group: Option<String>,
    public_ip: Option<String>,
}

async fn admin_create_server(
    State(state): State<AppState>,
    Json(req): Json<CreateServerRequest>,
) -> Result<Json<Value>, AppError> {
    let name = validate_required_text("服务器名称", &req.name, 100)?;
    let note = validate_optional_text("服务器备注", req.note.as_deref(), 2000)?;
    let public_ip = req
        .public_ip
        .as_deref()
        .map(str::trim)
        .filter(|ip| !ip.is_empty())
        .map(|ip| {
            let parsed = ip
                .parse::<IpAddr>()
                .map_err(|_| AppError::bad_request("公网 IP 格式不正确"))?;
            if !is_geoip_candidate(parsed) {
                return Err(AppError::bad_request("公网 IP 必须是可用于 GeoIP 的公网地址"));
            }
            Ok(ip.to_string())
        })
        .transpose()?;
    let token = random_token();
    let token_hash = hash_secret(&token);
    let server_group = clean_server_group(req.server_group.as_deref())?;
    let row = sqlx::query(
        "INSERT INTO servers(name, note, server_group, agent_token_hash, token_created_at, last_public_ip)
         VALUES ($1, $2, $3, $4, now(), $5)
         RETURNING id",
    )
    .bind(name)
    .bind(note)
    .bind(server_group)
    .bind(token_hash)
    .bind(public_ip.clone())
    .fetch_one(&state.pool)
    .await?;
    let id: Uuid = row.get("id");
    if let Some(ip) = public_ip.as_deref() {
        let settings = load_geoip_settings(&state.pool).await?;
        if let Err(err) = update_geoip_location(&state, &settings, id, ip).await {
            warn!(error = ?err, server_id = %id, ip = %ip, "服务器创建后预定位 GeoIP 失败");
        }
    }
    Ok(Json(json!({
        "server_id": id,
        "agent_token": token,
        "install_commands": install_commands(&state.config, &token),
        "install_command": install_command(&state.config, &token),
        "uninstall_commands": uninstall_commands(&state.config),
        "uninstall_command": uninstall_command(&state.config)
    })))
}

async fn admin_list_servers(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT s.*,
          m.cpu_usage, m.memory_total_bytes, m.memory_used_bytes, m.disk_total_bytes, m.disk_used_bytes,
          m.net_rx_bytes, m.net_tx_bytes, m.uptime_seconds, m.load1, m.load5, m.load15, m.captured_at,
          t.rx_bytes AS month_rx_bytes, t.tx_bytes AS month_tx_bytes,
          rate.net_rx_bps, rate.net_tx_bps,
          today.today_rx_bytes, today.today_tx_bytes
        FROM servers s
        LEFT JOIN LATERAL (
          SELECT * FROM metric_samples m
          WHERE m.server_id = s.id
          ORDER BY m.captured_at DESC
          LIMIT 1
        ) m ON true
        LEFT JOIN LATERAL (
          SELECT
            GREATEST(m.net_rx_bytes - p.net_rx_bytes, 0)::double precision
              / GREATEST(EXTRACT(EPOCH FROM (m.captured_at - p.captured_at)), 1) AS net_rx_bps,
            GREATEST(m.net_tx_bytes - p.net_tx_bytes, 0)::double precision
              / GREATEST(EXTRACT(EPOCH FROM (m.captured_at - p.captured_at)), 1) AS net_tx_bps
          FROM metric_samples p
          WHERE p.server_id = s.id AND p.captured_at < m.captured_at
          ORDER BY p.captured_at DESC
          LIMIT 1
        ) rate ON true
        LEFT JOIN LATERAL (
          SELECT
            GREATEST(latest.net_rx_bytes - earliest.net_rx_bytes, 0) AS today_rx_bytes,
            GREATEST(latest.net_tx_bytes - earliest.net_tx_bytes, 0) AS today_tx_bytes
          FROM (
            SELECT net_rx_bytes, net_tx_bytes
            FROM metric_samples
            WHERE server_id = s.id AND captured_at >= date_trunc('day', now())
            ORDER BY captured_at ASC
            LIMIT 1
          ) earliest
          CROSS JOIN (
            SELECT net_rx_bytes, net_tx_bytes
            FROM metric_samples
            WHERE server_id = s.id AND captured_at >= date_trunc('day', now())
            ORDER BY captured_at DESC
            LIMIT 1
          ) latest
        ) today ON true
        LEFT JOIN LATERAL (
          SELECT * FROM server_traffic_months tm
          WHERE tm.server_id = s.id
          ORDER BY tm.period_start DESC
          LIMIT 1
        ) t ON true
        ORDER BY s.display_order ASC, s.created_at ASC
        "#,
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!(rows.into_iter().map(|r| server_row_to_json(&r, &state.config)).collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct UpdateServerRequest {
    name: Option<String>,
    note: Option<String>,
    server_group: Option<String>,
    enabled: Option<bool>,
    public_visible: Option<bool>,
    display_order: Option<i32>,
    ping_mode: Option<String>,
    traffic_limit_bytes: Option<Option<i64>>,
    traffic_direction: Option<String>,
    traffic_reset_day: Option<i32>,
    location_country: Option<Option<String>>,
    location_region: Option<Option<String>>,
    location_city: Option<Option<String>>,
    latitude: Option<Option<f64>>,
    longitude: Option<Option<f64>>,
}

async fn admin_update_server(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateServerRequest>,
) -> Result<Json<Value>, AppError> {
    if let Some(mode) = &req.ping_mode {
        if mode != "inherit_append" && mode != "override" {
            return Err(AppError::bad_request("ping_mode 只能是 inherit_append 或 override"));
        }
    }
    if let Some(direction) = &req.traffic_direction {
        if !matches!(direction.as_str(), "up_down" | "download" | "upload") {
            return Err(AppError::bad_request("traffic_direction 不合法"));
        }
    }
    if let Some(day) = req.traffic_reset_day {
        if !(1..=28).contains(&day) {
            return Err(AppError::bad_request("traffic_reset_day 必须在 1-28 之间"));
        }
    }
    if req.traffic_limit_bytes.flatten().is_some_and(|value| value < 0) {
        return Err(AppError::bad_request("traffic_limit_bytes 不能为负数"));
    }
    let current = sqlx::query("SELECT * FROM servers WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("服务器不存在"))?;
    let name: String = req.name.unwrap_or_else(|| current.get("name"));
    let name = validate_required_text("服务器名称", &name, 100)?;
    let note: String = req.note.unwrap_or_else(|| current.get("note"));
    let note = validate_optional_text("服务器备注", Some(&note), 2000)?;
    let server_group: String = match req.server_group {
        Some(value) => clean_server_group(Some(&value))?,
        None => current.try_get("server_group").unwrap_or_default(),
    };
    let enabled: bool = req.enabled.unwrap_or_else(|| current.get("enabled"));
    let public_visible: bool = req.public_visible.unwrap_or_else(|| current.get("public_visible"));
    let display_order: i32 = req.display_order.unwrap_or_else(|| current.get("display_order"));
    let ping_mode: String = req.ping_mode.unwrap_or_else(|| current.get("ping_mode"));
    let traffic_limit_bytes: Option<i64> = req
        .traffic_limit_bytes
        .unwrap_or_else(|| current.try_get("traffic_limit_bytes").ok());
    let traffic_direction: String = req
        .traffic_direction
        .unwrap_or_else(|| current.get("traffic_direction"));
    let traffic_reset_day: i32 = req
        .traffic_reset_day
        .unwrap_or_else(|| current.get("traffic_reset_day"));
    let location_country: Option<String> = req
        .location_country
        .unwrap_or_else(|| current.try_get("location_country").ok());
    let location_region: Option<String> = req
        .location_region
        .unwrap_or_else(|| current.try_get("location_region").ok());
    let location_city: Option<String> = req
        .location_city
        .unwrap_or_else(|| current.try_get("location_city").ok());
    let latitude: Option<f64> = req.latitude.unwrap_or_else(|| current.try_get("latitude").ok());
    let longitude: Option<f64> = req.longitude.unwrap_or_else(|| current.try_get("longitude").ok());
    validate_optional_text("国家/地区", location_country.as_deref(), 100)?;
    validate_optional_text("省/州", location_region.as_deref(), 100)?;
    validate_optional_text("城市", location_city.as_deref(), 100)?;
    validate_coordinates(latitude, longitude)?;

    sqlx::query(
        r#"
        UPDATE servers SET
          name=$2, note=$3, server_group=$4, enabled=$5, public_visible=$6, display_order=$7,
          ping_mode=$8, traffic_limit_bytes=$9, traffic_direction=$10, traffic_reset_day=$11,
          location_country=$12, location_region=$13, location_city=$14, latitude=$15, longitude=$16,
          updated_at=now()
        WHERE id=$1
        "#,
    )
    .bind(id)
    .bind(name)
    .bind(note)
    .bind(server_group)
    .bind(enabled)
    .bind(public_visible)
    .bind(display_order)
    .bind(ping_mode)
    .bind(traffic_limit_bytes)
    .bind(traffic_direction)
    .bind(traffic_reset_day)
    .bind(location_country)
    .bind(location_region)
    .bind(location_city)
    .bind(latitude)
    .bind(longitude)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({"ok": true})))
}

async fn admin_delete_server(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"ok": true})))
}

async fn admin_rotate_token(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let token = random_token();
    let result = sqlx::query("UPDATE servers SET agent_token_hash=$2, token_created_at=now(), updated_at=now() WHERE id=$1")
        .bind(id)
        .bind(hash_secret(&token))
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found("服务器不存在"));
    }
    Ok(Json(json!({
        "agent_token": token,
        "install_commands": install_commands(&state.config, &token),
        "install_command": install_command(&state.config, &token),
        "uninstall_commands": uninstall_commands(&state.config),
        "uninstall_command": uninstall_command(&state.config)
    })))
}

#[derive(Deserialize)]
struct CreatePingTargetRequest {
    scope: String,
    server_id: Option<Uuid>,
    name: String,
    host: String,
    mode: String,
    tcp_port: Option<i32>,
    interval_seconds: Option<i32>,
    timeout_ms: Option<i32>,
    enabled: Option<bool>,
}

async fn admin_list_ping_targets(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query("SELECT * FROM ping_targets ORDER BY scope ASC, created_at ASC")
        .fetch_all(&state.pool)
        .await?;
    let values = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid,_>("id"),
                "scope": r.get::<String,_>("scope"),
                "server_id": r.try_get::<Uuid,_>("server_id").ok(),
                "name": r.get::<String,_>("name"),
                "host": r.get::<String,_>("host"),
                "mode": r.get::<String,_>("mode"),
                "tcp_port": r.try_get::<i32,_>("tcp_port").ok(),
                "interval_seconds": r.get::<i32,_>("interval_seconds"),
                "timeout_ms": r.get::<i32,_>("timeout_ms"),
                "enabled": r.get::<bool,_>("enabled")
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!(values)))
}

async fn admin_create_ping_target(
    State(state): State<AppState>,
    Json(req): Json<CreatePingTargetRequest>,
) -> Result<Json<Value>, AppError> {
    validate_ping_target(&req)?;
    enforce_ping_target_limit(&state.pool, &req.scope, req.server_id).await?;
    let row = sqlx::query(
        r#"
        INSERT INTO ping_targets(scope, server_id, name, host, mode, tcp_port, interval_seconds, timeout_ms, enabled)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING id
        "#,
    )
    .bind(&req.scope)
    .bind(req.server_id)
    .bind(req.name.trim())
    .bind(req.host.trim())
    .bind(&req.mode)
    .bind(req.tcp_port)
    .bind(req.interval_seconds.unwrap_or(30))
    .bind(req.timeout_ms.unwrap_or(1000))
    .bind(req.enabled.unwrap_or(true))
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({"id": row.get::<Uuid,_>("id")})))
}

async fn admin_update_ping_target(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<CreatePingTargetRequest>,
) -> Result<Json<Value>, AppError> {
    validate_ping_target(&req)?;
    let result = sqlx::query(
        r#"
        UPDATE ping_targets SET
          scope=$2, server_id=$3, name=$4, host=$5, mode=$6, tcp_port=$7,
          interval_seconds=$8, timeout_ms=$9, enabled=$10, updated_at=now()
        WHERE id=$1
        "#,
    )
    .bind(id)
    .bind(&req.scope)
    .bind(req.server_id)
    .bind(req.name.trim())
    .bind(req.host.trim())
    .bind(&req.mode)
    .bind(req.tcp_port)
    .bind(req.interval_seconds.unwrap_or(30))
    .bind(req.timeout_ms.unwrap_or(1000))
    .bind(req.enabled.unwrap_or(true))
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found("Ping 目标不存在"));
    }
    Ok(Json(json!({"ok": true})))
}

async fn admin_delete_ping_target(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    sqlx::query("DELETE FROM ping_targets WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"ok": true})))
}

async fn admin_get_settings(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query("SELECT key, value FROM settings ORDER BY key ASC")
        .fetch_all(&state.pool)
        .await?;
    let mut obj = serde_json::Map::new();
    for row in rows {
        obj.insert(row.get::<String, _>("key"), row.get::<Value, _>("value"));
    }
    let rules = sqlx::query("SELECT * FROM alert_rules ORDER BY key ASC")
        .fetch_all(&state.pool)
        .await?
        .into_iter()
        .map(|r| {
            json!({
                "key": r.get::<String,_>("key"),
                "label": r.get::<String,_>("label"),
                "enabled": r.get::<bool,_>("enabled"),
                "threshold": r.get::<f64,_>("threshold"),
                "duration_seconds": r.get::<i32,_>("duration_seconds"),
                "repeat_seconds": r.get::<i32,_>("repeat_seconds")
            })
        })
        .collect::<Vec<_>>();
    obj.insert("alert_rules".to_string(), json!(rules));
    Ok(Json(Value::Object(obj)))
}

#[derive(Deserialize)]
struct UpdateSettingsRequest {
    telegram: Option<Value>,
    public: Option<Value>,
    geoip: Option<Value>,
    alert_rules: Option<Vec<AlertRuleInput>>,
}

#[derive(Deserialize)]
struct AlertRuleInput {
    key: String,
    enabled: bool,
    threshold: f64,
    duration_seconds: i32,
    repeat_seconds: i32,
}

async fn admin_update_settings(
    State(state): State<AppState>,
    Json(req): Json<UpdateSettingsRequest>,
) -> Result<Json<Value>, AppError> {
    if let Some(telegram) = req.telegram {
        upsert_setting(&state.pool, "telegram", validate_telegram_settings(&telegram)?).await?;
    }
    if let Some(public) = req.public {
        validate_public_settings(&public)?;
        upsert_setting(&state.pool, "public", sanitize_public_settings(public)).await?;
    }
    if let Some(geoip) = req.geoip {
        let settings = parse_geoip_settings(&geoip)?;
        upsert_setting(
            &state.pool,
            "geoip",
            json!({
                "enabled": settings.enabled,
                "provider": settings.provider,
                "download_url": settings.download_url,
                "last_update_at": geoip.get("last_update_at").cloned().unwrap_or(Value::Null),
                "last_update_status": geoip.get("last_update_status").cloned().unwrap_or(Value::Null)
            }),
        )
        .await?;
    }
    if let Some(rules) = req.alert_rules {
        for rule in rules {
            validate_alert_rule(&rule)?;
            sqlx::query(
                "UPDATE alert_rules SET enabled=$2, threshold=$3, duration_seconds=$4, repeat_seconds=$5, updated_at=now() WHERE key=$1",
            )
            .bind(rule.key)
            .bind(rule.enabled)
            .bind(rule.threshold)
            .bind(rule.duration_seconds)
            .bind(rule.repeat_seconds)
            .execute(&state.pool)
            .await?;
        }
    }
    Ok(Json(json!({"ok": true})))
}

fn sanitize_public_settings(mut value: Value) -> Value {
    if !value.is_object() {
        value = json!({});
    }
    let refresh = value
        .get("refresh_interval_seconds")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_PUBLIC_REFRESH_SECONDS)
        .clamp(MIN_PUBLIC_REFRESH_SECONDS, MAX_PUBLIC_REFRESH_SECONDS);
    if let Value::Object(ref mut obj) = value {
        obj.insert("refresh_interval_seconds".to_string(), json!(refresh));
        if let Some(background) = obj.get_mut("background").and_then(Value::as_object_mut) {
            let image_url = background.get("image_url").and_then(Value::as_str).unwrap_or("");
            if !image_url.is_empty() && !is_background_image_url(image_url) {
                background.insert("image_url".to_string(), json!(""));
                background.insert("enabled".to_string(), json!(false));
            }
        }
    }
    value
}

fn clean_server_group(value: Option<&str>) -> Result<String, AppError> {
    let group = value.unwrap_or("").trim();
    if group.chars().count() > 40 {
        return Err(AppError::bad_request("节点分组不能超过 40 个字符"));
    }
    Ok(group.to_string())
}

async fn admin_upload_background(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    let mut uploaded = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::bad_request("背景图片上传数据无效"))?
    {
        if field.name() != Some("image") {
            continue;
        }
        let declared_type = field.content_type().unwrap_or("").to_string();
        let bytes = field
            .bytes()
            .await
            .map_err(|_| AppError::bad_request("无法读取背景图片"))?;
        if bytes.is_empty() {
            return Err(AppError::bad_request("背景图片不能为空"));
        }
        if bytes.len() > MAX_BACKGROUND_IMAGE_BYTES {
            return Err(AppError::bad_request("背景图片不能超过 12 MB"));
        }
        let (extension, mime) = detect_background_image(&bytes)
            .ok_or_else(|| AppError::bad_request("仅支持 JPEG、PNG 或 WebP 图片"))?;
        if !declared_type.is_empty()
            && !matches!(
                declared_type.as_str(),
                "image/jpeg" | "image/png" | "image/webp" | "application/octet-stream"
            )
        {
            return Err(AppError::bad_request("背景图片 MIME 类型不受支持"));
        }
        let filename = format!("background-{}.{}", Uuid::new_v4(), extension);
        let path = state.config.background_dir.join(&filename);
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|_| AppError::internal("保存背景图片失败"))?;
        remove_other_backgrounds(&state.config.background_dir, &filename).await?;
        uploaded = Some(json!({
            "image_url": format!("/uploads/{}", filename),
            "mime_type": mime,
            "size_bytes": bytes.len()
        }));
        break;
    }
    uploaded
        .map(Json)
        .ok_or_else(|| AppError::bad_request("请选择背景图片"))
}

async fn admin_delete_background(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    remove_other_backgrounds(&state.config.background_dir, "").await?;
    Ok(Json(json!({"ok": true})))
}

fn detect_background_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(("jpg", "image/jpeg"));
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(("png", "image/png"));
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(("webp", "image/webp"));
    }
    None
}

async fn remove_other_backgrounds(directory: &FsPath, keep: &str) -> Result<(), AppError> {
    let mut entries = tokio::fs::read_dir(directory)
        .await
        .map_err(|_| AppError::internal("读取背景图片目录失败"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|_| AppError::internal("读取背景图片目录失败"))?
    {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name != keep && name.starts_with("background-") {
            tokio::fs::remove_file(entry.path())
                .await
                .map_err(|_| AppError::internal("清理旧背景图片失败"))?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct GeoIpTestRequest {
    ip: String,
}

async fn admin_test_geoip(
    State(state): State<AppState>,
    Json(req): Json<GeoIpTestRequest>,
) -> Result<Json<Value>, AppError> {
    let ip = req.ip.trim();
    if ip.is_empty() {
        return Err(AppError::bad_request("IP 不能为空"));
    }
    let settings = load_geoip_settings(&state.pool).await?;
    let location = lookup_geoip_with_provider(&state, &settings, ip)
        .await?
        .ok_or_else(|| AppError::not_found("当前 Provider 没有返回可用 GeoIP 结果"))?;
    Ok(Json(json!({
        "provider": settings.provider,
        "ip": ip,
        "location": geoip_location_value(location)
    })))
}

async fn admin_refresh_geoip(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let settings = load_geoip_settings(&state.pool).await?;
    if !settings.enabled || settings.provider == "none" {
        upsert_geoip_status(&state.pool, "GeoIP 已禁用，未刷新").await?;
        return Ok(Json(json!({"updated": 0, "failed": 0, "message": "GeoIP 已禁用"})));
    }
    let database_message = if settings.provider == "maxmind" {
        Some(update_geoip_database(&state, &settings).await?)
    } else {
        None
    };
    let rows = sqlx::query("SELECT id, last_public_ip FROM servers WHERE last_public_ip IS NOT NULL")
        .fetch_all(&state.pool)
        .await?;
    let mut updated = 0_i32;
    let mut failed = 0_i32;
    for row in rows {
        let id: Uuid = row.get("id");
        let ip: String = row.get("last_public_ip");
        match update_geoip_location(&state, &settings, id, &ip).await {
            Ok(true) => updated += 1,
            Ok(false) => {}
            Err(err) => {
                failed += 1;
                warn!(server_id = %id, ip = %ip, error = ?err, "GeoIP 刷新失败");
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let center_settings = refresh_center_auto_location(&state, true).await?;
    let center_message = if center_location_mode(&center_settings) == "auto" {
        center_settings
            .get("center_auto_status")
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
            .map(|message| format!("；中心节点：{}", message))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let message = match database_message {
        Some(database_message) => format!("{}；GeoIP 缓存刷新完成：更新 {} 台，失败 {} 台", database_message, updated, failed),
        None => format!("GeoIP 缓存刷新完成：更新 {} 台，失败 {} 台", updated, failed),
    } + &center_message;
    upsert_geoip_status(&state.pool, &message).await?;
    Ok(Json(json!({"updated": updated, "failed": failed, "message": message})))
}

async fn admin_list_alerts(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT a.*, s.name AS server_name, r.label AS rule_label
        FROM alerts a
        JOIN servers s ON s.id = a.server_id
        JOIN alert_rules r ON r.key = a.rule_key
        ORDER BY a.triggered_at DESC
        LIMIT 300
        "#,
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!(rows.into_iter().map(|r| {
        json!({
            "id": r.get::<Uuid,_>("id"),
            "server_id": r.get::<Uuid,_>("server_id"),
            "server_name": r.get::<String,_>("server_name"),
            "rule_key": r.get::<String,_>("rule_key"),
            "rule_label": r.get::<String,_>("rule_label"),
            "state": r.get::<String,_>("state"),
            "severity": r.get::<String,_>("severity"),
            "value": r.try_get::<f64,_>("value").ok(),
            "message": r.get::<String,_>("message"),
            "triggered_at": r.get::<DateTime<Utc>,_>("triggered_at"),
            "resolved_at": r.try_get::<DateTime<Utc>,_>("resolved_at").ok(),
            "last_notified_at": r.try_get::<DateTime<Utc>,_>("last_notified_at").ok(),
            "notify_error": r.try_get::<String,_>("notify_error").ok()
        })
    }).collect::<Vec<_>>())))
}

async fn public_summary(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT s.*,
          m.cpu_usage, m.memory_total_bytes, m.memory_used_bytes, m.disk_total_bytes, m.disk_used_bytes,
          m.net_rx_bytes, m.net_tx_bytes, m.uptime_seconds, m.load1, m.load5, m.load15, m.captured_at,
          t.rx_bytes AS month_rx_bytes, t.tx_bytes AS month_tx_bytes,
          rate.net_rx_bps, rate.net_tx_bps,
          today.today_rx_bytes, today.today_tx_bytes
        FROM servers s
        LEFT JOIN LATERAL (
          SELECT * FROM metric_samples m
          WHERE m.server_id = s.id
          ORDER BY m.captured_at DESC
          LIMIT 1
        ) m ON true
        LEFT JOIN LATERAL (
          SELECT
            GREATEST(m.net_rx_bytes - p.net_rx_bytes, 0)::double precision
              / GREATEST(EXTRACT(EPOCH FROM (m.captured_at - p.captured_at)), 1) AS net_rx_bps,
            GREATEST(m.net_tx_bytes - p.net_tx_bytes, 0)::double precision
              / GREATEST(EXTRACT(EPOCH FROM (m.captured_at - p.captured_at)), 1) AS net_tx_bps
          FROM metric_samples p
          WHERE p.server_id = s.id AND p.captured_at < m.captured_at
          ORDER BY p.captured_at DESC
          LIMIT 1
        ) rate ON true
        LEFT JOIN LATERAL (
          SELECT
            GREATEST(latest.net_rx_bytes - earliest.net_rx_bytes, 0) AS today_rx_bytes,
            GREATEST(latest.net_tx_bytes - earliest.net_tx_bytes, 0) AS today_tx_bytes
          FROM (
            SELECT net_rx_bytes, net_tx_bytes
            FROM metric_samples
            WHERE server_id = s.id AND captured_at >= date_trunc('day', now())
            ORDER BY captured_at ASC
            LIMIT 1
          ) earliest
          CROSS JOIN (
            SELECT net_rx_bytes, net_tx_bytes
            FROM metric_samples
            WHERE server_id = s.id AND captured_at >= date_trunc('day', now())
            ORDER BY captured_at DESC
            LIMIT 1
          ) latest
        ) today ON true
        LEFT JOIN LATERAL (
          SELECT * FROM server_traffic_months tm
          WHERE tm.server_id = s.id
          ORDER BY tm.period_start DESC
          LIMIT 1
        ) t ON true
        WHERE s.enabled = true AND s.public_visible = true
        ORDER BY s.display_order ASC, s.created_at ASC
        "#,
    )
    .fetch_all(&state.pool)
    .await?;
    let targets = sqlx::query(
        r#"
        SELECT DISTINCT ON (pt.id) pt.id, pt.name, pt.host, pt.mode, pt.server_id
        FROM ping_targets pt
        LEFT JOIN servers s ON s.id = pt.server_id
        WHERE pt.enabled = true
          AND (
            pt.scope = 'global'
            OR (s.enabled = true AND s.public_visible = true)
          )
        ORDER BY pt.id
        "#,
    )
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|r| {
        json!({
            "id": r.get::<Uuid,_>("id"),
            "name": r.get::<String,_>("name"),
            "host": r.get::<String,_>("host"),
            "mode": r.get::<String,_>("mode"),
            "server_id": r.try_get::<Uuid,_>("server_id").ok()
        })
    })
    .collect::<Vec<_>>();
    let public_settings: Value = sqlx::query_scalar("SELECT value FROM settings WHERE key='public'")
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or_else(|| json!({}));
    let public_settings = resolve_public_settings(&state, public_settings).await?;
    Ok(Json(json!({
        "servers": rows.into_iter().map(|r| public_server_row_to_json(&r)).collect::<Vec<_>>(),
        "ping_targets": targets,
        "settings": public_settings
    })))
}

#[derive(Deserialize)]
struct PingSeriesQuery {
    server_id: Uuid,
    target_id: Option<Uuid>,
    range: Option<String>,
}

#[derive(Deserialize)]
struct MetricHistoryQuery {
    range: Option<String>,
}

async fn public_server_history(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<MetricHistoryQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_public_server_visible(&state.pool, id).await?;

    let range = q.range.as_deref().unwrap_or("24h");
    let since = match range {
        "1h" => Utc::now() - ChronoDuration::hours(1),
        "6h" => Utc::now() - ChronoDuration::hours(6),
        "24h" => Utc::now() - ChronoDuration::hours(24),
        "7d" => Utc::now() - ChronoDuration::days(7),
        "30d" => Utc::now() - ChronoDuration::days(30),
        _ => return Err(AppError::bad_request("range 不合法")),
    };
    let rows = sqlx::query(
        r#"
        SELECT bucket_at AS ts, cpu_avg, memory_used_avg_bytes, disk_used_avg_bytes,
               net_rx_last_bytes, net_tx_last_bytes, sample_count
        FROM metric_rollups_1m
        WHERE server_id=$1 AND bucket_at >= $2
        ORDER BY bucket_at ASC
        "#,
    )
    .bind(id)
    .bind(since)
    .fetch_all(&state.pool)
    .await?;
    let points = rows
        .into_iter()
        .map(|r| {
            json!({
                "ts": r.get::<DateTime<Utc>,_>("ts"),
                "cpu_usage": r.get::<f64,_>("cpu_avg"),
                "memory_used_bytes": r.get::<i64,_>("memory_used_avg_bytes"),
                "disk_used_bytes": r.get::<i64,_>("disk_used_avg_bytes"),
                "net_rx_bytes": r.get::<i64,_>("net_rx_last_bytes"),
                "net_tx_bytes": r.get::<i64,_>("net_tx_last_bytes"),
                "sample_count": r.get::<i32,_>("sample_count")
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({"range": range, "source": "1m", "points": points})))
}

async fn public_ping_series(
    State(state): State<AppState>,
    Query(q): Query<PingSeriesQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_public_server_visible(&state.pool, q.server_id).await?;

    let range = q.range.as_deref().unwrap_or("1h");
    let (since, source) = match range {
        "1h" => (Utc::now() - ChronoDuration::hours(1), "raw"),
        "6h" => (Utc::now() - ChronoDuration::hours(6), "raw"),
        "24h" => (Utc::now() - ChronoDuration::hours(24), "5m"),
        "7d" => (Utc::now() - ChronoDuration::days(7), "5m"),
        "30d" => (Utc::now() - ChronoDuration::days(30), "5m"),
        "180d" => (Utc::now() - ChronoDuration::days(180), "1h"),
        "365d" => (Utc::now() - ChronoDuration::days(365), "1h"),
        _ => return Err(AppError::bad_request("range 不合法")),
    };
    let data = match source {
        "raw" => {
            sqlx::query(
                r#"
                SELECT ps.checked_at AS ts,
                       ps.ping_target_id,
                       ps.target_name,
                       ps.host,
                       ps.mode,
                       ps.latency_ms AS avg_latency_ms,
                       CASE WHEN ps.success THEN 1 ELSE 0 END AS success_count,
                       CASE WHEN ps.success THEN 0 ELSE 1 END AS loss_count,
                       1 AS sample_count
                FROM ping_samples ps
                JOIN ping_targets pt ON pt.id=ps.ping_target_id
                  AND pt.enabled=true AND (pt.scope='global' OR pt.server_id=$1)
                WHERE ps.server_id=$1 AND ps.checked_at >= $2 AND ($3::uuid IS NULL OR ps.ping_target_id=$3)
                ORDER BY ps.checked_at ASC
                "#,
            )
            .bind(q.server_id)
            .bind(since)
            .bind(q.target_id)
            .fetch_all(&state.pool)
            .await?
        }
        "5m" => {
            sqlx::query(
                r#"
                SELECT pr.bucket_at AS ts, pr.ping_target_id, pr.target_name, pr.host, pr.mode,
                       pr.avg_latency_ms, pr.success_count, pr.loss_count, pr.sample_count
                FROM ping_rollups_5m pr
                JOIN ping_targets pt ON pt.id=pr.ping_target_id
                  AND pt.enabled=true AND (pt.scope='global' OR pt.server_id=$1)
                WHERE pr.server_id=$1 AND pr.bucket_at >= $2 AND ($3::uuid IS NULL OR pr.ping_target_id=$3)
                ORDER BY pr.bucket_at ASC
                "#,
            )
            .bind(q.server_id)
            .bind(since)
            .bind(q.target_id)
            .fetch_all(&state.pool)
            .await?
        }
        _ => {
            sqlx::query(
                r#"
                SELECT pr.bucket_at AS ts, pr.ping_target_id, pr.target_name, pr.host, pr.mode,
                       pr.avg_latency_ms, pr.success_count, pr.loss_count, pr.sample_count
                FROM ping_rollups_1h pr
                JOIN ping_targets pt ON pt.id=pr.ping_target_id
                  AND pt.enabled=true AND (pt.scope='global' OR pt.server_id=$1)
                WHERE pr.server_id=$1 AND pr.bucket_at >= $2 AND ($3::uuid IS NULL OR pr.ping_target_id=$3)
                ORDER BY pr.bucket_at ASC
                "#,
            )
            .bind(q.server_id)
            .bind(since)
            .bind(q.target_id)
            .fetch_all(&state.pool)
            .await?
        }
    };
    let points = data
        .into_iter()
        .map(|r| {
            let success: i32 = r.get("success_count");
            let loss: i32 = r.get("loss_count");
            let total = success + loss;
            let loss_rate = if total > 0 {
                loss as f64 * 100.0 / total as f64
            } else {
                0.0
            };
            json!({
                "ts": r.get::<DateTime<Utc>,_>("ts"),
                "target_id": r.try_get::<Uuid,_>("ping_target_id").ok(),
                "target_name": r.get::<String,_>("target_name"),
                "host": r.get::<String,_>("host"),
                "mode": r.get::<String,_>("mode"),
                "avg_latency_ms": r.try_get::<f64,_>("avg_latency_ms").ok(),
                "success_count": success,
                "loss_count": loss,
                "sample_count": r.get::<i32,_>("sample_count"),
                "loss_rate": loss_rate
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({"range": range, "source": source, "points": points})))
}

async fn ensure_public_server_visible(pool: &PgPool, id: Uuid) -> Result<(), AppError> {
    let visible = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM servers WHERE id=$1 AND enabled=true AND public_visible=true)",
    )
    .bind(id)
    .fetch_one(pool)
    .await?;
    if visible {
        Ok(())
    } else {
        Err(AppError::not_found("服务器不存在或未公开"))
    }
}

async fn agent_config(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let server = authenticate_agent_request(&state, &headers, peer).await?;
    let server_id: Uuid = server.get("id");
    state.agent_limiter.check_and_record(server_id).await?;
    let ping_mode: String = server.get("ping_mode");
    let rows = if ping_mode == "override" {
        sqlx::query("SELECT * FROM ping_targets WHERE enabled=true AND server_id=$1 ORDER BY created_at ASC")
            .bind(server_id)
            .fetch_all(&state.pool)
            .await?
    } else {
        sqlx::query(
            "SELECT * FROM ping_targets WHERE enabled=true AND (scope='global' OR server_id=$1) ORDER BY scope ASC, created_at ASC",
        )
        .bind(server_id)
        .fetch_all(&state.pool)
        .await?
    };
    let targets = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid,_>("id"),
                "name": r.get::<String,_>("name"),
                "host": r.get::<String,_>("host"),
                "mode": r.get::<String,_>("mode"),
                "tcp_port": r.try_get::<i32,_>("tcp_port").ok(),
                "interval_seconds": r.get::<i32,_>("interval_seconds"),
                "timeout_ms": r.get::<i32,_>("timeout_ms")
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "server_id": server_id,
        "system_interval_seconds": 2,
        "config_refresh_seconds": 30,
        "ping_targets": targets
    })))
}

#[derive(Deserialize)]
struct AgentMetricPayload {
    captured_at: Option<DateTime<Utc>>,
    system: SystemMetricPayload,
    system_info: Option<SystemInfoPayload>,
    ping_results: Option<Vec<PingResultPayload>>,
}

#[derive(Deserialize)]
struct SystemMetricPayload {
    cpu_usage: f64,
    memory_total_bytes: i64,
    memory_used_bytes: i64,
    disk_total_bytes: i64,
    disk_used_bytes: i64,
    net_rx_bytes: i64,
    net_tx_bytes: i64,
    uptime_seconds: i64,
    load1: f64,
    load5: f64,
    load15: f64,
    public_ip: Option<String>,
}

#[derive(Deserialize)]
struct SystemInfoPayload {
    hostname: Option<String>,
    os_name: Option<String>,
    kernel_version: Option<String>,
    arch: Option<String>,
}

#[derive(Deserialize)]
struct PingResultPayload {
    target_id: Option<Uuid>,
    checked_at: Option<DateTime<Utc>>,
    success: bool,
    latency_ms: Option<f64>,
    error: Option<String>,
}

async fn agent_metrics(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(mut payload): Json<AgentMetricPayload>,
) -> Result<Json<Value>, AppError> {
    let server = authenticate_agent_request(&state, &headers, peer).await?;
    let server_id: Uuid = server.get("id");
    state.agent_limiter.check_and_record(server_id).await?;
    let now = Utc::now();
    let captured_at = bounded_agent_timestamp(payload.captured_at, now);
    let public_ip = payload
        .system
        .public_ip
        .as_deref()
        .and_then(valid_public_ip)
        .or_else(|| request_public_ip(&headers, peer, state.config.trust_proxy_headers));
    payload.system_info = sanitize_system_info(payload.system_info);
    let memory_total = payload.system.memory_total_bytes.max(0);
    let disk_total = payload.system.disk_total_bytes.max(0);

    sqlx::query(
        r#"
        INSERT INTO metric_samples(
          server_id, captured_at, cpu_usage, memory_total_bytes, memory_used_bytes,
          disk_total_bytes, disk_used_bytes, net_rx_bytes, net_tx_bytes, uptime_seconds,
          load1, load5, load15, public_ip
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        "#,
    )
    .bind(server_id)
    .bind(captured_at)
    .bind(clamp_percent(payload.system.cpu_usage))
    .bind(memory_total)
    .bind(payload.system.memory_used_bytes.max(0).min(memory_total))
    .bind(disk_total)
    .bind(payload.system.disk_used_bytes.max(0).min(disk_total))
    .bind(payload.system.net_rx_bytes.max(0))
    .bind(payload.system.net_tx_bytes.max(0))
    .bind(payload.system.uptime_seconds.max(0))
    .bind(finite_nonnegative(payload.system.load1))
    .bind(finite_nonnegative(payload.system.load5))
    .bind(finite_nonnegative(payload.system.load15))
    .bind(public_ip.clone())
    .execute(&state.pool)
    .await?;

    if let Some(ip) = public_ip.as_deref() {
        if should_refresh_geoip(&server, ip) {
            let settings = load_geoip_settings(&state.pool).await?;
            update_geoip_location(&state, &settings, server_id, ip).await?;
        }
    }
    update_server_seen(&state.pool, server_id, now, public_ip.clone(), payload.system_info.as_ref()).await?;
    update_traffic(&state.pool, &server, &payload.system).await?;

    if let Some(results) = payload.ping_results {
        let allowed_rows = if server.get::<String, _>("ping_mode") == "override" {
            sqlx::query("SELECT id, name, host, mode FROM ping_targets WHERE enabled=true AND scope='server' AND server_id=$1")
                .bind(server_id)
                .fetch_all(&state.pool)
                .await?
        } else {
            sqlx::query("SELECT id, name, host, mode FROM ping_targets WHERE enabled=true AND (scope='global' OR (scope='server' AND server_id=$1))")
                .bind(server_id)
                .fetch_all(&state.pool)
                .await?
        };
        let allowed = allowed_rows
            .into_iter()
            .map(|row| {
                (
                    row.get::<Uuid, _>("id"),
                    (
                        row.get::<String, _>("name"),
                        row.get::<String, _>("host"),
                        row.get::<String, _>("mode"),
                    ),
                )
            })
            .collect::<HashMap<_, _>>();
        for ping in results.into_iter().take(MAX_AGENT_PING_RESULTS) {
            let Some(target_id) = ping.target_id else { continue };
            let Some((target_name, host, mode)) = allowed.get(&target_id) else { continue };
            let latency = ping
                .latency_ms
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value.min(60_000.0));
            sqlx::query(
                r#"
                INSERT INTO ping_samples(server_id, ping_target_id, target_name, host, mode, checked_at, success, latency_ms, error)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                "#,
            )
            .bind(server_id)
            .bind(target_id)
            .bind(target_name)
            .bind(host)
            .bind(mode)
            .bind(bounded_agent_timestamp(ping.checked_at, now))
            .bind(ping.success)
            .bind(latency)
            .bind(ping.error.map(|value| truncate_text(&value, 500)))
            .execute(&state.pool)
            .await?;
        }
    }

    Ok(Json(json!({"ok": true})))
}

fn spawn_housekeeping(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(err) = run_housekeeping(&state).await {
                warn!(error = ?err, "housekeeping failed");
            }
        }
    });
}

fn open_geoip(path: &FsPath) -> anyhow::Result<Option<GeoIp>> {
    if !path.exists() {
        info!(path = %path.display(), "GeoIP MMDB 文件不存在，可在后台点击更新下载");
        return Ok(None);
    }
    let reader = Reader::open_readfile(path)
        .with_context(|| format!("无法打开 GeoIP MMDB 文件：{}", path.display()))?;
    info!(path = %path.display(), "GeoIP MMDB 已加载");
    Ok(Some(GeoIp { reader }))
}

async fn update_geoip_database(state: &AppState, settings: &GeoIpSettings) -> Result<String, AppError> {
    let (download_client, download_url) = secure_geoip_download_client(&settings.download_url).await?;
    let mut response = download_client
        .get(download_url)
        .send()
        .await
        .map_err(|_| AppError::internal("GeoIP 数据库下载失败"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::internal(format!("GeoIP 数据库下载失败：HTTP {}", status)));
    }
    if let Some(length) = response.content_length() {
        if length as usize > MAX_GEOIP_DOWNLOAD_BYTES {
            return Err(AppError::bad_request("GeoIP 数据库下载文件过大，已拒绝"));
        }
    }
    let mut downloaded = Vec::with_capacity(
        response.content_length().unwrap_or(0).min(1024 * 1024) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::internal("GeoIP 数据库读取失败"))?
    {
        if downloaded.len().saturating_add(chunk.len()) > MAX_GEOIP_DOWNLOAD_BYTES {
            return Err(AppError::bad_request("GeoIP 数据库下载文件过大，已拒绝"));
        }
        downloaded.extend_from_slice(&chunk);
    }
    let database = decode_geoip_database(&settings.download_url, &downloaded)?;
    if database.is_empty() || database.len() > MAX_GEOIP_DATABASE_BYTES {
        return Err(AppError::bad_request("GeoIP 数据库解压后大小异常，已拒绝"));
    }

    let path = &state.config.geoip_mmdb_path;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| AppError::internal(format!("无法创建 GeoIP 数据目录：{}", err)))?;
    }
    let tmp_path = path.with_extension("mmdb.tmp");
    tokio::fs::write(&tmp_path, &database)
        .await
        .map_err(|err| AppError::internal(format!("无法写入 GeoIP 临时数据库：{}", err)))?;
    let reader = Reader::open_readfile(&tmp_path)
        .map_err(|err| AppError::internal(format!("下载的 GeoIP 数据库无法打开：{}", err)))?;
    tokio::fs::rename(&tmp_path, path)
        .await
        .map_err(|err| AppError::internal(format!("无法替换 GeoIP 数据库：{}", err)))?;
    {
        let mut geoip = state.geoip.write().await;
        *geoip = Some(GeoIp { reader });
    }

    Ok(format!(
        "MaxMind 兼容 MMDB 已更新到 {}，大小 {} MB",
        path.display(),
        database.len() / 1024 / 1024
    ))
}

fn decode_geoip_database(url: &str, bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    let is_gzip = url.ends_with(".gz") || bytes.starts_with(&[0x1f, 0x8b]);
    if !is_gzip {
        return Ok(bytes.to_vec());
    }
    let decoder = GzDecoder::new(bytes);
    let mut limited = decoder.take((MAX_GEOIP_DATABASE_BYTES + 1) as u64);
    let mut out = Vec::new();
    limited
        .read_to_end(&mut out)
        .map_err(|err| AppError::internal(format!("GeoIP 数据库解压失败：{}", err)))?;
    if out.len() > MAX_GEOIP_DATABASE_BYTES {
        return Err(AppError::bad_request("GeoIP 数据库解压后过大，已拒绝"));
    }
    Ok(out)
}

async fn update_geoip_location(
    state: &AppState,
    settings: &GeoIpSettings,
    server_id: Uuid,
    ip: &str,
) -> Result<bool, AppError> {
    let Some(location) = lookup_geoip_with_provider(state, settings, ip).await? else {
        return Ok(false);
    };
    sqlx::query(
        r#"
        UPDATE servers SET
          geoip_country=$2,
          geoip_region=$3,
          geoip_city=$4,
          geoip_latitude=$5,
          geoip_longitude=$6,
          geoip_updated_at=now(),
          updated_at=now()
        WHERE id=$1
        "#,
    )
    .bind(server_id)
    .bind(location.country)
    .bind(location.region)
    .bind(location.city)
    .bind(location.latitude)
    .bind(location.longitude)
    .execute(&state.pool)
    .await?;
    Ok(true)
}

async fn lookup_geoip_with_provider(
    state: &AppState,
    settings: &GeoIpSettings,
    ip: &str,
) -> Result<Option<GeoIpLocation>, AppError> {
    if !settings.enabled || settings.provider == "none" {
        return Ok(None);
    }
    let ip_addr: IpAddr = ip
        .parse()
        .map_err(|_| AppError::bad_request("IP 格式不合法"))?;
    if !is_geoip_candidate(ip_addr) {
        return Ok(None);
    }
    let location = match settings.provider.as_str() {
        "maxmind" => {
            let geoip = state.geoip.read().await;
            geoip.as_ref().and_then(|geoip| lookup_geoip_mmdb(geoip, ip_addr))
        }
        "ip-api" => lookup_ip_api(&state.http, ip).await?,
        "geojs" => lookup_geojs(&state.http, ip).await?,
        "ipinfo" => lookup_ipinfo(&state.http, ip).await?,
        _ => return Err(AppError::bad_request("GeoIP Provider 不合法")),
    };
    Ok(location)
}

fn lookup_geoip_mmdb(geoip: &GeoIp, ip: IpAddr) -> Option<GeoIpLocation> {
    let result = geoip.reader.lookup(ip).ok()?;
    let city = result.decode::<geoip2::City>().ok().flatten()?;
    let country = pick_name(&city.country.names).map(str::to_string);
    let region = city
        .subdivisions
        .first()
        .and_then(|subdivision| pick_name(&subdivision.names))
        .map(str::to_string);
    let city_name = pick_name(&city.city.names).map(str::to_string);
    Some(GeoIpLocation {
        country,
        region,
        city: city_name,
        latitude: city.location.latitude,
        longitude: city.location.longitude,
    })
}

async fn lookup_ip_api(client: &reqwest::Client, ip: &str) -> Result<Option<GeoIpLocation>, AppError> {
    let response = client
        .get(format!(
            "http://ip-api.com/json/{}?fields=status,message,country,regionName,city,lat,lon,query",
            ip
        ))
        .send()
        .await
        .map_err(|err| AppError::internal(format!("ip-api.com 请求失败：{}", err)))?;
    if response.status().as_u16() == 429 {
        return Err(AppError::bad_request("ip-api.com 触发限流，请稍后再试"));
    }
    let body = response
        .error_for_status()
        .map_err(|err| AppError::internal(format!("ip-api.com 返回错误：{}", err)))?
        .json::<IpApiResponse>()
        .await
        .map_err(|err| AppError::internal(format!("ip-api.com 响应解析失败：{}", err)))?;
    if body.status.as_deref() != Some("success") {
        warn!(message = ?body.message, "ip-api.com 未返回成功结果");
        return Ok(None);
    }
    Ok(Some(GeoIpLocation {
        country: body.country,
        region: body.region_name,
        city: body.city,
        latitude: body.lat,
        longitude: body.lon,
    }))
}

async fn lookup_geojs(client: &reqwest::Client, ip: &str) -> Result<Option<GeoIpLocation>, AppError> {
    let body = client
        .get(format!("https://get.geojs.io/v1/ip/geo/{}.json", ip))
        .send()
        .await
        .map_err(|err| AppError::internal(format!("geojs.io 请求失败：{}", err)))?
        .error_for_status()
        .map_err(|err| AppError::internal(format!("geojs.io 返回错误：{}", err)))?
        .json::<GeoJsResponse>()
        .await
        .map_err(|err| AppError::internal(format!("geojs.io 响应解析失败：{}", err)))?;
    Ok(Some(GeoIpLocation {
        country: body.country,
        region: body.region,
        city: body.city,
        latitude: body.latitude.and_then(|v| v.parse().ok()),
        longitude: body.longitude.and_then(|v| v.parse().ok()),
    }))
}

async fn lookup_ipinfo(client: &reqwest::Client, ip: &str) -> Result<Option<GeoIpLocation>, AppError> {
    let body = client
        .get(format!("https://ipinfo.io/{}/json", ip))
        .send()
        .await
        .map_err(|err| AppError::internal(format!("ipinfo.io 请求失败：{}", err)))?
        .error_for_status()
        .map_err(|err| AppError::internal(format!("ipinfo.io 返回错误：{}", err)))?
        .json::<IpInfoResponse>()
        .await
        .map_err(|err| AppError::internal(format!("ipinfo.io 响应解析失败：{}", err)))?;
    let (latitude, longitude) = parse_loc(body.loc.as_deref());
    Ok(Some(GeoIpLocation {
        country: body.country,
        region: body.region,
        city: body.city,
        latitude,
        longitude,
    }))
}

fn pick_name<'a>(names: &'a geoip2::Names<'a>) -> Option<&'a str> {
    names
        .simplified_chinese
        .or(names.english)
        .or(names.spanish)
        .or(names.french)
        .or(names.german)
}

async fn load_geoip_settings(pool: &PgPool) -> Result<GeoIpSettings, AppError> {
    let value: Value = sqlx::query_scalar("SELECT value FROM settings WHERE key='geoip'")
        .fetch_optional(pool)
        .await?
        .unwrap_or_else(|| json!({"enabled": true, "provider": "geojs", "download_url": DEFAULT_GEOIP_MMDB_URL}));
    parse_geoip_settings(&value)
}

fn parse_geoip_settings(value: &Value) -> Result<GeoIpSettings, AppError> {
    let enabled = value.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("geojs")
        .to_string();
    validate_geoip_provider(&provider)?;
    let download_url = value
        .get("download_url")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_GEOIP_MMDB_URL)
        .trim()
        .to_string();
    validate_geoip_download_url(&download_url)?;
    Ok(GeoIpSettings { enabled, provider, download_url })
}

fn validate_geoip_provider(provider: &str) -> Result<(), AppError> {
    if matches!(provider, "none" | "maxmind" | "ip-api" | "geojs" | "ipinfo") {
        Ok(())
    } else {
        Err(AppError::bad_request("GeoIP Provider 只能是 none、maxmind、ip-api、geojs 或 ipinfo"))
    }
}

fn validate_geoip_download_url(url: &str) -> Result<(), AppError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AppError::bad_request("GeoIP 数据库下载 URL 格式不正确"))?;
    if parsed.scheme() != "https" {
        return Err(AppError::bad_request("GeoIP 数据库下载 URL 必须使用 HTTPS"));
    }
    if parsed.username() != "" || parsed.password().is_some() || parsed.host_str().is_none() {
        return Err(AppError::bad_request("GeoIP 数据库下载 URL 不允许包含认证信息，且必须包含主机名"));
    }
    Ok(())
}

async fn secure_geoip_download_client(url: &str) -> Result<(reqwest::Client, reqwest::Url), AppError> {
    validate_geoip_download_url(url)?;
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AppError::bad_request("GeoIP 数据库下载 URL 格式不正确"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::bad_request("GeoIP 数据库下载 URL 缺少主机名"))?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addresses = lookup_host((host, port))
        .await
        .map_err(|_| AppError::bad_request("GeoIP 数据库下载主机无法解析"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|addr| !is_geoip_candidate(addr.ip())) {
        return Err(AppError::bad_request("GeoIP 数据库下载地址解析到了非公网 IP，已拒绝"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(host, addresses[0])
        .build()
        .map_err(|_| AppError::internal("无法创建 GeoIP 下载客户端"))?;
    Ok((client, parsed))
}

fn geoip_location_value(location: GeoIpLocation) -> Value {
    json!({
        "country": location.country,
        "region": location.region,
        "city": location.city,
        "latitude": location.latitude,
        "longitude": location.longitude
    })
}

fn parse_loc(loc: Option<&str>) -> (Option<f64>, Option<f64>) {
    let Some(loc) = loc else {
        return (None, None);
    };
    let mut parts = loc.split(',');
    let latitude = parts.next().and_then(|v| v.trim().parse::<f64>().ok());
    let longitude = parts.next().and_then(|v| v.trim().parse::<f64>().ok());
    (latitude, longitude)
}

fn spawn_center_auto_location_refresh(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if let Err(err) = refresh_center_auto_location(&state, true).await {
            warn!(error = ?err, "中心节点自动位置刷新失败");
        }
    });
}

async fn resolve_public_settings(state: &AppState, public_settings: Value) -> Result<Value, AppError> {
    let public_settings = sanitize_public_settings(public_settings);
    if center_location_mode(&public_settings) != "auto" {
        return Ok(public_settings);
    }
    let public_settings = if should_refresh_center_auto_location(&public_settings) {
        refresh_center_auto_location(state, false)
            .await
            .unwrap_or(public_settings)
    } else {
        public_settings
    };
    Ok(sanitize_public_settings(apply_center_auto_location(public_settings)))
}

async fn refresh_center_auto_location(state: &AppState, force: bool) -> Result<Value, AppError> {
    let mut public_settings: Value = sqlx::query_scalar("SELECT value FROM settings WHERE key='public'")
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or_else(|| json!({}));
    public_settings = sanitize_public_settings(public_settings);
    if center_location_mode(&public_settings) != "auto" {
        return Ok(public_settings);
    }
    if !force && !should_refresh_center_auto_location(&public_settings) {
        return Ok(public_settings);
    }
    let now = Utc::now();
    match detect_center_auto_location(state).await {
        Ok(Some((ip, location))) => {
            public_settings["center_auto_ip"] = json!(ip);
            public_settings["center_auto_country"] = json!(location.country);
            public_settings["center_auto_region"] = json!(location.region);
            public_settings["center_auto_city"] = json!(location.city);
            public_settings["center_auto_latitude"] = json!(location.latitude);
            public_settings["center_auto_longitude"] = json!(location.longitude);
            public_settings["center_auto_updated_at"] = json!(now);
            public_settings["center_auto_status"] = json!("中心端位置已自动更新");
        }
        Ok(None) => {
            public_settings["center_auto_updated_at"] = json!(now);
            public_settings["center_auto_status"] = json!("未能获取中心端公网 IP 或 GeoIP 位置");
        }
        Err(err) => {
            let message = err.message.clone();
            public_settings["center_auto_updated_at"] = json!(now);
            public_settings["center_auto_status"] = json!(format!("中心端自动定位失败：{}", message));
            warn!(error = ?err, "中心端自动定位失败");
        }
    }
    upsert_setting(&state.pool, "public", public_settings.clone()).await?;
    Ok(public_settings)
}

async fn detect_center_auto_location(state: &AppState) -> Result<Option<(String, GeoIpLocation)>, AppError> {
    let settings = load_geoip_settings(&state.pool).await?;
    if !settings.enabled || settings.provider == "none" {
        return Ok(None);
    }
    let Some(ip) = detect_center_public_ip(&state.http).await? else {
        return Ok(None);
    };
    let Some(location) = lookup_geoip_with_provider(state, &settings, &ip).await? else {
        return Ok(None);
    };
    Ok(Some((ip, location)))
}

async fn detect_center_public_ip(client: &reqwest::Client) -> Result<Option<String>, AppError> {
    let mut last_error = None;
    for url in ["https://api.ipify.org", "https://ifconfig.me/ip"] {
        let response = match client.get(url).send().await {
            Ok(response) => response,
            Err(err) => {
                last_error = Some(format!("{} 请求失败：{}", url, err));
                continue;
            }
        };
        let response = match response.error_for_status() {
            Ok(response) => response,
            Err(err) => {
                last_error = Some(format!("{} 返回错误：{}", url, err));
                continue;
            }
        };
        let text = match response.text().await {
            Ok(text) => text,
            Err(err) => {
                last_error = Some(format!("{} 响应读取失败：{}", url, err));
                continue;
            }
        };
        let candidate = text
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches(|ch| ch == '"' || ch == '\'');
        if let Ok(ip) = candidate.parse::<IpAddr>() {
            if is_geoip_candidate(ip) {
                return Ok(Some(candidate.to_string()));
            }
        }
    }
    if let Some(error) = last_error {
        warn!(error, "中心端公网 IP 检测未成功");
    }
    Ok(None)
}

fn center_location_mode(public_settings: &Value) -> &str {
    match public_settings
        .get("center_location_mode")
        .and_then(Value::as_str)
        .unwrap_or("auto")
    {
        "manual" => "manual",
        _ => "auto",
    }
}

fn should_refresh_center_auto_location(public_settings: &Value) -> bool {
    let updated_at = public_settings
        .get("center_auto_updated_at")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    updated_at
        .map(|time| Utc::now() - time > ChronoDuration::hours(CENTER_AUTO_LOCATION_TTL_HOURS))
        .unwrap_or(true)
}

fn apply_center_auto_location(mut public_settings: Value) -> Value {
    let latitude = public_settings.get("center_auto_latitude").cloned().unwrap_or(Value::Null);
    let longitude = public_settings.get("center_auto_longitude").cloned().unwrap_or(Value::Null);
    if !latitude.is_null() && !longitude.is_null() {
        public_settings["center_latitude"] = latitude;
        public_settings["center_longitude"] = longitude;
        let current_name = public_settings
            .get("center_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if current_name.is_empty() || current_name == "Center" {
            let auto_name = [
                public_settings.get("center_auto_city").and_then(Value::as_str),
                public_settings.get("center_auto_country").and_then(Value::as_str),
            ]
            .into_iter()
            .flatten()
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
            public_settings["center_name"] = json!(if auto_name.is_empty() { "中心节点".to_string() } else { auto_name });
        }
    }
    public_settings["center_location_mode"] = json!("auto");
    public_settings
}

fn should_refresh_geoip(server: &sqlx::postgres::PgRow, ip: &str) -> bool {
    let previous_ip = server.try_get::<String, _>("last_public_ip").ok();
    if previous_ip.as_deref() != Some(ip) {
        return true;
    }
    let updated_at = server.try_get::<DateTime<Utc>, _>("geoip_updated_at").ok();
    updated_at
        .map(|t| Utc::now() - t > ChronoDuration::days(7))
        .unwrap_or(true)
}

async fn upsert_geoip_status(pool: &PgPool, message: &str) -> Result<(), AppError> {
    let mut value: Value = sqlx::query_scalar("SELECT value FROM settings WHERE key='geoip'")
        .fetch_optional(pool)
        .await?
        .unwrap_or_else(|| json!({"enabled": true, "provider": "geojs", "download_url": DEFAULT_GEOIP_MMDB_URL}));
    value["last_update_at"] = json!(Utc::now());
    value["last_update_status"] = json!(message);
    upsert_setting(pool, "geoip", value).await
}

fn is_geoip_candidate(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
                || ip.is_documentation()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || ip.to_ipv4_mapped().is_some_and(|mapped| !is_geoip_candidate(IpAddr::V4(mapped))))
        }
    }
}

async fn run_housekeeping(state: &AppState) -> anyhow::Result<()> {
    rollup_metrics(&state.pool).await?;
    rollup_ping(&state.pool).await?;
    cleanup_history(&state.pool).await?;
    evaluate_alerts(state).await?;
    Ok(())
}

async fn rollup_metrics(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO metric_rollups_1m(server_id, bucket_at, cpu_avg, memory_used_avg_bytes, disk_used_avg_bytes, net_rx_last_bytes, net_tx_last_bytes, sample_count)
        SELECT server_id,
          to_timestamp(floor(extract(epoch from captured_at) / 60) * 60),
          avg(cpu_usage),
          avg(memory_used_bytes)::bigint,
          avg(disk_used_bytes)::bigint,
          max(net_rx_bytes),
          max(net_tx_bytes),
          count(*)::int
        FROM metric_samples
        WHERE captured_at >= now() - interval '2 days'
        GROUP BY server_id, to_timestamp(floor(extract(epoch from captured_at) / 60) * 60)
        ON CONFLICT (server_id, bucket_at) DO UPDATE SET
          cpu_avg=EXCLUDED.cpu_avg,
          memory_used_avg_bytes=EXCLUDED.memory_used_avg_bytes,
          disk_used_avg_bytes=EXCLUDED.disk_used_avg_bytes,
          net_rx_last_bytes=EXCLUDED.net_rx_last_bytes,
          net_tx_last_bytes=EXCLUDED.net_tx_last_bytes,
          sample_count=EXCLUDED.sample_count
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn rollup_ping(pool: &PgPool) -> anyhow::Result<()> {
    for (table, seconds) in [("ping_rollups_5m", 300_i64), ("ping_rollups_1h", 3600_i64)] {
        let sql = format!(
            r#"
            INSERT INTO {table}(server_id, ping_target_id, target_name, host, mode, bucket_at, avg_latency_ms, min_latency_ms, max_latency_ms, success_count, loss_count, sample_count)
            SELECT server_id, COALESCE(ping_target_id, '00000000-0000-0000-0000-000000000000'::uuid), max(target_name), max(host), max(mode),
              to_timestamp(floor(extract(epoch from checked_at) / {seconds}) * {seconds}),
              avg(latency_ms) FILTER (WHERE success AND latency_ms IS NOT NULL),
              min(latency_ms) FILTER (WHERE success AND latency_ms IS NOT NULL),
              max(latency_ms) FILTER (WHERE success AND latency_ms IS NOT NULL),
              count(*) FILTER (WHERE success)::int,
              count(*) FILTER (WHERE NOT success)::int,
              count(*)::int
            FROM ping_samples
            WHERE checked_at >= now() - interval '8 days'
            GROUP BY server_id, COALESCE(ping_target_id, '00000000-0000-0000-0000-000000000000'::uuid), to_timestamp(floor(extract(epoch from checked_at) / {seconds}) * {seconds})
            ON CONFLICT (server_id, ping_target_id, bucket_at) DO UPDATE SET
              target_name=EXCLUDED.target_name,
              host=EXCLUDED.host,
              mode=EXCLUDED.mode,
              avg_latency_ms=EXCLUDED.avg_latency_ms,
              min_latency_ms=EXCLUDED.min_latency_ms,
              max_latency_ms=EXCLUDED.max_latency_ms,
              success_count=EXCLUDED.success_count,
              loss_count=EXCLUDED.loss_count,
              sample_count=EXCLUDED.sample_count
            "#
        );
        sqlx::query(&sql).execute(pool).await?;
    }
    Ok(())
}

async fn cleanup_history(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM metric_samples WHERE captured_at < now() - interval '24 hours'")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM metric_rollups_1m WHERE bucket_at < now() - interval '30 days'")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM ping_samples WHERE checked_at < now() - interval '7 days'")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM ping_rollups_5m WHERE bucket_at < now() - interval '30 days'")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM ping_rollups_1h WHERE bucket_at < now() - interval '365 days'")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM alerts WHERE triggered_at < now() - interval '30 days' AND state='resolved'")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM admin_sessions WHERE expires_at < now()")
        .execute(pool)
        .await?;
    Ok(())
}

async fn evaluate_alerts(state: &AppState) -> anyhow::Result<()> {
    let servers = sqlx::query(
        r#"
        SELECT s.*,
          m.cpu_usage, m.memory_total_bytes, m.memory_used_bytes, m.disk_total_bytes, m.disk_used_bytes, m.captured_at,
          t.rx_bytes AS month_rx_bytes, t.tx_bytes AS month_tx_bytes
        FROM servers s
        LEFT JOIN LATERAL (
          SELECT * FROM metric_samples m WHERE m.server_id=s.id ORDER BY captured_at DESC LIMIT 1
        ) m ON true
        LEFT JOIN LATERAL (
          SELECT * FROM server_traffic_months tm WHERE tm.server_id=s.id ORDER BY period_start DESC LIMIT 1
        ) t ON true
        WHERE s.enabled = true
        "#,
    )
    .fetch_all(&state.pool)
    .await?;
    let rules = sqlx::query("SELECT * FROM alert_rules WHERE enabled=true")
        .fetch_all(&state.pool)
        .await?;
    for server in servers {
        let server_id: Uuid = server.get("id");
        let name: String = server.get("name");
        for rule in &rules {
            let key: String = rule.get("key");
            let threshold: f64 = rule.get("threshold");
            let duration_seconds: i32 = rule.get("duration_seconds");
            let active = match key.as_str() {
                "offline" => {
                    let last_seen = server.try_get::<DateTime<Utc>, _>("last_seen_at").ok();
                    last_seen.map(|t| (Utc::now() - t).num_seconds() as f64 > threshold).unwrap_or(true)
                }
                "cpu_high" => {
                    let avg: Option<f64> = sqlx::query_scalar(
                        "SELECT avg(cpu_usage) FROM metric_samples WHERE server_id=$1 AND captured_at >= now() - ($2::text || ' seconds')::interval",
                    )
                    .bind(server_id)
                    .bind(duration_seconds.max(60).to_string())
                    .fetch_optional(&state.pool)
                    .await?;
                    avg.unwrap_or(0.0) > threshold
                }
                "memory_high" => {
                    let total = server.try_get::<i64, _>("memory_total_bytes").unwrap_or(0);
                    let used = server.try_get::<i64, _>("memory_used_bytes").unwrap_or(0);
                    total > 0 && used as f64 * 100.0 / total as f64 > threshold
                }
                "disk_high" => {
                    let total = server.try_get::<i64, _>("disk_total_bytes").unwrap_or(0);
                    let used = server.try_get::<i64, _>("disk_used_bytes").unwrap_or(0);
                    total > 0 && used as f64 * 100.0 / total as f64 > threshold
                }
                "traffic_high" => {
                    let limit = server.try_get::<i64, _>("traffic_limit_bytes").ok();
                    let direction: String = server.get("traffic_direction");
                    let rx = server.try_get::<i64, _>("month_rx_bytes").unwrap_or(0);
                    let tx = server.try_get::<i64, _>("month_tx_bytes").unwrap_or(0);
                    let used = match direction.as_str() {
                        "download" => rx,
                        "upload" => tx,
                        _ => rx + tx,
                    };
                    limit.map(|l| l > 0 && used >= l).unwrap_or(false)
                }
                _ => false,
            };
            let value = latest_alert_value(&server, &key);
            let message = format_alert_message(&name, &key, value);
            set_alert_state(state, server_id, &key, active, value, message).await?;
        }
    }
    Ok(())
}

async fn set_alert_state(
    state: &AppState,
    server_id: Uuid,
    rule_key: &str,
    active: bool,
    value: Option<f64>,
    message: String,
) -> anyhow::Result<()> {
    let existing = sqlx::query(
        "SELECT id, last_notified_at FROM alerts WHERE server_id=$1 AND rule_key=$2 AND state='active' ORDER BY triggered_at DESC LIMIT 1",
    )
    .bind(server_id)
    .bind(rule_key)
    .fetch_optional(&state.pool)
    .await?;
    match (active, existing) {
        (true, None) => {
            let row = sqlx::query(
                "INSERT INTO alerts(server_id, rule_key, state, value, message) VALUES ($1,$2,'active',$3,$4) RETURNING id",
            )
            .bind(server_id)
            .bind(rule_key)
            .bind(value)
            .bind(&message)
            .fetch_one(&state.pool)
            .await?;
            notify_alert(state, row.get("id"), &message).await?;
        }
        (true, Some(row)) => {
            let alert_id: Uuid = row.get("id");
            let repeat: Option<i32> = sqlx::query_scalar("SELECT repeat_seconds FROM alert_rules WHERE key=$1")
                .bind(rule_key)
                .fetch_optional(&state.pool)
                .await?;
            let last = row.try_get::<DateTime<Utc>, _>("last_notified_at").ok();
            let should_repeat = last
                .map(|t| (Utc::now() - t).num_seconds() >= repeat.unwrap_or(3600) as i64)
                .unwrap_or(true);
            if should_repeat {
                notify_alert(state, alert_id, &message).await?;
            }
        }
        (false, Some(row)) => {
            let alert_id: Uuid = row.get("id");
            sqlx::query("UPDATE alerts SET state='resolved', resolved_at=now() WHERE id=$1")
                .bind(alert_id)
                .execute(&state.pool)
                .await?;
            notify_alert(state, alert_id, &format!("已恢复：{}", message)).await?;
        }
        (false, None) => {}
    }
    Ok(())
}

async fn notify_alert(state: &AppState, alert_id: Uuid, text: &str) -> anyhow::Result<()> {
    let settings: Value = sqlx::query_scalar("SELECT value FROM settings WHERE key='telegram'")
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or_else(|| json!({ "enabled": false }));
    let enabled = settings.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    let bot_token = settings.get("bot_token").and_then(Value::as_str).unwrap_or("");
    let chat_id = settings.get("chat_id").and_then(Value::as_str).unwrap_or("");
    if !enabled || bot_token.is_empty() || chat_id.is_empty() {
        return Ok(());
    }
    let template = settings
        .get("message_template")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("【{state}】{server}\n规则：{rule}\n当前值：{value}\n时间：{time}\n说明：{message}");
    let text = render_telegram_alert_message(&state.pool, alert_id, text, template).await?;
    let url = format!("https://api.telegram.org/bot{}/sendMessage", bot_token);
    let response = state
        .http
        .post(url)
        .json(&json!({ "chat_id": chat_id, "text": text }))
        .send()
        .await;
    match response {
        Ok(resp) if resp.status().is_success() => {
            sqlx::query("UPDATE alerts SET last_notified_at=now(), notify_error=NULL WHERE id=$1")
                .bind(alert_id)
                .execute(&state.pool)
                .await?;
        }
        Ok(resp) => {
            let err = format!("Telegram HTTP {}", resp.status());
            sqlx::query("UPDATE alerts SET notify_error=$2 WHERE id=$1")
                .bind(alert_id)
                .bind(err)
                .execute(&state.pool)
                .await?;
        }
        Err(_) => {
            sqlx::query("UPDATE alerts SET notify_error=$2 WHERE id=$1")
                .bind(alert_id)
                .bind("Telegram 请求发送失败")
                .execute(&state.pool)
                .await?;
        }
    }
    Ok(())
}

async fn render_telegram_alert_message(
    pool: &PgPool,
    alert_id: Uuid,
    fallback_message: &str,
    template: &str,
) -> anyhow::Result<String> {
    let row = sqlx::query(
        r#"
        SELECT a.rule_key, a.state, a.value, a.message, a.triggered_at, a.resolved_at,
               s.name AS server_name, r.label AS rule_label
        FROM alerts a
        JOIN servers s ON s.id = a.server_id
        JOIN alert_rules r ON r.key = a.rule_key
        WHERE a.id = $1
        "#,
    )
    .bind(alert_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(fallback_message.to_string());
    };
    let rule_key: String = row.get("rule_key");
    let state: String = row.get("state");
    let triggered_at: DateTime<Utc> = row.get("triggered_at");
    let resolved_at = row.try_get::<DateTime<Utc>, _>("resolved_at").ok();
    let values = [
        (
            "state",
            if state == "resolved" || fallback_message.starts_with("已恢复") {
                "恢复".to_string()
            } else {
                "触发".to_string()
            },
        ),
        ("server", row.get::<String, _>("server_name")),
        ("rule", telegram_rule_name(&rule_key, row.get::<String, _>("rule_label"))),
        (
            "value",
            row.try_get::<f64, _>("value")
                .ok()
                .map(format_alert_template_value)
                .unwrap_or_else(|| "-".to_string()),
        ),
        ("message", fallback_message.to_string()),
        (
            "time",
            resolved_at
                .unwrap_or(triggered_at)
                .format("%Y-%m-%d %H:%M:%S UTC")
                .to_string(),
        ),
    ];
    let mut rendered = template.to_string();
    for (key, value) in values {
        rendered = rendered.replace(&format!("{{{}}}", key), &value);
    }
    Ok(rendered)
}

fn telegram_rule_name(key: &str, fallback: String) -> String {
    match key {
        "offline" => "服务器离线".to_string(),
        "cpu_high" => "CPU 使用率过高".to_string(),
        "memory_high" => "内存使用率过高".to_string(),
        "disk_high" => "磁盘使用率过高".to_string(),
        "traffic_high" => "月流量超额".to_string(),
        _ => fallback,
    }
}

fn format_alert_template_value(value: f64) -> String {
    if value.abs() >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.2} GB", value / 1024.0 / 1024.0 / 1024.0)
    } else {
        format!("{:.1}", value)
    }
}

fn latest_alert_value(row: &sqlx::postgres::PgRow, key: &str) -> Option<f64> {
    match key {
        "cpu_high" => row.try_get("cpu_usage").ok(),
        "memory_high" => {
            let total = row.try_get::<i64, _>("memory_total_bytes").ok()?;
            let used = row.try_get::<i64, _>("memory_used_bytes").ok()?;
            (total > 0).then_some(used as f64 * 100.0 / total as f64)
        }
        "disk_high" => {
            let total = row.try_get::<i64, _>("disk_total_bytes").ok()?;
            let used = row.try_get::<i64, _>("disk_used_bytes").ok()?;
            (total > 0).then_some(used as f64 * 100.0 / total as f64)
        }
        "traffic_high" => {
            let rx = row.try_get::<i64, _>("month_rx_bytes").unwrap_or(0);
            let tx = row.try_get::<i64, _>("month_tx_bytes").unwrap_or(0);
            Some((rx + tx) as f64)
        }
        _ => None,
    }
}

fn format_alert_message(server_name: &str, key: &str, value: Option<f64>) -> String {
    match (key, value) {
        ("offline", _) => format!("告警：{} 离线超过阈值", server_name),
        ("cpu_high", Some(v)) => format!("告警：{} CPU 使用率过高，当前约 {:.1}%", server_name, v),
        ("memory_high", Some(v)) => format!("告警：{} 内存使用率过高，当前约 {:.1}%", server_name, v),
        ("disk_high", Some(v)) => format!("告警：{} 磁盘使用率过高，当前约 {:.1}%", server_name, v),
        ("traffic_high", Some(v)) => format!("告警：{} 月流量超过额度，当前约 {} bytes", server_name, v as i64),
        _ => format!("告警：{} {}", server_name, key),
    }
}

async fn update_server_seen(
    pool: &PgPool,
    server_id: Uuid,
    now: DateTime<Utc>,
    public_ip: Option<String>,
    info: Option<&SystemInfoPayload>,
) -> Result<(), AppError> {
    let hostname = info.and_then(|i| i.hostname.clone());
    let os_name = info.and_then(|i| i.os_name.clone());
    let kernel = info.and_then(|i| i.kernel_version.clone());
    let arch = info.and_then(|i| i.arch.clone());
    sqlx::query(
        r#"
        UPDATE servers SET
          last_seen_at=$2,
          last_public_ip=COALESCE($3, last_public_ip),
          last_hostname=COALESCE($4, last_hostname),
          last_os_name=COALESCE($5, last_os_name),
          last_kernel_version=COALESCE($6, last_kernel_version),
          last_arch=COALESCE($7, last_arch),
          updated_at=now()
        WHERE id=$1
        "#,
    )
    .bind(server_id)
    .bind(now)
    .bind(public_ip)
    .bind(hostname)
    .bind(os_name)
    .bind(kernel)
    .bind(arch)
    .execute(pool)
    .await?;
    Ok(())
}

async fn update_traffic(
    pool: &PgPool,
    server: &sqlx::postgres::PgRow,
    metric: &SystemMetricPayload,
) -> Result<(), AppError> {
    let server_id: Uuid = server.get("id");
    let reset_day: i32 = server.get("traffic_reset_day");
    let period_start = traffic_period_start(Utc::now(), reset_day);
    let row = sqlx::query("SELECT * FROM server_traffic_months WHERE server_id=$1 AND period_start=$2")
        .bind(server_id)
        .bind(period_start)
        .fetch_optional(pool)
        .await?;
    if let Some(row) = row {
        let last_rx = row.try_get::<i64, _>("last_rx_counter").ok();
        let last_tx = row.try_get::<i64, _>("last_tx_counter").ok();
        let rx_delta = sane_counter_delta(last_rx, metric.net_rx_bytes);
        let tx_delta = sane_counter_delta(last_tx, metric.net_tx_bytes);
        sqlx::query(
            r#"
            UPDATE server_traffic_months
            SET rx_bytes=rx_bytes+$3, tx_bytes=tx_bytes+$4, last_rx_counter=$5, last_tx_counter=$6, updated_at=now()
            WHERE server_id=$1 AND period_start=$2
            "#,
        )
        .bind(server_id)
        .bind(period_start)
        .bind(rx_delta)
        .bind(tx_delta)
        .bind(metric.net_rx_bytes)
        .bind(metric.net_tx_bytes)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO server_traffic_months(server_id, period_start, last_rx_counter, last_tx_counter)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (server_id, period_start) DO NOTHING
            "#,
        )
        .bind(server_id)
        .bind(period_start)
        .bind(metric.net_rx_bytes)
        .bind(metric.net_tx_bytes)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn sane_counter_delta(last: Option<i64>, current: i64) -> i64 {
    let Some(last) = last else { return 0 };
    if current >= last {
        let delta = current - last;
        if delta < 10_i64.pow(13) {
            delta
        } else {
            0
        }
    } else {
        0
    }
}

fn traffic_period_start(now: DateTime<Utc>, reset_day: i32) -> NaiveDate {
    let day = now.day() as i32;
    let (year, month) = if day >= reset_day {
        (now.year(), now.month())
    } else if now.month() == 1 {
        (now.year() - 1, 12)
    } else {
        (now.year(), now.month() - 1)
    };
    NaiveDate::from_ymd_opt(year, month, reset_day as u32).expect("reset_day 已限制在 1-28")
}

async fn authenticate_agent(pool: &PgPool, headers: &HeaderMap) -> Result<sqlx::postgres::PgRow, AppError> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth.strip_prefix("Bearer ").ok_or_else(|| AppError::unauthorized("缺少 Agent token"))?;
    let hash = hash_secret(token);
    let server = sqlx::query("SELECT * FROM servers WHERE agent_token_hash=$1 AND enabled=true")
        .bind(hash)
        .fetch_optional(pool)
        .await?;
    server.ok_or_else(|| AppError::unauthorized("Agent token 无效"))
}

async fn authenticate_agent_request(
    state: &AppState,
    headers: &HeaderMap,
    peer: SocketAddr,
) -> Result<sqlx::postgres::PgRow, AppError> {
    let rate_key = auth_rate_key("agent", headers, peer, state.config.trust_proxy_headers);
    state.auth_limiter.check(&rate_key).await?;
    match authenticate_agent(&state.pool, headers).await {
        Ok(server) => {
            state.auth_limiter.clear(&rate_key).await;
            Ok(server)
        }
        Err(error) => {
            state.auth_limiter.record_failure(&rate_key).await;
            Err(error)
        }
    }
}

fn server_row_to_json(r: &sqlx::postgres::PgRow, config: &Config) -> Value {
    let mut v = public_server_row_to_json(r);
    if let Value::Object(ref mut obj) = v {
        obj.insert("ip_full".to_string(), json!(r.try_get::<String, _>("last_public_ip").ok()));
        obj.insert("note".to_string(), json!(r.get::<String, _>("note")));
        obj.insert("group".to_string(), json!(r.try_get::<String, _>("server_group").unwrap_or_default()));
        obj.insert("enabled".to_string(), json!(r.get::<bool, _>("enabled")));
        obj.insert("traffic_limit_bytes".to_string(), json!(r.try_get::<i64, _>("traffic_limit_bytes").ok()));
        obj.insert("traffic_direction".to_string(), json!(r.get::<String, _>("traffic_direction")));
        obj.insert("traffic_reset_day".to_string(), json!(r.get::<i32, _>("traffic_reset_day")));
        obj.insert("ping_mode".to_string(), json!(r.get::<String, _>("ping_mode")));
        obj.insert("uninstall_commands".to_string(), json!(uninstall_commands(config)));
        obj.insert("uninstall_command".to_string(), json!(uninstall_command(config)));
        obj.insert("manual_location".to_string(), json!(manual_location_json(r)));
        obj.insert("geoip_location".to_string(), json!(geoip_location_json(r)));
    }
    v
}

fn public_server_row_to_json(r: &sqlx::postgres::PgRow) -> Value {
    let last_seen = r.try_get::<DateTime<Utc>, _>("last_seen_at").ok();
    let online = last_seen
        .map(|t| (Utc::now() - t).num_seconds() <= 60)
        .unwrap_or(false);
    let public_ip = r.try_get::<String, _>("last_public_ip").ok();
    let location = effective_location_json(r);
    json!({
        "id": r.get::<Uuid,_>("id"),
        "name": r.get::<String,_>("name"),
        "group": r.try_get::<String,_>("server_group").unwrap_or_default(),
        "online": online,
        "public_visible": r.get::<bool,_>("public_visible"),
        "last_seen_at": last_seen,
        "ip_masked": public_ip.as_deref().map(mask_ip),
        "hostname": r.try_get::<String,_>("last_hostname").ok(),
        "os_name": r.try_get::<String,_>("last_os_name").ok(),
        "kernel_version": r.try_get::<String,_>("last_kernel_version").ok(),
        "arch": r.try_get::<String,_>("last_arch").ok(),
        "location": location,
        "metrics": {
            "captured_at": r.try_get::<DateTime<Utc>,_>("captured_at").ok(),
            "cpu_usage": r.try_get::<f64,_>("cpu_usage").ok(),
            "memory_total_bytes": r.try_get::<i64,_>("memory_total_bytes").ok(),
            "memory_used_bytes": r.try_get::<i64,_>("memory_used_bytes").ok(),
            "disk_total_bytes": r.try_get::<i64,_>("disk_total_bytes").ok(),
            "disk_used_bytes": r.try_get::<i64,_>("disk_used_bytes").ok(),
            "net_rx_bytes": r.try_get::<i64,_>("net_rx_bytes").ok(),
            "net_tx_bytes": r.try_get::<i64,_>("net_tx_bytes").ok(),
            "month_rx_bytes": r.try_get::<i64,_>("month_rx_bytes").unwrap_or(0),
            "month_tx_bytes": r.try_get::<i64,_>("month_tx_bytes").unwrap_or(0),
            "today_rx_bytes": r.try_get::<i64,_>("today_rx_bytes").unwrap_or(0),
            "today_tx_bytes": r.try_get::<i64,_>("today_tx_bytes").unwrap_or(0),
            "net_rx_bps": r.try_get::<f64,_>("net_rx_bps").ok(),
            "net_tx_bps": r.try_get::<f64,_>("net_tx_bps").ok(),
            "uptime_seconds": r.try_get::<i64,_>("uptime_seconds").ok(),
            "load1": r.try_get::<f64,_>("load1").ok(),
            "load5": r.try_get::<f64,_>("load5").ok(),
            "load15": r.try_get::<f64,_>("load15").ok()
        }
    })
}

fn manual_location_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "country": r.try_get::<String,_>("location_country").ok(),
        "region": r.try_get::<String,_>("location_region").ok(),
        "city": r.try_get::<String,_>("location_city").ok(),
        "latitude": r.try_get::<f64,_>("latitude").ok(),
        "longitude": r.try_get::<f64,_>("longitude").ok()
    })
}

fn geoip_location_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "country": r.try_get::<String,_>("geoip_country").ok(),
        "region": r.try_get::<String,_>("geoip_region").ok(),
        "city": r.try_get::<String,_>("geoip_city").ok(),
        "latitude": r.try_get::<f64,_>("geoip_latitude").ok(),
        "longitude": r.try_get::<f64,_>("geoip_longitude").ok(),
        "updated_at": r.try_get::<DateTime<Utc>,_>("geoip_updated_at").ok()
    })
}

fn effective_location_json(r: &sqlx::postgres::PgRow) -> Value {
    let manual_country = r.try_get::<String, _>("location_country").ok();
    let manual_region = r.try_get::<String, _>("location_region").ok();
    let manual_city = r.try_get::<String, _>("location_city").ok();
    let manual_lat = r.try_get::<f64, _>("latitude").ok();
    let manual_lon = r.try_get::<f64, _>("longitude").ok();
    let geoip_country = r.try_get::<String, _>("geoip_country").ok();
    let geoip_region = r.try_get::<String, _>("geoip_region").ok();
    let geoip_city = r.try_get::<String, _>("geoip_city").ok();
    let geoip_lat = r.try_get::<f64, _>("geoip_latitude").ok();
    let geoip_lon = r.try_get::<f64, _>("geoip_longitude").ok();
    let has_manual = manual_country.is_some()
        || manual_region.is_some()
        || manual_city.is_some()
        || manual_lat.is_some()
        || manual_lon.is_some();
    let has_geoip = geoip_country.is_some()
        || geoip_region.is_some()
        || geoip_city.is_some()
        || geoip_lat.is_some()
        || geoip_lon.is_some();
    json!({
        "source": if has_manual { Some("manual") } else if has_geoip { Some("geoip") } else { None },
        "country": manual_country.or(geoip_country),
        "region": manual_region.or(geoip_region),
        "city": manual_city.or(geoip_city),
        "latitude": manual_lat.or(geoip_lat),
        "longitude": manual_lon.or(geoip_lon)
    })
}

fn mask_ip(ip: &str) -> String {
    if ip.contains('.') {
        let mut parts = ip.split('.').collect::<Vec<_>>();
        if parts.len() == 4 {
            parts[2] = "*";
            parts[3] = "*";
            return parts.join(".");
        }
    }
    if ip.contains(':') {
        let parts = ip.split(':').take(2).collect::<Vec<_>>();
        return format!("{}::*", parts.join(":"));
    }
    "***".to_string()
}

fn forwarded_ip_addr(headers: &HeaderMap) -> Option<IpAddr> {
    if let Some(value) = headers.get("x-real-ip").and_then(|value| value.to_str().ok()) {
        if let Ok(ip) = value.trim().parse::<IpAddr>() {
            return Some(ip);
        }
    }
    if let Some(value) = headers.get("x-forwarded-for").and_then(|value| value.to_str().ok()) {
        let nearest = value.split(',').next_back().unwrap_or(value).trim();
        if let Ok(ip) = nearest.parse::<IpAddr>() {
            return Some(ip);
        }
    }
    None
}

fn request_ip(headers: &HeaderMap, peer: SocketAddr, trust_proxy_headers: bool) -> IpAddr {
    if trust_proxy_headers {
        forwarded_ip_addr(headers).unwrap_or_else(|| peer.ip())
    } else {
        peer.ip()
    }
}

fn request_public_ip(headers: &HeaderMap, peer: SocketAddr, trust_proxy_headers: bool) -> Option<String> {
    let ip = request_ip(headers, peer, trust_proxy_headers);
    is_geoip_candidate(ip).then(|| ip.to_string())
}

fn auth_rate_key(action: &str, headers: &HeaderMap, peer: SocketAddr, trust_proxy_headers: bool) -> String {
    format!("{}:{}", action, request_ip(headers, peer, trust_proxy_headers))
}

fn valid_public_ip(value: &str) -> Option<String> {
    let ip = value.trim().parse::<IpAddr>().ok()?;
    is_geoip_candidate(ip).then(|| ip.to_string())
}

fn bounded_agent_timestamp(value: Option<DateTime<Utc>>, now: DateTime<Utc>) -> DateTime<Utc> {
    match value {
        Some(value)
            if value >= now - ChronoDuration::minutes(15)
                && value <= now + ChronoDuration::minutes(2) => value,
        _ => now,
    }
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|value| !value.is_control())
        .take(max_chars)
        .collect()
}

fn clean_optional_text(value: Option<String>, max_chars: usize) -> Option<String> {
    value
        .map(|value| truncate_text(&value, max_chars))
        .filter(|value| !value.is_empty())
}

fn sanitize_system_info(info: Option<SystemInfoPayload>) -> Option<SystemInfoPayload> {
    info.map(|info| SystemInfoPayload {
        hostname: clean_optional_text(info.hostname, 255),
        os_name: clean_optional_text(info.os_name, 255),
        kernel_version: clean_optional_text(info.kernel_version, 255),
        arch: clean_optional_text(info.arch, 64),
    })
}

fn finite_nonnegative(value: f64) -> f64 {
    if value.is_finite() { value.max(0.0).min(1_000_000.0) } else { 0.0 }
}

#[derive(Serialize)]
struct AgentCommandGroup {
    install: String,
    uninstall: String,
}

#[derive(Serialize)]
struct AgentCommands {
    docker: AgentCommandGroup,
    native: AgentCommandGroup,
}

fn install_commands(config: &Config, token: &str) -> AgentCommands {
    AgentCommands {
        docker: AgentCommandGroup {
            install: docker_install_command(config, token),
            uninstall: docker_uninstall_command(config),
        },
        native: AgentCommandGroup {
            install: native_install_command(config, token),
            uninstall: native_uninstall_command(config),
        },
    }
}

fn uninstall_commands(config: &Config) -> AgentCommands {
    AgentCommands {
        docker: AgentCommandGroup {
            install: String::new(),
            uninstall: docker_uninstall_command(config),
        },
        native: AgentCommandGroup {
            install: String::new(),
            uninstall: native_uninstall_command(config),
        },
    }
}

fn install_command(config: &Config, token: &str) -> String {
    docker_install_command(config, token)
}

fn docker_install_command(config: &Config, token: &str) -> String {
    format!(
        "wget -qO- {} | sudo bash -s -- -e {} -t {} -m docker -i {}",
        shell_quote(&config.agent_installer_url),
        shell_quote(&config.base_url),
        shell_quote(token),
        shell_quote(&config.agent_image)
    )
}

fn uninstall_command(config: &Config) -> String {
    docker_uninstall_command(config)
}

fn docker_uninstall_command(config: &Config) -> String {
    format!(
        "wget -qO- {} | sudo bash -s -- uninstall -m docker",
        shell_quote(&config.agent_installer_url)
    )
}

fn native_install_command(config: &Config, token: &str) -> String {
    let mut command = format!(
        "wget -qO- {} | sudo bash -s -- -e {} -t {}",
        shell_quote(&config.agent_installer_url),
        shell_quote(&config.base_url),
        shell_quote(token)
    );
    if !config.agent_release_repository.is_empty() {
        command.push_str(&format!(" -r {}", shell_quote(&config.agent_release_repository)));
    }
    if !config.agent_release_tag.is_empty() && config.agent_release_tag != "latest" {
        command.push_str(&format!(" --tag {}", shell_quote(&config.agent_release_tag)));
    }
    command
}

fn native_uninstall_command(config: &Config) -> String {
    format!(
        "wget -qO- {} | sudo bash -s -- uninstall -m native",
        shell_quote(&config.agent_installer_url)
    )
}

fn agent_install_script_body(_config: &Config) -> String {
    AGENT_INSTALLER_SCRIPT.to_string()
}

fn agent_uninstall_script_body() -> String {
    r#"#!/usr/bin/env bash
set -Eeuo pipefail

MODE=all

usage() {
  cat <<'USAGE'
VPS Monitor Agent uninstaller

Usage:
  uninstall.sh [-m docker|native|all]
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -m|--mode)
      MODE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 或 root 权限运行卸载脚本。" >&2
  exit 1
fi

uninstall_docker() {
  if command -v docker >/dev/null 2>&1; then
    docker rm -f vps-monitor-agent >/dev/null 2>&1 || true
  fi
}

uninstall_native() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now vps-monitor-agent >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/vps-monitor-agent.service
    systemctl daemon-reload || true
  fi
  rm -rf /opt/vps-monitor-agent
}

case "$MODE" in
  docker)
    uninstall_docker
    ;;
  native|systemd)
    uninstall_native
    ;;
  all)
    uninstall_docker
    uninstall_native
    ;;
  *)
    echo "卸载模式只能是 docker、native 或 all。" >&2
    exit 1
    ;;
esac

echo "VPS Monitor Agent 卸载完成。"
"#
    .to_string()
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn validate_username_password(username: &str, password: &str) -> Result<(), AppError> {
    let username_len = username.trim().chars().count();
    if username_len < 3 {
        return Err(AppError::bad_request("用户名至少 3 个字符"));
    }
    if username_len > 64 {
        return Err(AppError::bad_request("用户名不能超过 64 个字符"));
    }
    if password.chars().count() < 12 {
        return Err(AppError::bad_request("密码至少 12 个字符"));
    }
    if password.chars().count() > 1024 {
        return Err(AppError::bad_request("密码不能超过 1024 个字符"));
    }
    Ok(())
}

fn validate_login_input(username: &str, password: &str) -> Result<(), AppError> {
    if username.trim().is_empty() || username.trim().chars().count() > 64 || password.chars().count() > 1024 {
        return Err(AppError::bad_request("登录输入长度不合法"));
    }
    Ok(())
}

fn validate_required_text(field: &str, value: &str, max_chars: usize) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::bad_request(format!("{}不能为空", field)));
    }
    if value.chars().count() > max_chars || value.chars().any(char::is_control) {
        return Err(AppError::bad_request(format!("{}格式不合法或超过 {} 个字符", field, max_chars)));
    }
    Ok(value.to_string())
}

fn validate_optional_text(field: &str, value: Option<&str>, max_chars: usize) -> Result<String, AppError> {
    let value = value.unwrap_or("").trim();
    if value.chars().count() > max_chars || value.chars().any(|ch| ch.is_control() && ch != '\n' && ch != '\t') {
        return Err(AppError::bad_request(format!("{}格式不合法或超过 {} 个字符", field, max_chars)));
    }
    Ok(value.to_string())
}

fn validate_coordinates(latitude: Option<f64>, longitude: Option<f64>) -> Result<(), AppError> {
    if latitude.is_some() != longitude.is_some() {
        return Err(AppError::bad_request("纬度和经度必须同时填写或同时留空"));
    }
    if latitude.is_some_and(|value| !value.is_finite() || !(-90.0..=90.0).contains(&value)) {
        return Err(AppError::bad_request("纬度必须在 -90 到 90 之间"));
    }
    if longitude.is_some_and(|value| !value.is_finite() || !(-180.0..=180.0).contains(&value)) {
        return Err(AppError::bad_request("经度必须在 -180 到 180 之间"));
    }
    Ok(())
}

fn validate_telegram_settings(value: &Value) -> Result<Value, AppError> {
    let enabled = value.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    let bot_token = validate_optional_text("Telegram Bot Token", value.get("bot_token").and_then(Value::as_str), 256)?;
    let chat_id = validate_optional_text("Telegram Chat ID", value.get("chat_id").and_then(Value::as_str), 128)?;
    let message_template = validate_optional_text(
        "Telegram 消息模板",
        value.get("message_template").and_then(Value::as_str),
        4096,
    )?;
    if enabled && (bot_token.is_empty() || chat_id.is_empty()) {
        return Err(AppError::bad_request("启用 Telegram 通知时必须填写 Bot Token 和 Chat ID"));
    }
    if !bot_token.is_empty()
        && !bot_token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ':' | '_' | '-'))
    {
        return Err(AppError::bad_request("Telegram Bot Token 格式不合法"));
    }
    Ok(json!({
        "enabled": enabled,
        "bot_token": bot_token,
        "chat_id": chat_id,
        "message_template": message_template
    }))
}

fn validate_public_settings(value: &Value) -> Result<(), AppError> {
    let object = value.as_object().ok_or_else(|| AppError::bad_request("公开展示设置格式不正确"))?;
    validate_optional_text("站点名称", object.get("brand_name").and_then(Value::as_str), 100)?;
    validate_optional_text("中心节点名称", object.get("center_name").and_then(Value::as_str), 100)?;
    for key in ["center_auto_country", "center_auto_region", "center_auto_city", "center_auto_status"] {
        validate_optional_text(key, object.get(key).and_then(Value::as_str), 255)?;
    }
    if let Some(mode) = object.get("center_location_mode").and_then(Value::as_str) {
        if !matches!(mode, "auto" | "manual") {
            return Err(AppError::bad_request("center_location_mode 不合法"));
        }
    }
    for (key, allowed) in [
        ("default_language", &["zh", "en"][..]),
        ("default_map_mode", &["2d", "3d"][..]),
        ("default_server_view", &["table", "cards"][..]),
    ] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            if !allowed.contains(&value) {
                return Err(AppError::bad_request(format!("{} 不合法", key)));
            }
        }
    }
    validate_coordinates(
        object.get("center_latitude").and_then(Value::as_f64),
        object.get("center_longitude").and_then(Value::as_f64),
    )?;
    if let Some(background) = object.get("background").and_then(Value::as_object) {
        let image_url = background.get("image_url").and_then(Value::as_str).unwrap_or("");
        if !image_url.is_empty() && !is_background_image_url(image_url) {
            return Err(AppError::bad_request("背景图片地址必须来自本站上传目录"));
        }
        if let Some(fit) = background.get("fit").and_then(Value::as_str) {
            if !matches!(fit, "cover" | "contain") {
                return Err(AppError::bad_request("背景适配方式不合法"));
            }
        }
        if let Some(position) = background.get("position").and_then(Value::as_str) {
            if !matches!(position, "center" | "top" | "bottom" | "left" | "right") {
                return Err(AppError::bad_request("背景位置不合法"));
            }
        }
        for (key, min, max) in [("blur", 0.0, 40.0), ("brightness", 20.0, 160.0), ("overlay", 0.0, 100.0)] {
            if let Some(number) = background.get(key).and_then(Value::as_f64) {
                if !number.is_finite() || !(min..=max).contains(&number) {
                    return Err(AppError::bad_request(format!("背景参数 {} 超出允许范围", key)));
                }
            }
        }
    }
    Ok(())
}

fn is_background_image_url(value: &str) -> bool {
    let Some(name) = value.strip_prefix("/uploads/background-") else { return false };
    !name.contains('/')
        && name.len() <= 80
        && [".jpg", ".png", ".webp"].iter().any(|suffix| name.ends_with(suffix))
}

fn validate_alert_rule(rule: &AlertRuleInput) -> Result<(), AppError> {
    if !matches!(rule.key.as_str(), "offline" | "cpu_high" | "memory_high" | "disk_high" | "traffic_high") {
        return Err(AppError::bad_request("未知告警规则"));
    }
    if !rule.threshold.is_finite() || !(0.0..=1_000_000.0).contains(&rule.threshold) {
        return Err(AppError::bad_request("告警阈值不合法"));
    }
    if !(0..=86_400).contains(&rule.duration_seconds) {
        return Err(AppError::bad_request("告警持续时间必须在 0-86400 秒之间"));
    }
    if !(60..=2_592_000).contains(&rule.repeat_seconds) {
        return Err(AppError::bad_request("告警重复通知间隔必须在 60-2592000 秒之间"));
    }
    Ok(())
}

fn validate_ping_target(req: &CreatePingTargetRequest) -> Result<(), AppError> {
    if req.scope != "global" && req.scope != "server" {
        return Err(AppError::bad_request("scope 只能是 global 或 server"));
    }
    if req.scope == "global" && req.server_id.is_some() {
        return Err(AppError::bad_request("全局目标不能绑定 server_id"));
    }
    if req.scope == "server" && req.server_id.is_none() {
        return Err(AppError::bad_request("单机目标必须绑定 server_id"));
    }
    validate_required_text("Ping 目标名称", &req.name, 100)?;
    let host = validate_required_text("Ping host", &req.host, 253)?;
    if host.starts_with('-')
        || !host.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':'))
    {
        return Err(AppError::bad_request("Ping host 格式不合法，请填写 IP 或域名"));
    }
    if req.mode != "icmp" && req.mode != "tcp" {
        return Err(AppError::bad_request("mode 只能是 icmp 或 tcp"));
    }
    if req.mode == "tcp" && req.tcp_port.is_none() {
        return Err(AppError::bad_request("TCP Ping 必须设置 tcp_port"));
    }
    if req.tcp_port.is_some_and(|port| !(1..=65535).contains(&port)) {
        return Err(AppError::bad_request("tcp_port 必须在 1-65535 之间"));
    }
    if req.interval_seconds.is_some_and(|value| !(5..=3600).contains(&value)) {
        return Err(AppError::bad_request("interval_seconds 必须在 5-3600 之间"));
    }
    if req.timeout_ms.is_some_and(|value| !(100..=10000).contains(&value)) {
        return Err(AppError::bad_request("timeout_ms 必须在 100-10000 之间"));
    }
    Ok(())
}

async fn enforce_ping_target_limit(pool: &PgPool, scope: &str, server_id: Option<Uuid>) -> Result<(), AppError> {
    let count: i64 = if scope == "global" {
        sqlx::query_scalar("SELECT COUNT(*) FROM ping_targets WHERE scope='global'")
            .fetch_one(pool)
            .await?
    } else {
        sqlx::query_scalar("SELECT COUNT(*) FROM ping_targets WHERE scope='server' AND server_id=$1")
            .bind(server_id)
            .fetch_one(pool)
            .await?
    };
    if count >= 20 {
        return Err(AppError::bad_request("Ping 目标数量已达到 20 个上限"));
    }
    Ok(())
}

async fn upsert_setting(pool: &PgPool, key: &str, value: Value) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO settings(key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| AppError::internal("密码哈希失败"))
}

fn verify_password_matches(password: &str, password_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(password_hash) else { return false };
    Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hex::encode(hasher.finalize())
}

fn extract_admin_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return Some(token.to_string());
        }
    }
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie.split(';') {
        let trimmed = part.trim();
        if let Some(token) = trimmed.strip_prefix("vps_monitor_session=") {
            return Some(token.to_string());
        }
    }
    None
}

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: message.into() }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self { status: StatusCode::UNAUTHORIZED, message: message.into() }
    }

    fn too_many_requests(message: impl Into<String>) -> Self {
        Self { status: StatusCode::TOO_MANY_REQUESTS, message: message.into() }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, message: message.into() }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: message.into() }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(value: sqlx::Error) -> Self {
        error!(error = ?value, "database error");
        Self::internal("数据库错误")
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        error!(error = ?value, "internal error");
        Self::internal("内部错误")
    }
}

impl From<argon2::password_hash::Error> for AppError {
    fn from(_: argon2::password_hash::Error) -> Self {
        Self::internal("密码处理失败")
    }
}

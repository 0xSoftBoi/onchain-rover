use std::{
    collections::HashMap,
    io::{Read, Write},
    net::SocketAddr,
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::{
        header::{CACHE_CONTROL, CONTENT_TYPE},
        HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::{Parser, ValueEnum};
use futures_util::{SinkExt, StreamExt};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{sync::broadcast, time};
use tower_http::cors::CorsLayer;
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

const DEFAULT_DEADMAN_MS: u64 = 400;
const TELEMETRY_HZ: u64 = 10;
const DEFAULT_LIDAR_PORT: &str = "/dev/ttyACM0";
const DEFAULT_LIDAR_BAUD: u32 = 230_400;
const LIDAR_FRAME_LEN: usize = 47;
const LIDAR_POINTS_PER_FRAME: usize = 12;
const LIDAR_FRONT_CONE_DEG: f64 = 20.0;
const LIDAR_MIN_VALID_MM: u16 = 20;
const LIDAR_STALE_MS: u128 = 1_000;
const LIDAR_WINDOW_MS: u128 = 250;

#[derive(Debug, Parser)]
struct Opts {
    #[arg(long, env = "ROBOT_ROLE", default_value = "courier")]
    role: String,

    #[arg(long, env = "ROVER_LISTEN", default_value = "0.0.0.0:8000")]
    listen: SocketAddr,

    #[arg(long, env = "ROVER_MODE", value_enum, default_value_t = Mode::Sim)]
    mode: Mode,

    #[arg(long, env = "ROVER_SERIAL_PORT", default_value = "/dev/ttyTHS1")]
    serial_port: String,

    #[arg(long, env = "ROVER_SERIAL_BAUD", default_value_t = 115_200)]
    serial_baud: u32,

    #[arg(long, env = "ROVER_ALLOW_UNTOKENED_DRIVE", default_value_t = false)]
    allow_untokened_drive: bool,

    #[arg(long, env = "ROVER_DEADMAN_MS", default_value_t = DEFAULT_DEADMAN_MS)]
    deadman_ms: u64,

    #[arg(long, env = "ROVER_CAMERA_DEVICE")]
    camera_device: Option<String>,

    #[arg(long, env = "ROVER_CAMERA_STREAM_URL")]
    camera_stream_url: Option<String>,

    #[arg(long, env = "ROVER_CAMERA_SNAPSHOT_URL")]
    camera_snapshot_url: Option<String>,

    #[arg(long, env = "ROVER_LIDAR_PORT", default_value = DEFAULT_LIDAR_PORT)]
    lidar_port: String,

    #[arg(long, env = "ROVER_LIDAR_BAUD", default_value_t = DEFAULT_LIDAR_BAUD)]
    lidar_baud: u32,

    #[arg(long, env = "ROVER_LIDAR_ENABLED", default_value_t = true)]
    lidar_enabled: bool,

    #[arg(long, env = "ROVER_LIDAR_BLOCK_THRESHOLD_M", default_value_t = 0.30)]
    lidar_block_threshold_m: f64,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum Mode {
    Sim,
    Serial,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SpeedMode {
    Low,
    Medium,
    High,
}

impl Default for SpeedMode {
    fn default() -> Self {
        Self::Medium
    }
}

impl SpeedMode {
    fn cap(self) -> f64 {
        match self {
            SpeedMode::Low => 0.15,
            SpeedMode::Medium => 0.25,
            SpeedMode::High => 0.35,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct RawTelemetry {
    battery_v: Option<f64>,
    odometry_left: Option<f64>,
    odometry_right: Option<f64>,
    yaw: Option<f64>,
    accel: Option<[f64; 3]>,
    gyro: Option<[f64; 3]>,
    mag: Option<[f64; 3]>,
    source: &'static str,
    last_raw_frame_ms: Option<u128>,
}

#[derive(Debug, Clone)]
struct PilotSession {
    expires_at: Instant,
    not_before_epoch_ms: Option<u128>,
    speed_mode: SpeedMode,
}

#[derive(Debug, Clone)]
struct CommandState {
    left_cmd: f64,
    right_cmd: f64,
    last_cmd_at: Option<Instant>,
    active_session_id: Option<String>,
    speed_mode: SpeedMode,
    estop: bool,
    stopped_by_deadman: bool,
}

impl Default for CommandState {
    fn default() -> Self {
        Self {
            left_cmd: 0.0,
            right_cmd: 0.0,
            last_cmd_at: None,
            active_session_id: None,
            speed_mode: SpeedMode::default(),
            estop: false,
            stopped_by_deadman: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct TelemetryFrame {
    ts_ms: u128,
    robot: String,
    battery_v: Option<f64>,
    left_cmd: f64,
    right_cmd: f64,
    odometry_left: Option<f64>,
    odometry_right: Option<f64>,
    yaw: Option<f64>,
    session_id: Option<String>,
    deadman_ok: bool,
    estop: bool,
    stopped_by_deadman: bool,
    speed_mode: SpeedMode,
    max_speed: f64,
    last_raw_frame_ms: Option<u128>,
    raw_frame_age_ms: Option<u128>,
    camera: CameraStatus,
    lidar: LidarStatus,
    imu: ImuStatus,
    sensors: SensorSnapshot,
    source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct CameraStatus {
    status: &'static str,
    device: Option<String>,
    stream_url: Option<String>,
    snapshot_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct LidarStatus {
    status: &'static str,
    source: &'static str,
    port: Option<String>,
    front_m: Option<f64>,
    min_m: Option<f64>,
    blocked: bool,
    points: usize,
    last_frame_ms: Option<u128>,
    age_ms: Option<u128>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct LidarReading {
    status: &'static str,
    source: &'static str,
    port: Option<String>,
    front_m: Option<f64>,
    min_m: Option<f64>,
    blocked: bool,
    points: usize,
    last_frame_ms: Option<u128>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct BatteryStatus {
    status: &'static str,
    voltage_v: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct RawFrameStatus {
    status: &'static str,
    source: &'static str,
    last_ms: Option<u128>,
    age_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize)]
struct SensorSnapshot {
    battery: BatteryStatus,
    odometry: OdometryStatus,
    imu: ImuStatus,
    lidar: LidarStatus,
    camera: CameraStatus,
    raw_frame: RawFrameStatus,
}

#[derive(Debug, Clone, Serialize)]
struct ImuStatus {
    status: &'static str,
    accel: Option<[f64; 3]>,
    gyro: Option<[f64; 3]>,
    mag: Option<[f64; 3]>,
    yaw: Option<f64>,
}

trait RoverControl: Send + Sync {
    fn drive(&self, left: f64, right: f64) -> Result<()>;

    fn stop(&self) -> Result<()> {
        self.drive(0.0, 0.0)
    }
}

struct SimRover;

impl RoverControl for SimRover {
    fn drive(&self, left: f64, right: f64) -> Result<()> {
        debug!(left, right, "sim drive");
        Ok(())
    }
}

struct SerialRover {
    writer: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
}

impl SerialRover {
    fn open(
        port_path: &str,
        baud: u32,
        raw: Arc<RwLock<RawTelemetry>>,
    ) -> Result<Arc<dyn RoverControl>> {
        let port = serialport::new(port_path, baud)
            .timeout(Duration::from_millis(200))
            .open()
            .with_context(|| format!("open serial port {port_path} @ {baud}"))?;
        let mut reader = port
            .try_clone()
            .with_context(|| format!("clone serial port reader for {port_path}"))?;

        let writer = Arc::new(Mutex::new(port));
        let request_writer = writer.clone();

        thread::spawn(move || {
            let mut line = Vec::with_capacity(512);
            let mut byte = [0_u8; 1];
            loop {
                match reader.read(&mut byte) {
                    Ok(0) => continue,
                    Ok(_) if byte[0] == b'\n' => {
                        if let Ok(text) = std::str::from_utf8(&line) {
                            if let Some(parsed) = parse_esp32_telemetry(text.trim()) {
                                merge_raw_telemetry(&mut raw.write(), parsed);
                            }
                        }
                        line.clear();
                    }
                    Ok(_) => {
                        if line.len() < 2048 {
                            line.push(byte[0]);
                        } else {
                            line.clear();
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(err) => {
                        warn!(?err, "serial read failed");
                        thread::sleep(Duration::from_millis(250));
                    }
                }
            }
        });

        thread::spawn(move || {
            let mut tick = 0_u64;
            loop {
                let request = if tick % 10 == 0 {
                    json!({"T": 126}).to_string()
                } else {
                    json!({"T": 130}).to_string()
                } + "\n";
                {
                    let mut writer = request_writer.lock();
                    if let Err(err) = writer.write_all(request.as_bytes()) {
                        warn!(?err, "serial telemetry request failed");
                    } else if let Err(err) = writer.flush() {
                        warn!(?err, "serial telemetry request flush failed");
                    }
                }
                tick = tick.wrapping_add(1);
                thread::sleep(Duration::from_millis(100));
            }
        });

        Ok(Arc::new(Self { writer }))
    }
}

impl RoverControl for SerialRover {
    fn drive(&self, left: f64, right: f64) -> Result<()> {
        let line = json!({"T": 1, "L": left, "R": right}).to_string() + "\n";
        let mut writer = self.writer.lock();
        writer
            .write_all(line.as_bytes())
            .context("write drive command")?;
        writer.flush().context("flush drive command")?;
        Ok(())
    }
}

#[derive(Clone)]
struct AppState {
    role: String,
    mode: Mode,
    serial_port: String,
    started_at: Instant,
    rover: Arc<dyn RoverControl>,
    raw: Arc<RwLock<RawTelemetry>>,
    command: Arc<Mutex<CommandState>>,
    sessions: Arc<Mutex<HashMap<String, PilotSession>>>,
    telemetry_tx: broadcast::Sender<TelemetryFrame>,
    allow_untokened_drive: bool,
    deadman_ms: u64,
    camera_client: reqwest::Client,
    camera_device: Option<String>,
    camera_stream_url: Option<String>,
    camera_snapshot_url: Option<String>,
    lidar: Arc<RwLock<LidarReading>>,
}

#[derive(Debug, Deserialize)]
struct PilotTokenReq {
    token: String,
    ttl_secs: Option<f64>,
    #[serde(default)]
    speed_mode: SpeedMode,
    not_before_epoch_ms: Option<u128>,
}

#[derive(Debug, Serialize)]
struct PilotTokenResp {
    ok: bool,
    expires_in_secs: f64,
    speed_mode: SpeedMode,
    max_speed: f64,
}

#[derive(Debug, Deserialize)]
struct SpeedModeReq {
    token: String,
    speed_mode: SpeedMode,
}

#[derive(Debug, Deserialize)]
struct DriveReq {
    left: f64,
    right: f64,
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WsDriveMsg {
    left: Option<f64>,
    right: Option<f64>,
    token: Option<String>,
    #[serde(rename = "t")]
    client_ts_ms: Option<u128>,
}

#[derive(Debug, Serialize)]
struct HealthResp {
    ok: bool,
    role: String,
    mode: String,
    serial_port: String,
    uptime_secs: u64,
    battery_v: Option<f64>,
    active_session: Option<String>,
    estop: bool,
    deadman_ms: u64,
}

#[derive(Debug, Serialize)]
struct CapabilitiesResp {
    ok: bool,
    role: String,
    mode: String,
    serial_port: String,
    deadman_ms: u64,
    allow_untokened_drive: bool,
    camera: CameraStatus,
    endpoints: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
struct SensorsResp {
    ok: bool,
    role: String,
    ts_ms: u128,
    source: &'static str,
    battery_v: Option<f64>,
    odometry: OdometryStatus,
    imu: ImuStatus,
    lidar: LidarStatus,
    camera: CameraStatus,
    last_raw_frame_ms: Option<u128>,
    raw_frame_age_ms: Option<u128>,
    sensors: SensorSnapshot,
}

#[derive(Debug, Clone, Serialize)]
struct OdometryStatus {
    status: &'static str,
    left: Option<f64>,
    right: Option<f64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let opts = Opts::parse();
    let raw = Arc::new(RwLock::new(initial_raw_telemetry(opts.mode)));
    let lidar = Arc::new(RwLock::new(initial_lidar_reading(
        opts.mode,
        &opts.lidar_port,
        opts.lidar_block_threshold_m,
    )));
    let command = Arc::new(Mutex::new(CommandState::default()));

    let rover: Arc<dyn RoverControl> = match opts.mode {
        Mode::Sim => Arc::new(SimRover),
        Mode::Serial => SerialRover::open(&opts.serial_port, opts.serial_baud, raw.clone())?,
    };
    let (telemetry_tx, _) = broadcast::channel(128);
    let camera_client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .build()
        .context("build camera proxy client")?;

    let state = AppState {
        role: opts.role,
        mode: opts.mode,
        serial_port: opts.serial_port,
        started_at: Instant::now(),
        rover,
        raw,
        command,
        sessions: Arc::new(Mutex::new(HashMap::new())),
        telemetry_tx,
        allow_untokened_drive: opts.allow_untokened_drive,
        deadman_ms: opts.deadman_ms,
        camera_client,
        camera_device: opts.camera_device,
        camera_stream_url: opts.camera_stream_url,
        camera_snapshot_url: opts.camera_snapshot_url,
        lidar,
    };

    spawn_deadman(state.clone());
    spawn_telemetry_loop(state.clone());
    if matches!(state.mode, Mode::Sim) {
        spawn_sim_telemetry_loop(state.clone());
    }
    if matches!(state.mode, Mode::Serial) && opts.lidar_enabled {
        spawn_lidar_reader(
            state.lidar.clone(),
            opts.lidar_port.clone(),
            opts.lidar_baud,
            opts.lidar_block_threshold_m,
        );
    }

    let app = Router::new()
        .route("/capabilities", get(capabilities))
        .route("/health", get(health))
        .route("/telemetry", get(telemetry))
        .route("/sensors", get(sensors))
        .route("/stop", post(stop))
        .route("/estop", post(estop))
        .route("/estop/reset", post(estop_reset))
        .route("/drive", post(drive))
        .route("/motors/drive", post(drive))
        .route("/motors/stop", post(motors_stop))
        .route("/camera/status", get(camera_status))
        .route("/camera/snapshot", get(camera_snapshot))
        .route("/pilot/authorize", post(pilot_authorize))
        .route("/pilot/speed-mode", post(pilot_speed_mode))
        .route("/stream", get(stream))
        .route("/ws/drive", get(ws_drive))
        .route("/ws/telemetry", get(ws_telemetry))
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(opts.listen).await?;
    info!(addr = %opts.listen, mode = ?opts.mode, "rover harness listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(state))
        .await?;
    Ok(())
}

async fn shutdown_signal(state: AppState) {
    if let Err(err) = tokio::signal::ctrl_c().await {
        error!(?err, "failed to install ctrl-c handler");
    }
    if let Err(err) = state.rover.stop() {
        error!(?err, "failed to stop rover on shutdown");
    }
}

async fn capabilities(State(state): State<AppState>) -> Json<CapabilitiesResp> {
    Json(CapabilitiesResp {
        ok: true,
        role: state.role.clone(),
        mode: mode_name(state.mode).to_string(),
        serial_port: state.serial_port.clone(),
        deadman_ms: state.deadman_ms,
        allow_untokened_drive: state.allow_untokened_drive,
        camera: camera_status_for(&state),
        endpoints: vec![
            "GET /capabilities",
            "GET /health",
            "GET /telemetry",
            "GET /sensors",
            "GET /camera/status",
            "GET /camera/snapshot",
            "GET /stream",
            "POST /pilot/authorize",
            "POST /pilot/speed-mode",
            "POST /drive",
            "POST /motors/drive",
            "POST /motors/stop",
            "POST /estop",
            "POST /estop/reset",
            "WS /ws/drive",
            "WS /ws/telemetry",
        ],
    })
}

async fn health(State(state): State<AppState>) -> Json<HealthResp> {
    let raw = state.raw.read().clone();
    let command = state.command.lock().clone();
    Json(HealthResp {
        ok: true,
        role: state.role,
        mode: mode_name(state.mode).to_string(),
        serial_port: state.serial_port,
        uptime_secs: state.started_at.elapsed().as_secs(),
        battery_v: raw.battery_v,
        active_session: command.active_session_id,
        estop: command.estop,
        deadman_ms: state.deadman_ms,
    })
}

async fn telemetry(State(state): State<AppState>) -> Json<TelemetryFrame> {
    Json(current_telemetry_frame(&state))
}

async fn sensors(State(state): State<AppState>) -> Json<SensorsResp> {
    let raw = state.raw.read().clone();
    let ts_ms = now_ms();
    let sensors = sensor_snapshot_for(&state, &raw, ts_ms);
    Json(SensorsResp {
        ok: true,
        role: state.role.clone(),
        ts_ms,
        source: raw.source,
        battery_v: raw.battery_v,
        odometry: sensors.odometry.clone(),
        imu: sensors.imu.clone(),
        lidar: sensors.lidar.clone(),
        camera: sensors.camera.clone(),
        last_raw_frame_ms: raw.last_raw_frame_ms,
        raw_frame_age_ms: sensors.raw_frame.age_ms,
        sensors,
    })
}

async fn stop(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    estop_inner(&state)?;
    Ok(Json(json!({"stopped": true, "estop": true})))
}

async fn estop(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    estop_inner(&state)?;
    Ok(Json(json!({"ok": true, "estop": true})))
}

async fn motors_stop(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    state.rover.stop()?;
    let mut command = state.command.lock();
    command.left_cmd = 0.0;
    command.right_cmd = 0.0;
    command.active_session_id = None;
    command.stopped_by_deadman = false;
    Ok(Json(
        json!({"ok": true, "stopped": true, "estop": command.estop}),
    ))
}

async fn estop_reset(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    state.rover.stop()?;
    let mut command = state.command.lock();
    command.left_cmd = 0.0;
    command.right_cmd = 0.0;
    command.active_session_id = None;
    command.estop = false;
    command.stopped_by_deadman = false;
    Ok(Json(json!({"ok": true, "estop": false})))
}

async fn stream(State(state): State<AppState>) -> Response {
    if let Some(url) = camera_stream_proxy_url(&state) {
        return proxy_camera(&state, url, "multipart/x-mixed-replace").await;
    }
    if matches!(state.mode, Mode::Sim) {
        return simulated_camera_stream(&state);
    }
    camera_unavailable_response(&state, "stream")
}

fn simulated_camera_stream(state: &AppState) -> Response {
    let raw = state.raw.read().clone();
    let command = state.command.lock().clone();
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#142033"/><stop offset="1" stop-color="#05070a"/></linearGradient>
</defs>
<rect width="1280" height="720" fill="url(#g)"/>
<g stroke="rgba(255,255,255,.18)" stroke-width="2">
<path d="M280 720 L560 0"/><path d="M1000 720 L720 0"/>
<path d="M420 720 L600 0"/><path d="M860 720 L680 0"/>
</g>
<g fill="none" stroke="#f2c14e" stroke-width="6" stroke-dasharray="28 30" opacity=".86">
<path d="M640 720 L640 0"/>
</g>
<text x="42" y="64" fill="#f2f7fb" font-family="Menlo, monospace" font-size="30">ROVER {role} SIM CAMERA</text>
<text x="42" y="108" fill="#9baec2" font-family="Menlo, monospace" font-size="22">battery {battery}V  L {left}  R {right}</text>
<circle cx="640" cy="472" r="54" fill="#59a6ff" opacity=".78"/>
<path d="M640 386 L672 462 L608 462 Z" fill="#f2f7fb"/>
</svg>"##,
        role = state.role,
        battery = raw
            .battery_v
            .map(|v| format!("{v:.2}"))
            .unwrap_or_else(|| "--".to_string()),
        left = format!("{:.2}", command.left_cmd),
        right = format!("{:.2}", command.right_cmd),
    );
    ([(axum::http::header::CONTENT_TYPE, "image/svg+xml")], svg).into_response()
}

async fn camera_status(State(state): State<AppState>) -> Json<CameraStatus> {
    Json(camera_status_for(&state))
}

async fn camera_snapshot(State(state): State<AppState>) -> Response {
    if let Some(url) = camera_snapshot_proxy_url(&state) {
        return proxy_camera(&state, url, "image/jpeg").await;
    }
    if matches!(state.mode, Mode::Sim) {
        return simulated_camera_stream(&state);
    }
    camera_unavailable_response(&state, "snapshot")
}

fn camera_stream_proxy_url(state: &AppState) -> Option<&str> {
    first_camera_proxy_url(&state.camera_stream_url, &state.camera_snapshot_url)
}

fn camera_snapshot_proxy_url(state: &AppState) -> Option<&str> {
    first_camera_proxy_url(&state.camera_snapshot_url, &state.camera_stream_url)
}

fn first_camera_proxy_url<'a>(
    primary: &'a Option<String>,
    fallback: &'a Option<String>,
) -> Option<&'a str> {
    primary.as_deref().or_else(|| fallback.as_deref())
}

async fn proxy_camera(state: &AppState, url: &str, default_content_type: &'static str) -> Response {
    let upstream = match state.camera_client.get(url).send().await {
        Ok(upstream) => upstream,
        Err(err) => {
            warn!(%url, ?err, "camera proxy request failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "ok": false,
                    "error": "camera proxy request failed",
                    "url": url,
                })),
            )
                .into_response();
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static(default_content_type));
    let cache_control = upstream.headers().get(CACHE_CONTROL).cloned();

    let mut builder = Response::builder().status(status);
    if let Some(headers) = builder.headers_mut() {
        headers.insert(CONTENT_TYPE, content_type);
        if let Some(cache_control) = cache_control {
            headers.insert(CACHE_CONTROL, cache_control);
        }
    }

    builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|err| {
            error!(?err, "failed to build camera proxy response");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "ok": false,
                    "error": "failed to build camera proxy response",
                })),
            )
                .into_response()
        })
}

fn camera_unavailable_response(state: &AppState, endpoint: &'static str) -> Response {
    let camera = camera_status_for(state);
    let status = if camera.device.is_some() {
        StatusCode::NOT_IMPLEMENTED
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "ok": false,
            "error": "camera source unavailable",
            "endpoint": endpoint,
            "camera": camera,
        })),
    )
        .into_response()
}

async fn pilot_authorize(
    State(state): State<AppState>,
    Json(req): Json<PilotTokenReq>,
) -> Result<Json<PilotTokenResp>, AppError> {
    if req.token.trim().is_empty() {
        return Err(AppError::bad_request("token is required"));
    }

    let ttl_secs = req.ttl_secs.unwrap_or(120.0).max(1.0);
    state.sessions.lock().insert(
        req.token,
        PilotSession {
            expires_at: Instant::now() + Duration::from_secs_f64(ttl_secs),
            not_before_epoch_ms: req.not_before_epoch_ms,
            speed_mode: req.speed_mode,
        },
    );
    Ok(Json(PilotTokenResp {
        ok: true,
        expires_in_secs: ttl_secs,
        speed_mode: req.speed_mode,
        max_speed: req.speed_mode.cap(),
    }))
}

async fn pilot_speed_mode(
    State(state): State<AppState>,
    Json(req): Json<SpeedModeReq>,
) -> Result<Json<Value>, AppError> {
    let mut sessions = state.sessions.lock();
    let session = sessions
        .get_mut(&req.token)
        .ok_or_else(|| AppError::forbidden("unknown pilot token"))?;
    if session.expires_at <= Instant::now() {
        sessions.remove(&req.token);
        return Err(AppError::forbidden("pilot token expired"));
    }
    session.speed_mode = req.speed_mode;
    Ok(Json(json!({
        "ok": true,
        "speed_mode": req.speed_mode,
        "max_speed": req.speed_mode.cap()
    })))
}

async fn drive(
    State(state): State<AppState>,
    Json(req): Json<DriveReq>,
) -> Result<Json<Value>, AppError> {
    let speed_mode = if let Some(token) = req.token.as_deref() {
        validate_session(&state, token)?.speed_mode
    } else if state.allow_untokened_drive {
        SpeedMode::Medium
    } else {
        return Err(AppError::forbidden("drive token is required"));
    };

    apply_drive(&state, req.left, req.right, speed_mode, req.token)?;
    Ok(Json(
        json!({"ok": true, "speed_mode": speed_mode, "max_speed": speed_mode.cap()}),
    ))
}

async fn ws_drive(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_drive_socket(socket, state))
}

async fn ws_telemetry(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_telemetry_socket(socket, state))
}

async fn handle_drive_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut authed_token: Option<String> = None;

    while let Some(msg) = receiver.next().await {
        let Ok(msg) = msg else {
            break;
        };
        let Message::Text(text) = msg else {
            continue;
        };

        let parsed: WsDriveMsg = match serde_json::from_str(&text) {
            Ok(parsed) => parsed,
            Err(err) => {
                let _ = sender
                    .send(Message::Text(json!({"error": err.to_string()}).to_string()))
                    .await;
                continue;
            }
        };

        let token = match authed_token.as_deref().or(parsed.token.as_deref()) {
            Some(token) => token,
            None => {
                let _ = sender
                    .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: 4403,
                        reason: "missing pilot token".into(),
                    })))
                    .await;
                return;
            }
        };

        let session = match validate_session(&state, token) {
            Ok(session) => session,
            Err(err) => {
                let _ = sender
                    .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: 4403,
                        reason: err.message.into(),
                    })))
                    .await;
                return;
            }
        };

        authed_token = Some(token.to_string());

        if let Some(client_ts) = parsed.client_ts_ms {
            if now_ms().saturating_sub(client_ts) > 250 {
                continue;
            }
        }

        if let Err(err) = apply_drive(
            &state,
            parsed.left.unwrap_or(0.0),
            parsed.right.unwrap_or(0.0),
            session.speed_mode,
            authed_token.clone(),
        ) {
            let _ = sender
                .send(Message::Text(json!({"error": err.message}).to_string()))
                .await;
        }
    }

    if let Err(err) = state.rover.stop() {
        error!(?err, "failed to stop rover after drive websocket closed");
    }
    let mut command = state.command.lock();
    command.left_cmd = 0.0;
    command.right_cmd = 0.0;
    command.active_session_id = None;
}

async fn handle_telemetry_socket(mut socket: WebSocket, state: AppState) {
    let mut rx = state.telemetry_tx.subscribe();
    loop {
        match rx.recv().await {
            Ok(frame) => {
                let Ok(text) = serde_json::to_string(&frame) else {
                    continue;
                };
                if socket.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                warn!(skipped, "telemetry websocket lagged");
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

fn validate_session(state: &AppState, token: &str) -> Result<PilotSession, AppError> {
    let mut sessions = state.sessions.lock();
    let Some(session) = sessions.get(token).cloned() else {
        return Err(AppError::forbidden("unknown pilot token"));
    };
    if session.expires_at <= Instant::now() {
        sessions.remove(token);
        return Err(AppError::forbidden("pilot token expired"));
    }
    if let Some(not_before) = session.not_before_epoch_ms {
        if now_ms() < not_before {
            return Err(AppError::forbidden("round has not started"));
        }
    }
    Ok(session)
}

fn apply_drive(
    state: &AppState,
    left: f64,
    right: f64,
    speed_mode: SpeedMode,
    session_id: Option<String>,
) -> Result<(), AppError> {
    {
        let command = state.command.lock();
        if command.estop {
            return Err(AppError::forbidden("estop is active"));
        }
    }

    let cap = speed_mode.cap();
    let left = clamp(left, -cap, cap);
    let right = clamp(right, -cap, cap);
    state.rover.drive(left, right)?;

    let mut command = state.command.lock();
    command.left_cmd = left;
    command.right_cmd = right;
    command.last_cmd_at = Some(Instant::now());
    command.active_session_id = session_id;
    command.speed_mode = speed_mode;
    command.stopped_by_deadman = false;
    Ok(())
}

fn spawn_deadman(state: AppState) {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(50));
        loop {
            interval.tick().await;
            let should_stop = {
                let command = state.command.lock();
                command
                    .last_cmd_at
                    .is_some_and(|last| last.elapsed() > Duration::from_millis(state.deadman_ms))
                    && (command.left_cmd != 0.0 || command.right_cmd != 0.0)
            };
            if !should_stop {
                continue;
            }
            if let Err(err) = state.rover.stop() {
                error!(?err, "deadman stop failed");
            }
            let mut command = state.command.lock();
            command.left_cmd = 0.0;
            command.right_cmd = 0.0;
            command.stopped_by_deadman = true;
        }
    });
}

fn spawn_telemetry_loop(state: AppState) {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(1000 / TELEMETRY_HZ));
        loop {
            interval.tick().await;
            let frame = current_telemetry_frame(&state);
            let _ = state.telemetry_tx.send(frame);
        }
    });
}

fn spawn_sim_telemetry_loop(state: AppState) {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(100));
        let mut odl = 0.0;
        let mut odr = 0.0;
        let mut yaw = 0.0;
        loop {
            interval.tick().await;
            let command = state.command.lock().clone();
            odl += command.left_cmd * 0.1;
            odr += command.right_cmd * 0.1;
            yaw += (command.right_cmd - command.left_cmd) * 0.02;
            *state.raw.write() = RawTelemetry {
                battery_v: Some(12.2),
                odometry_left: Some(round3(odl)),
                odometry_right: Some(round3(odr)),
                yaw: Some(round3(yaw)),
                accel: Some([0.0, 0.0, 9.8]),
                gyro: Some([0.0, 0.0, round3(yaw)]),
                mag: None,
                source: "sim",
                last_raw_frame_ms: Some(now_ms()),
            };
        }
    });
}

fn spawn_lidar_reader(
    lidar: Arc<RwLock<LidarReading>>,
    port_path: String,
    baud: u32,
    block_threshold_m: f64,
) {
    thread::spawn(move || loop {
        match serialport::new(&port_path, baud)
            .timeout(Duration::from_millis(200))
            .open()
        {
            Ok(mut port) => {
                info!(%port_path, baud, "lidar serial connected");
                clear_lidar_error(&lidar, &port_path);
                let mut parser = Ld06Parser::default();
                let mut buffer = [0_u8; 256];
                let mut window = LidarScanWindow::new(now_ms());

                loop {
                    match port.read(&mut buffer) {
                        Ok(0) => continue,
                        Ok(n) => {
                            for points in parser.push_bytes(&buffer[..n]) {
                                let now = now_ms();
                                if now.saturating_sub(window.started_ms) > LIDAR_WINDOW_MS {
                                    window = LidarScanWindow::new(now);
                                }
                                window.ingest(&points);
                                if window.points > 0 {
                                    publish_lidar_window(
                                        &lidar,
                                        &port_path,
                                        &window,
                                        now,
                                        block_threshold_m,
                                    );
                                }
                            }
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::TimedOut => continue,
                        Err(err) => {
                            warn!(%port_path, ?err, "lidar serial read failed");
                            record_lidar_error(&lidar, &port_path, err.to_string());
                            break;
                        }
                    }
                }
            }
            Err(err) => {
                warn!(%port_path, baud, ?err, "lidar serial open failed");
                record_lidar_error(&lidar, &port_path, err.to_string());
                thread::sleep(Duration::from_secs(1));
            }
        }
    });
}

#[derive(Debug, Clone, Copy)]
struct LidarPoint {
    angle_deg: f64,
    distance_mm: u16,
}

#[derive(Debug)]
struct LidarScanWindow {
    started_ms: u128,
    front_m: Option<f64>,
    min_m: Option<f64>,
    points: usize,
}

impl LidarScanWindow {
    fn new(started_ms: u128) -> Self {
        Self {
            started_ms,
            front_m: None,
            min_m: None,
            points: 0,
        }
    }

    fn ingest(&mut self, points: &[LidarPoint]) {
        for point in points {
            if point.distance_mm < LIDAR_MIN_VALID_MM {
                continue;
            }
            let meters = round3(f64::from(point.distance_mm) / 1000.0);
            self.min_m = min_optional(self.min_m, meters);
            if is_front_angle(point.angle_deg, LIDAR_FRONT_CONE_DEG) {
                self.front_m = min_optional(self.front_m, meters);
            }
            self.points += 1;
        }
    }
}

#[derive(Default)]
struct Ld06Parser {
    buffer: Vec<u8>,
}

impl Ld06Parser {
    fn push_bytes(&mut self, bytes: &[u8]) -> Vec<Vec<LidarPoint>> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();

        loop {
            let Some(header_pos) = self.buffer.iter().position(|byte| *byte == 0x54) else {
                self.buffer.clear();
                break;
            };
            if header_pos > 0 {
                self.buffer.drain(..header_pos);
            }
            if self.buffer.len() < 2 {
                break;
            }
            if self.buffer[1] != 0x2c {
                self.buffer.remove(0);
                continue;
            }
            if self.buffer.len() < LIDAR_FRAME_LEN {
                break;
            }

            let frame = self.buffer[..LIDAR_FRAME_LEN].to_vec();
            self.buffer.drain(..LIDAR_FRAME_LEN);
            if let Some(points) = parse_ld06_frame(&frame) {
                frames.push(points);
            }
        }

        if self.buffer.len() > LIDAR_FRAME_LEN * 8 {
            let keep_from = self.buffer.len().saturating_sub(LIDAR_FRAME_LEN);
            self.buffer.drain(..keep_from);
        }

        frames
    }
}

fn parse_ld06_frame(frame: &[u8]) -> Option<Vec<LidarPoint>> {
    if frame.len() != LIDAR_FRAME_LEN || frame[0] != 0x54 || frame[1] != 0x2c {
        return None;
    }
    if ld06_crc8(&frame[..LIDAR_FRAME_LEN - 1]) != frame[LIDAR_FRAME_LEN - 1] {
        return None;
    }

    let start_angle = f64::from(read_u16_le(frame, 4)?) / 100.0;
    let end_angle = f64::from(read_u16_le(frame, 42)?) / 100.0;
    let span = angle_delta_deg(start_angle, end_angle);
    let step = span / (LIDAR_POINTS_PER_FRAME - 1) as f64;
    let mut points = Vec::with_capacity(LIDAR_POINTS_PER_FRAME);

    for index in 0..LIDAR_POINTS_PER_FRAME {
        let offset = 6 + index * 3;
        let distance_mm = read_u16_le(frame, offset)?;
        points.push(LidarPoint {
            angle_deg: normalize_angle_deg(start_angle + step * index as f64),
            distance_mm,
        });
    }

    Some(points)
}

fn ld06_crc8(bytes: &[u8]) -> u8 {
    let mut crc = 0_u8;
    for byte in bytes {
        crc ^= *byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x4d
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
    ]))
}

fn angle_delta_deg(start: f64, end: f64) -> f64 {
    if end >= start {
        end - start
    } else {
        end + 360.0 - start
    }
}

fn normalize_angle_deg(angle: f64) -> f64 {
    let normalized = angle % 360.0;
    if normalized < 0.0 {
        normalized + 360.0
    } else {
        normalized
    }
}

fn is_front_angle(angle: f64, cone_deg: f64) -> bool {
    angle <= cone_deg || angle >= 360.0 - cone_deg
}

fn min_optional(current: Option<f64>, candidate: f64) -> Option<f64> {
    Some(current.map_or(candidate, |value| value.min(candidate)))
}

fn clear_lidar_error(lidar: &Arc<RwLock<LidarReading>>, port_path: &str) {
    let mut reading = lidar.write();
    reading.status = "unavailable";
    reading.source = "ld06";
    reading.port = Some(port_path.to_string());
    reading.error = None;
}

fn record_lidar_error(lidar: &Arc<RwLock<LidarReading>>, port_path: &str, error: String) {
    let mut reading = lidar.write();
    reading.status = "error";
    reading.source = "ld06";
    reading.port = Some(port_path.to_string());
    reading.error = Some(error);
}

fn publish_lidar_window(
    lidar: &Arc<RwLock<LidarReading>>,
    port_path: &str,
    window: &LidarScanWindow,
    now: u128,
    block_threshold_m: f64,
) {
    let blocked_distance = window.front_m.or(window.min_m);
    let mut reading = lidar.write();
    reading.status = "available";
    reading.source = "ld06";
    reading.port = Some(port_path.to_string());
    reading.front_m = window.front_m;
    reading.min_m = window.min_m;
    reading.blocked = blocked_distance
        .map(|distance| distance <= block_threshold_m)
        .unwrap_or(false);
    reading.points = window.points;
    reading.last_frame_ms = Some(now);
    reading.error = None;
}

fn current_telemetry_frame(state: &AppState) -> TelemetryFrame {
    let raw = state.raw.read().clone();
    let command = state.command.lock().clone();
    let ts_ms = now_ms();
    let sensors = sensor_snapshot_for(state, &raw, ts_ms);
    let deadman_ok = command
        .last_cmd_at
        .map(|last| last.elapsed() <= Duration::from_millis(state.deadman_ms))
        .unwrap_or(true);
    TelemetryFrame {
        ts_ms,
        robot: state.role.clone(),
        battery_v: raw.battery_v,
        left_cmd: command.left_cmd,
        right_cmd: command.right_cmd,
        odometry_left: raw.odometry_left,
        odometry_right: raw.odometry_right,
        yaw: raw.yaw,
        session_id: command.active_session_id,
        deadman_ok,
        estop: command.estop,
        stopped_by_deadman: command.stopped_by_deadman,
        speed_mode: command.speed_mode,
        max_speed: command.speed_mode.cap(),
        last_raw_frame_ms: raw.last_raw_frame_ms,
        raw_frame_age_ms: sensors.raw_frame.age_ms,
        camera: sensors.camera.clone(),
        lidar: sensors.lidar.clone(),
        imu: sensors.imu.clone(),
        sensors,
        source: raw.source,
    }
}

fn estop_inner(state: &AppState) -> Result<(), AppError> {
    state.rover.stop()?;
    let mut command = state.command.lock();
    command.left_cmd = 0.0;
    command.right_cmd = 0.0;
    command.active_session_id = None;
    command.estop = true;
    command.stopped_by_deadman = false;
    Ok(())
}

fn camera_status_for(state: &AppState) -> CameraStatus {
    CameraStatus {
        status: camera_status_name(
            state.mode,
            &state.camera_device,
            &state.camera_stream_url,
            &state.camera_snapshot_url,
        ),
        device: state.camera_device.clone(),
        stream_url: state.camera_stream_url.clone(),
        snapshot_url: state.camera_snapshot_url.clone(),
    }
}

fn camera_status_name(
    mode: Mode,
    device: &Option<String>,
    stream_url: &Option<String>,
    snapshot_url: &Option<String>,
) -> &'static str {
    if stream_url.is_some() || snapshot_url.is_some() {
        "proxy"
    } else if matches!(mode, Mode::Sim) {
        "simulated"
    } else if device.is_some() {
        "configured"
    } else {
        "unavailable"
    }
}

fn initial_raw_telemetry(mode: Mode) -> RawTelemetry {
    match mode {
        Mode::Sim => RawTelemetry {
            battery_v: Some(12.2),
            odometry_left: Some(0.0),
            odometry_right: Some(0.0),
            yaw: Some(0.0),
            accel: Some([0.0, 0.0, 9.8]),
            gyro: Some([0.0, 0.0, 0.0]),
            mag: None,
            source: "sim",
            last_raw_frame_ms: Some(now_ms()),
        },
        Mode::Serial => RawTelemetry {
            source: "serial",
            ..RawTelemetry::default()
        },
    }
}

fn initial_lidar_reading(mode: Mode, port: &str, block_threshold_m: f64) -> LidarReading {
    match mode {
        Mode::Sim => LidarReading {
            status: "simulated",
            source: "sim",
            port: None,
            front_m: Some(1.0),
            min_m: Some(1.0),
            blocked: 1.0 <= block_threshold_m,
            points: 1,
            last_frame_ms: Some(now_ms()),
            error: None,
        },
        Mode::Serial => LidarReading {
            status: "unavailable",
            source: "ld06",
            port: Some(port.to_string()),
            front_m: None,
            min_m: None,
            blocked: false,
            points: 0,
            last_frame_ms: None,
            error: None,
        },
    }
}

fn sensor_snapshot_for(state: &AppState, raw: &RawTelemetry, now: u128) -> SensorSnapshot {
    SensorSnapshot {
        battery: battery_status_for(raw),
        odometry: odometry_status_for(raw),
        imu: imu_status_for(raw),
        lidar: lidar_status_for(state, now),
        camera: camera_status_for(state),
        raw_frame: raw_frame_status_for(raw, now),
    }
}

fn battery_status_for(raw: &RawTelemetry) -> BatteryStatus {
    BatteryStatus {
        status: if raw.battery_v.is_some() {
            "available"
        } else {
            "unavailable"
        },
        voltage_v: raw.battery_v,
    }
}

fn odometry_status_for(raw: &RawTelemetry) -> OdometryStatus {
    OdometryStatus {
        status: if raw.odometry_left.is_some() || raw.odometry_right.is_some() {
            "available"
        } else {
            "unavailable"
        },
        left: raw.odometry_left,
        right: raw.odometry_right,
    }
}

fn lidar_status_for(state: &AppState, now: u128) -> LidarStatus {
    let reading = state.lidar.read().clone();
    let age_ms = reading
        .last_frame_ms
        .map(|last_frame| now.saturating_sub(last_frame));
    let status = if reading.status == "simulated" {
        "simulated"
    } else if age_ms.is_some_and(|age| age <= LIDAR_STALE_MS) {
        "available"
    } else if reading.last_frame_ms.is_some() {
        "stale"
    } else if reading.error.is_some() {
        "error"
    } else {
        reading.status
    };

    LidarStatus {
        status,
        source: reading.source,
        port: reading.port,
        front_m: reading.front_m,
        min_m: reading.min_m,
        blocked: reading.blocked,
        points: reading.points,
        last_frame_ms: reading.last_frame_ms,
        age_ms,
        error: reading.error,
    }
}

fn raw_frame_status_for(raw: &RawTelemetry, now: u128) -> RawFrameStatus {
    let age_ms = raw
        .last_raw_frame_ms
        .map(|last_raw_frame| now.saturating_sub(last_raw_frame));
    RawFrameStatus {
        status: if raw.last_raw_frame_ms.is_some() {
            "available"
        } else {
            "unavailable"
        },
        source: raw.source,
        last_ms: raw.last_raw_frame_ms,
        age_ms,
    }
}

fn imu_status_for(raw: &RawTelemetry) -> ImuStatus {
    ImuStatus {
        status: if raw.accel.is_some()
            || raw.gyro.is_some()
            || raw.mag.is_some()
            || raw.yaw.is_some()
        {
            "available"
        } else {
            "unavailable"
        },
        accel: raw.accel,
        gyro: raw.gyro,
        mag: raw.mag,
        yaw: raw.yaw,
    }
}

fn merge_raw_telemetry(current: &mut RawTelemetry, parsed: RawTelemetry) {
    if parsed.battery_v.is_some() {
        current.battery_v = parsed.battery_v;
    }
    if parsed.odometry_left.is_some() {
        current.odometry_left = parsed.odometry_left;
    }
    if parsed.odometry_right.is_some() {
        current.odometry_right = parsed.odometry_right;
    }
    if parsed.yaw.is_some() {
        current.yaw = parsed.yaw;
    }
    if parsed.accel.is_some() {
        current.accel = parsed.accel;
    }
    if parsed.gyro.is_some() {
        current.gyro = parsed.gyro;
    }
    if parsed.mag.is_some() {
        current.mag = parsed.mag;
    }
    current.source = parsed.source;
    current.last_raw_frame_ms = parsed.last_raw_frame_ms;
}

fn parse_esp32_telemetry(line: &str) -> Option<RawTelemetry> {
    let value: Value = serde_json::from_str(line).ok()?;
    let msg_type = value.get("T").and_then(Value::as_i64);
    match msg_type {
        Some(1001) => Some(RawTelemetry {
            battery_v: value.get("v").and_then(Value::as_f64).map(|v| v / 100.0),
            odometry_left: value.get("odl").and_then(Value::as_f64),
            odometry_right: value.get("odr").and_then(Value::as_f64),
            yaw: None,
            accel: vec3(&value, "ax", "ay", "az"),
            gyro: vec3(&value, "gx", "gy", "gz"),
            mag: vec3(&value, "mx", "my", "mz"),
            source: "serial",
            last_raw_frame_ms: Some(now_ms()),
        }),
        Some(1002) => Some(RawTelemetry {
            battery_v: None,
            odometry_left: None,
            odometry_right: None,
            yaw: value.get("y").and_then(Value::as_f64),
            accel: None,
            gyro: None,
            mag: None,
            source: "serial",
            last_raw_frame_ms: Some(now_ms()),
        }),
        _ => None,
    }
}

fn vec3(value: &Value, x: &str, y: &str, z: &str) -> Option<[f64; 3]> {
    Some([
        value.get(x)?.as_f64()?,
        value.get(y)?.as_f64()?,
        value.get(z)?.as_f64()?,
    ])
}

fn mode_name(mode: Mode) -> &'static str {
    match mode {
        Mode::Sim => "sim",
        Mode::Serial => "serial",
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: err.to_string(),
        }
    }
}

impl From<AppError> for anyhow::Error {
    fn from(err: AppError) -> Self {
        anyhow!(err.message)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
                "ok": false,
                "error": self.message,
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct RecordingRover {
        commands: Arc<Mutex<Vec<(f64, f64)>>>,
    }

    impl RoverControl for RecordingRover {
        fn drive(&self, left: f64, right: f64) -> Result<()> {
            self.commands.lock().push((left, right));
            Ok(())
        }
    }

    fn test_state(allow_untokened_drive: bool) -> (AppState, Arc<Mutex<Vec<(f64, f64)>>>) {
        let commands = Arc::new(Mutex::new(Vec::new()));
        let (telemetry_tx, _) = broadcast::channel(8);
        let state = AppState {
            role: "courier".to_string(),
            mode: Mode::Sim,
            serial_port: "/dev/null".to_string(),
            started_at: Instant::now(),
            rover: Arc::new(RecordingRover {
                commands: commands.clone(),
            }),
            raw: Arc::new(RwLock::new(RawTelemetry {
                source: "sim",
                ..RawTelemetry::default()
            })),
            command: Arc::new(Mutex::new(CommandState::default())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            telemetry_tx,
            allow_untokened_drive,
            deadman_ms: DEFAULT_DEADMAN_MS,
            camera_client: reqwest::Client::new(),
            camera_device: None,
            camera_stream_url: None,
            camera_snapshot_url: None,
            lidar: Arc::new(RwLock::new(initial_lidar_reading(Mode::Sim, "", 0.30))),
        };
        (state, commands)
    }

    fn insert_session(state: &AppState, token: &str, speed_mode: SpeedMode) {
        state.sessions.lock().insert(
            token.to_string(),
            PilotSession {
                expires_at: Instant::now() + Duration::from_secs(5),
                not_before_epoch_ms: None,
                speed_mode,
            },
        );
    }

    fn make_ld06_frame(start_cdeg: u16, end_cdeg: u16, distances: [u16; 12]) -> Vec<u8> {
        let mut frame = vec![0_u8; LIDAR_FRAME_LEN];
        frame[0] = 0x54;
        frame[1] = 0x2c;
        frame[2..4].copy_from_slice(&3500_u16.to_le_bytes());
        frame[4..6].copy_from_slice(&start_cdeg.to_le_bytes());
        for (index, distance) in distances.iter().enumerate() {
            let offset = 6 + index * 3;
            frame[offset..offset + 2].copy_from_slice(&distance.to_le_bytes());
            frame[offset + 2] = 100;
        }
        frame[42..44].copy_from_slice(&end_cdeg.to_le_bytes());
        frame[44..46].copy_from_slice(&123_u16.to_le_bytes());
        frame[46] = ld06_crc8(&frame[..46]);
        frame
    }

    #[test]
    fn speed_modes_define_expected_caps() {
        assert_eq!(SpeedMode::Low.cap(), 0.15);
        assert_eq!(SpeedMode::Medium.cap(), 0.25);
        assert_eq!(SpeedMode::High.cap(), 0.35);
    }

    #[test]
    fn clamp_limits_drive_values() {
        assert_eq!(clamp(1.0, -0.25, 0.25), 0.25);
        assert_eq!(clamp(-1.0, -0.25, 0.25), -0.25);
        assert_eq!(clamp(0.1, -0.25, 0.25), 0.1);
    }

    #[test]
    fn parses_base_telemetry_frame() {
        let parsed = parse_esp32_telemetry(r#"{"T":1001,"v":1203,"odl":1.25,"odr":1.5}"#)
            .expect("base telemetry");
        assert_eq!(parsed.battery_v, Some(12.03));
        assert_eq!(parsed.odometry_left, Some(1.25));
        assert_eq!(parsed.odometry_right, Some(1.5));
        assert_eq!(parsed.source, "serial");
        assert!(parsed.last_raw_frame_ms.is_some());
    }

    #[test]
    fn parses_imu_values_from_base_telemetry_frame() {
        let parsed = parse_esp32_telemetry(
            r#"{"T":1001,"ax":1,"ay":2,"az":3,"gx":4,"gy":5,"gz":6,"mx":7,"my":8,"mz":9}"#,
        )
        .expect("base telemetry");
        assert_eq!(parsed.accel, Some([1.0, 2.0, 3.0]));
        assert_eq!(parsed.gyro, Some([4.0, 5.0, 6.0]));
        assert_eq!(parsed.mag, Some([7.0, 8.0, 9.0]));
    }

    #[test]
    fn parses_attitude_frame_yaw() {
        let parsed = parse_esp32_telemetry(r#"{"T":1002,"y":42.5}"#).expect("attitude");
        assert_eq!(parsed.yaw, Some(42.5));
        assert_eq!(parsed.source, "serial");
    }

    #[test]
    fn sim_raw_telemetry_starts_with_deterministic_sensor_values() {
        let raw = initial_raw_telemetry(Mode::Sim);
        assert_eq!(raw.battery_v, Some(12.2));
        assert_eq!(raw.odometry_left, Some(0.0));
        assert_eq!(raw.odometry_right, Some(0.0));
        assert_eq!(raw.accel, Some([0.0, 0.0, 9.8]));
        assert_eq!(raw.gyro, Some([0.0, 0.0, 0.0]));
        assert_eq!(raw.yaw, Some(0.0));
        assert_eq!(raw.source, "sim");
        assert!(raw.last_raw_frame_ms.is_some());
    }

    #[test]
    fn serial_partial_frames_merge_without_erasing_existing_sensors() {
        let mut raw = parse_esp32_telemetry(
            r#"{"T":1001,"v":1203,"odl":1.25,"odr":1.5,"ax":1,"ay":2,"az":3}"#,
        )
        .expect("base telemetry");
        let attitude = parse_esp32_telemetry(r#"{"T":1002,"y":42.5}"#).expect("attitude");
        merge_raw_telemetry(&mut raw, attitude);

        assert_eq!(raw.battery_v, Some(12.03));
        assert_eq!(raw.odometry_left, Some(1.25));
        assert_eq!(raw.odometry_right, Some(1.5));
        assert_eq!(raw.accel, Some([1.0, 2.0, 3.0]));
        assert_eq!(raw.yaw, Some(42.5));
        assert_eq!(raw.source, "serial");
    }

    #[test]
    fn ignores_unknown_or_invalid_frames() {
        assert!(parse_esp32_telemetry(r#"{"T":999}"#).is_none());
        assert!(parse_esp32_telemetry("not-json").is_none());
    }

    #[test]
    fn parses_ld06_lidar_frame_and_front_window() {
        let mut distances = [1_000_u16; 12];
        distances[0] = 400;
        distances[11] = 200;
        let frame = make_ld06_frame(35_000, 1_000, distances);
        let points = parse_ld06_frame(&frame).expect("ld06 frame");

        assert_eq!(points.len(), 12);
        assert_eq!(round3(points[0].angle_deg), 350.0);
        assert_eq!(round3(points[11].angle_deg), 10.0);

        let mut window = LidarScanWindow::new(10);
        window.ingest(&points);
        assert_eq!(window.points, 12);
        assert_eq!(window.min_m, Some(0.2));
        assert_eq!(window.front_m, Some(0.2));
    }

    #[test]
    fn rejects_ld06_frame_with_bad_checksum() {
        let mut frame = make_ld06_frame(0, 1_100, [1_000_u16; 12]);
        frame[6] ^= 0xff;

        assert!(parse_ld06_frame(&frame).is_none());
    }

    #[test]
    fn lidar_status_reports_available_then_stale() {
        let (state, _) = test_state(false);
        *state.lidar.write() = LidarReading {
            status: "available",
            source: "ld06",
            port: Some("/dev/ttyACM0".to_string()),
            front_m: Some(0.25),
            min_m: Some(0.25),
            blocked: true,
            points: 12,
            last_frame_ms: Some(1_000),
            error: None,
        };

        let fresh = lidar_status_for(&state, 1_500);
        assert_eq!(fresh.status, "available");
        assert_eq!(fresh.front_m, Some(0.25));
        assert!(fresh.blocked);

        let stale = lidar_status_for(&state, 2_500);
        assert_eq!(stale.status, "stale");
    }

    #[test]
    fn camera_proxy_url_prefers_specific_endpoint_and_falls_back() {
        let stream = Some("http://camera.local/stream".to_string());
        let snapshot = Some("http://camera.local/snapshot.jpg".to_string());

        assert_eq!(
            first_camera_proxy_url(&stream, &snapshot),
            Some("http://camera.local/stream")
        );
        assert_eq!(
            first_camera_proxy_url(&snapshot, &stream),
            Some("http://camera.local/snapshot.jpg")
        );
        assert_eq!(
            first_camera_proxy_url(&None, &stream),
            Some("http://camera.local/stream")
        );
        assert_eq!(first_camera_proxy_url(&None, &None), None);
    }

    #[test]
    fn camera_status_separates_simulated_from_physical_unavailable() {
        let device = Some("/dev/video0".to_string());
        let stream = Some("http://camera.local/stream".to_string());

        assert_eq!(
            camera_status_name(Mode::Sim, &None, &None, &None),
            "simulated"
        );
        assert_eq!(
            camera_status_name(Mode::Serial, &None, &None, &None),
            "unavailable"
        );
        assert_eq!(
            camera_status_name(Mode::Serial, &device, &None, &None),
            "configured"
        );
        assert_eq!(
            camera_status_name(Mode::Serial, &None, &stream, &None),
            "proxy"
        );
    }

    #[tokio::test]
    async fn untokened_drive_requires_explicit_override() {
        let (state, commands) = test_state(false);
        let err = drive(
            State(state),
            Json(DriveReq {
                left: 1.0,
                right: 1.0,
                token: None,
            }),
        )
        .await
        .expect_err("untokened drive should be rejected");
        assert_eq!(err.status, StatusCode::FORBIDDEN);
        assert_eq!(err.message, "drive token is required");
        assert!(commands.lock().is_empty());
    }

    #[tokio::test]
    async fn untokened_drive_can_be_enabled_explicitly_and_is_clamped() {
        let (state, commands) = test_state(true);
        let _ = drive(
            State(state),
            Json(DriveReq {
                left: 1.0,
                right: -1.0,
                token: None,
            }),
        )
        .await
        .expect("explicitly enabled untokened drive");
        assert_eq!(&*commands.lock(), &[(0.25, -0.25)]);
    }

    #[tokio::test]
    async fn estop_latches_until_explicit_reset() {
        let (state, commands) = test_state(false);
        insert_session(&state, "pilot", SpeedMode::Low);

        let _ = estop(State(state.clone())).await.expect("estop");
        let err = drive(
            State(state.clone()),
            Json(DriveReq {
                left: 0.1,
                right: 0.1,
                token: Some("pilot".to_string()),
            }),
        )
        .await
        .expect_err("estop should block drive");
        assert_eq!(err.status, StatusCode::FORBIDDEN);
        assert_eq!(err.message, "estop is active");
        assert_eq!(&*commands.lock(), &[(0.0, 0.0)]);

        let _ = estop_reset(State(state.clone()))
            .await
            .expect("explicit estop reset");
        let _ = drive(
            State(state),
            Json(DriveReq {
                left: 0.5,
                right: 0.5,
                token: Some("pilot".to_string()),
            }),
        )
        .await
        .expect("drive after estop reset");
        assert_eq!(&*commands.lock(), &[(0.0, 0.0), (0.0, 0.0), (0.15, 0.15)]);
    }
}

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
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
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
    camera: CameraStatus,
    lidar: SensorAvailability,
    imu: ImuStatus,
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
struct SensorAvailability {
    status: &'static str,
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
                                *raw.write() = parsed;
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
    camera_device: Option<String>,
    camera_stream_url: Option<String>,
    camera_snapshot_url: Option<String>,
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
    lidar: SensorAvailability,
    camera: CameraStatus,
    last_raw_frame_ms: Option<u128>,
}

#[derive(Debug, Serialize)]
struct OdometryStatus {
    left: Option<f64>,
    right: Option<f64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let opts = Opts::parse();
    let raw = Arc::new(RwLock::new(RawTelemetry {
        source: match opts.mode {
            Mode::Sim => "sim",
            Mode::Serial => "serial",
        },
        ..RawTelemetry::default()
    }));
    let command = Arc::new(Mutex::new(CommandState::default()));

    let rover: Arc<dyn RoverControl> = match opts.mode {
        Mode::Sim => Arc::new(SimRover),
        Mode::Serial => SerialRover::open(&opts.serial_port, opts.serial_baud, raw.clone())?,
    };
    let (telemetry_tx, _) = broadcast::channel(128);

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
        camera_device: opts.camera_device,
        camera_stream_url: opts.camera_stream_url,
        camera_snapshot_url: opts.camera_snapshot_url,
    };

    spawn_deadman(state.clone());
    spawn_telemetry_loop(state.clone());
    if matches!(state.mode, Mode::Sim) {
        spawn_sim_telemetry_loop(state.clone());
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
    Json(SensorsResp {
        ok: true,
        role: state.role.clone(),
        ts_ms: now_ms(),
        source: raw.source,
        battery_v: raw.battery_v,
        odometry: OdometryStatus {
            left: raw.odometry_left,
            right: raw.odometry_right,
        },
        imu: imu_status_for(&raw),
        lidar: SensorAvailability {
            status: "unavailable",
        },
        camera: camera_status_for(&state),
        last_raw_frame_ms: raw.last_raw_frame_ms,
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
    if let Some(url) = &state.camera_stream_url {
        return Redirect::temporary(url).into_response();
    }
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
    if let Some(url) = &state.camera_snapshot_url {
        return Redirect::temporary(url).into_response();
    }
    stream(State(state)).await
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

fn current_telemetry_frame(state: &AppState) -> TelemetryFrame {
    let raw = state.raw.read().clone();
    let command = state.command.lock().clone();
    let deadman_ok = command
        .last_cmd_at
        .map(|last| last.elapsed() <= Duration::from_millis(state.deadman_ms))
        .unwrap_or(true);
    TelemetryFrame {
        ts_ms: now_ms(),
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
        camera: camera_status_for(state),
        lidar: SensorAvailability {
            status: "unavailable",
        },
        imu: imu_status_for(&raw),
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
    let has_proxy = state.camera_stream_url.is_some() || state.camera_snapshot_url.is_some();
    let has_device = state.camera_device.is_some();
    CameraStatus {
        status: if has_proxy {
            "proxy"
        } else if has_device {
            "configured"
        } else {
            "placeholder"
        },
        device: state.camera_device.clone(),
        stream_url: state.camera_stream_url.clone(),
        snapshot_url: state.camera_snapshot_url.clone(),
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
    fn ignores_unknown_or_invalid_frames() {
        assert!(parse_esp32_telemetry(r#"{"T":999}"#).is_none());
        assert!(parse_esp32_telemetry("not-json").is_none());
    }
}

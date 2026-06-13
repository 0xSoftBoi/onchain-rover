import { injectedWalletSigner, type WalletChain } from "./signer.js";

type SpeedMode = "low" | "medium" | "high";

type AuthResponse = {
  token?: string;
  robot?: string;
  driveWs?: string;
  telemetryWs?: string;
  streamUrl?: string;
  speedModeUrl?: string;
  stopUrl?: string;
  round?: PilotRoundState;
  error?: string;
};

type DriverSlot = "challenger" | "opponent";
type PilotRoundState = {
  id: string;
  status: string;
  stakeUsdc: string;
  feeUsdc: string;
  durationSecs: number;
  countdownSecs: number;
  roundStartsAt?: number;
  startedAt?: number;
  driver?: {
    slot: DriverSlot;
    wallet: string;
    displayName?: string;
    robot?: string;
    lane?: "left" | "right";
    feePaid?: boolean;
    stakeAuthorized?: boolean;
    chainJoined?: boolean;
  } | null;
};
type StageCalibration = {
  laneLengthFt: number;
  laneWidthFt: number;
  startLineFt: number;
  finishLineFt: number;
  robotAssignments: Record<DriverSlot, { robot: string; lane: "left" | "right" }>;
  speedDefaults: { defaultSpeedMode: SpeedMode; maxSpeedMode: SpeedMode };
  safetyDefaults: { obstacleStopDistanceFt: number; warningDistanceFt: number };
};

type TelemetryFrame = {
  ts_ms?: number;
  robot?: string;
  battery_v?: number;
  left_cmd?: number;
  right_cmd?: number;
  odometry_left?: number;
  odometry_right?: number;
  yaw?: number;
  session_id?: string;
  deadman_ok?: boolean;
  estop?: boolean;
  stopped_by_deadman?: boolean;
  speed_mode?: SpeedMode;
  max_speed?: number;
  last_raw_frame_ms?: number;
  raw_frame_age_ms?: number;
  source?: string;
  camera?: CameraTelemetry;
  lidar?: { front_m?: number; min_m?: number; blocked?: boolean };
  sensors?: {
    camera?: CameraTelemetry;
    raw_frame?: { age_ms?: number };
  };
};

type CameraTelemetry = {
  status?: string;
  health?: string;
  fps?: number;
  last_frame_age_ms?: number;
  resolution?: string;
  brightness?: number;
  reconnect_state?: string;
};

type NippleMove = {
  angle?: { radian: number };
  force?: number;
};

type NippleInstance = {
  on(event: "move", cb: (_event: unknown, data: NippleMove) => void): void;
  on(event: "start" | "end", cb: () => void): void;
};

declare global {
  interface Window {
    nipplejs?: {
      create(opts: {
        zone: HTMLElement;
        mode: "static";
        position: { left: string; top: string };
        color: string;
        size: number;
      }): NippleInstance;
    };
  }
}

const params = new URLSearchParams(location.search);
const robotName = params.get("robot") || "courier";
const robotUrl = normalizeBaseUrl(params.get("robotUrl"));
const providedToken = params.get("token");
const forceLocalCamera = params.get("camera") === "local";
const roundId = params.get("round");
const driverSlot = parseDriverSlot(params.get("slot")) || "challenger";
let speedMode = parseSpeedMode(params.get("speed")) || "medium";

let driveWs: WebSocket | null = null;
let telemetryWs: WebSocket | null = null;
let token = "";
let connected = false;
let telemetryConnected = false;
let started = false;
let hasConnected = false;
let sendInterval: number | undefined;
let reconnectTimer: number | undefined;
let lastDrive = { left: 0, right: 0 };
let lastTelemetryAt = 0;
let localStream: MediaStream | null = null;
let raceEntryComplete = false;
let controlUrls: { speedMode?: string; stop?: string } = {};
let stageCalibration: StageCalibration | null = null;
let stageCalibrationLoaded = false;
let videoState: "idle" | "streaming" | "reconnecting" | "fallback" | "local" = "idle";
let roundState: PilotRoundState | null = null;
let currentStreamUrl = "";
let streamReconnectTimer: number | undefined;
let streamReconnectAttempts = 0;

const els = {
  robotName: byId("robotName"),
  conn: byId("conn"),
  connText: byId("conn").querySelector("span") as HTMLElement,
  video: byId("video") as HTMLImageElement,
  localVideo: byId("localVideo") as HTMLVideoElement,
  videoFallback: byId("videoFallback"),
  direction: byId("direction"),
  battery: byId("battery"),
  latency: byId("latency"),
  deadman: byId("deadman"),
  cap: byId("cap"),
  slotState: byId("slotState"),
  raceTimer: byId("raceTimer"),
  stakeState: byId("stakeState"),
  feeState: byId("feeState"),
  source: byId("source"),
  cameraState: byId("cameraState"),
  lidar: byId("lidar"),
  yaw: byId("yaw"),
  odo: byId("odo"),
  stageLabel: byId("stageLabel"),
  stageProgress: byId("stageProgress"),
  stageMarker: byId("stageMarker"),
  left: byId("left"),
  right: byId("right"),
  estop: byId("estop") as HTMLButtonElement,
  throttle: byId("throttle"),
  zone: byId("zone"),
  startModal: byId("startModal"),
  modalTitle: byId("modalTitle"),
  modalCopy: byId("modalCopy"),
  modalStatus: byId("modalStatus"),
  startButton: byId("startButton") as HTMLButtonElement,
};

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function normalizeBaseUrl(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\/$/, "");
}

function parseSpeedMode(value: string | null): SpeedMode | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function parseDriverSlot(value: string | null): DriverSlot | null {
  return value === "challenger" || value === "opponent" ? value : null;
}

function wsFromHttp(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function deriveTelemetryWs(url: string): string {
  return url.replace(/\/ws\/drive(?:\?.*)?$/, "/ws/telemetry");
}

function setConn(state: "connecting" | "up" | "down", text: string) {
  els.conn.className = `conn ${state === "connecting" ? "" : state}`;
  els.connText.textContent = text;
}

function setModalStatus(text: string, tone: "dim" | "ok" | "bad" = "dim") {
  els.modalStatus.textContent = text;
  els.modalStatus.className = `modal-status ${tone === "dim" ? "" : tone}`;
}

async function authorize(): Promise<AuthResponse> {
  if (roundId && !stageCalibrationLoaded) await loadStageCalibration();
  if (robotUrl) {
    const nextToken = providedToken || `dev-${Date.now()}`;
    if (!providedToken) {
      const res = await fetch(`${robotUrl}/pilot/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: nextToken, ttl_secs: 300, speed_mode: speedMode }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `authorize failed ${res.status}`);
    }
    return {
      token: nextToken,
      robot: robotName,
      driveWs: `${wsFromHttp(robotUrl)}/ws/drive`,
      telemetryWs: `${wsFromHttp(robotUrl)}/ws/telemetry`,
      streamUrl: `${robotUrl}/stream`,
      speedModeUrl: `${robotUrl}/pilot/speed-mode`,
      stopUrl: `${robotUrl}/stop`,
    };
  }

  if (roundId) {
    const res = await fetch(`/race/round/${roundId}/pilot/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: driverSlot, speed_mode: speedMode }),
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || `round pilot session failed ${res.status}`);
    return {
      ...body,
      telemetryWs: body.telemetryWs || (body.driveWs ? deriveTelemetryWs(body.driveWs) : undefined),
    };
  }

  const res = await fetch("/pilot/dev-authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ robot: robotName, speed_mode: speedMode }),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error || `authorize failed ${res.status}`);
  return {
    ...body,
    telemetryWs: body.telemetryWs || (body.driveWs ? deriveTelemetryWs(body.driveWs) : undefined),
  };
}

async function loadStageCalibration() {
  if (!roundId) return;
  try {
    const res = await fetch(`/race/round/${encodeURIComponent(roundId)}/calibration`);
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || `calibration failed ${res.status}`);
    stageCalibration = body.stageCalibration ?? null;
    stageCalibrationLoaded = true;
    renderStageProgress();
  } catch {
    stageCalibrationLoaded = true;
    stageCalibration = null;
  }
}

async function connect() {
  clearTimeout(reconnectTimer);
  setConn("connecting", "connecting");
  try {
    const auth = await authorize();
    if (!auth.token || !auth.driveWs) throw new Error("authorization missing drive endpoint");
    token = auth.token;
    syncRoundState(auth.round);
    controlUrls = { speedMode: auth.speedModeUrl, stop: auth.stopUrl };
    els.robotName.textContent = auth.robot ? `/ ${auth.robot}` : `/ ${robotName}`;
    configureVideo(auth.driveWs, auth.streamUrl);
    openDriveSocket(auth.driveWs);
    if (auth.telemetryWs) openTelemetrySocket(auth.telemetryWs);
    els.startModal.classList.add("hidden");
  } catch (err) {
    setConn("down", err instanceof Error ? err.message : "connection failed");
    if (hasConnected) {
      reconnectTimer = window.setTimeout(connect, 1800);
    } else {
      started = false;
      els.startButton.disabled = false;
      els.startButton.textContent = "TRY AGAIN";
      els.startModal.classList.remove("hidden");
    }
  }
}

async function completeRaceEntryIfNeeded() {
  if (!roundId || raceEntryComplete) return;
  const signer = injectedWalletSigner();

  setModalStatus(`Connecting ${signer.label}...`);
  const wallet = await signer.connect();

  setModalStatus("Claiming driver slot...");
  await postJson(`/race/round/${roundId}/claim-slot`, {
    slot: driverSlot,
    wallet,
  });

  setModalStatus("Opening race escrow...");
  await postJson(`/race/round/${roundId}/chain/open`, {});

  setModalStatus("Preparing typed authorization...");
  const request = await postJson(`/race/round/${roundId}/chain/authorization-request`, {
    slot: driverSlot,
    wallet,
  }) as {
    chain: WalletChain;
    entry: { message: { deadline: string } };
    permit: { message: { deadline: string } };
  };

  await signer.ensureChain(request.chain);

  setModalStatus("Sign race entry...");
  const entrySignature = await signer.signTypedData(wallet, request.entry);

  setModalStatus("Sign token permit...");
  const permitSignature = await signer.signTypedData(wallet, request.permit);

  setModalStatus("Submitting race entry...");
  await postJson(`/race/round/${roundId}/chain/join`, {
    slot: driverSlot,
    entrySignature,
    permitSignature,
    entryDeadline: request.entry.message.deadline,
    permitDeadline: request.permit.message.deadline,
  });
  raceEntryComplete = true;
  setModalStatus("Race entry confirmed", "ok");
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(json.error || `request failed ${res.status}`);
  }
  return json;
}

function syncRoundState(next?: PilotRoundState) {
  if (next) roundState = next;
  renderRoundState();
}

function renderRoundState() {
  const driver = roundState?.driver;
  const slotLabel = driver?.slot === "challenger" ? "chal" : driver?.slot === "opponent" ? "opp" : driverSlot;
  const robot = driver?.robot || robotName;
  const lane = driver?.lane ? `/${driver.lane}` : "";
  els.slotState.textContent = roundId ? `${slotLabel}/${robot}${lane}` : "dev";
  els.stakeState.textContent = roundState?.stakeUsdc ? `$${roundState.stakeUsdc}` : "--";
  els.feeState.textContent = roundState?.feeUsdc ? `$${roundState.feeUsdc}` : "--";
  updateRaceTimer();
}

function roundStartMs(): number | null {
  return roundState?.startedAt ?? roundState?.roundStartsAt ?? null;
}

function driveUnlocked(): boolean {
  if (!started) return false;
  if (!roundId) return true;
  const startMs = roundStartMs();
  return roundState?.status === "racing" || Boolean(startMs && Date.now() >= startMs);
}

function updateRaceTimer() {
  if (!roundId) {
    els.raceTimer.textContent = "--";
    return;
  }
  if (!roundState) {
    els.raceTimer.textContent = "entry";
    return;
  }
  const startMs = roundStartMs();
  const now = Date.now();
  if (startMs && now < startMs) {
    const left = Math.ceil((startMs - now) / 1000);
    els.raceTimer.textContent = `-${left}s`;
    if (started) els.direction.textContent = `GO in ${left}`;
    return;
  }
  if (startMs) {
    const elapsed = Math.max(0, Math.floor((now - startMs) / 1000));
    const remaining = Math.max(0, roundState.durationSecs - elapsed);
    els.raceTimer.textContent = remaining > 0 ? `${remaining}s` : "done";
    if (started && !connected) els.direction.textContent = "GO";
    return;
  }
  els.raceTimer.textContent = roundState.status || "wait";
}

function openDriveSocket(url: string) {
  driveWs?.close();
  driveWs = new WebSocket(url);
  driveWs.onopen = () => {
    connected = true;
    hasConnected = true;
    setConn("up", telemetryConnected ? "drive + telemetry" : "drive connected");
    updateRaceTimer();
  };
  driveWs.onmessage = (event) => {
    try {
      const body = JSON.parse(event.data);
      if (body?.error === "round has not started") {
        updateRaceTimer();
      } else if (body?.error) {
        els.direction.textContent = body.error;
      }
    } catch {
      // Ignore non-control messages from older bridge versions.
    }
  };
  driveWs.onclose = () => {
    connected = false;
    setConn("down", "drive disconnected");
    stopSending();
    reconnectTimer = window.setTimeout(connect, 1500);
  };
  driveWs.onerror = () => setConn("down", "drive error");
}

function openTelemetrySocket(url: string) {
  telemetryWs?.close();
  telemetryWs = new WebSocket(url);
  telemetryWs.onopen = () => {
    telemetryConnected = true;
    setConn(connected ? "up" : "connecting", connected ? "drive + telemetry" : "telemetry connected");
  };
  telemetryWs.onmessage = (event) => {
    try {
      renderTelemetry(JSON.parse(event.data));
    } catch {
      // Drop malformed telemetry frames.
    }
  };
  telemetryWs.onclose = () => {
    telemetryConnected = false;
    if (connected) setConn("up", "drive only");
  };
}

function configureVideo(driveUrl: string, streamUrl?: string) {
  clearStreamReconnect();
  const base = httpBaseFromDriveUrl(driveUrl);
  if (forceLocalCamera) {
    startLocalCamera();
    return;
  }
  currentStreamUrl = streamUrl || `${base}/stream`;
  connectRemoteStream();
}

function connectRemoteStream() {
  if (!currentStreamUrl) return;
  videoState = streamReconnectAttempts > 0 ? "reconnecting" : "idle";
  els.videoFallback.textContent = streamReconnectAttempts > 0 ? "camera reconnecting" : "connecting camera";
  els.videoFallback.style.display = "grid";
  els.video.classList.add("off");
  els.video.style.display = "block";
  els.video.src = cacheBustUrl(currentStreamUrl);
  els.video.onload = () => {
    videoState = "streaming";
    streamReconnectAttempts = 0;
    els.video.classList.remove("off");
    els.video.style.display = "block";
    els.localVideo.classList.add("off");
    els.localVideo.style.display = "none";
    els.videoFallback.style.display = "none";
  };
  els.video.onerror = () => {
    handleRemoteStreamFailure();
  };
}

function handleRemoteStreamFailure() {
  videoState = "reconnecting";
  els.video.classList.add("off");
  els.videoFallback.textContent = "camera reconnecting";
  els.videoFallback.style.display = "grid";
  scheduleStreamReconnect();
}

function scheduleStreamReconnect() {
  clearStreamReconnect();
  streamReconnectAttempts += 1;
  const delayMs = Math.min(5000, 700 + streamReconnectAttempts * 800);
  streamReconnectTimer = window.setTimeout(connectRemoteStream, delayMs);
}

function clearStreamReconnect() {
  if (streamReconnectTimer) window.clearTimeout(streamReconnectTimer);
  streamReconnectTimer = undefined;
}

function cacheBustUrl(value: string): string {
  const url = new URL(value, location.href);
  url.searchParams.set("stream_ts", String(Date.now()));
  return url.toString();
}

async function startLocalCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    els.videoFallback.textContent = "camera unavailable";
    els.videoFallback.style.display = "grid";
    return;
  }
  try {
    localStream ??= await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    videoState = "local";
    els.localVideo.srcObject = localStream;
    els.localVideo.style.display = "block";
    els.localVideo.classList.remove("off");
    els.video.style.display = "none";
    els.videoFallback.style.display = "none";
  } catch {
    videoState = "fallback";
    els.videoFallback.textContent = "camera permission needed";
    els.videoFallback.style.display = "grid";
  }
}

function send(left: number, right: number) {
  if (!started) return;
  if (!driveUnlocked()) {
    updateRaceTimer();
    return;
  }
  if (!connected || !driveWs || driveWs.readyState !== WebSocket.OPEN) return;
  driveWs.send(JSON.stringify({ left, right, token, speed_mode: speedMode, t: Date.now() }));
  els.left.textContent = left.toFixed(2);
  els.right.textContent = right.toFixed(2);
  els.direction.textContent = drivePrompt(left, right);
}

function drivePrompt(left: number, right: number): string {
  const avg = (left + right) / 2;
  const turn = left - right;
  if (Math.abs(avg) < 0.08 && Math.abs(turn) < 0.08) return "Hold position";
  if (Math.abs(turn) > Math.abs(avg) * 1.3) return turn > 0 ? "Turn right" : "Turn left";
  if (avg < -0.08) return "Reverse";
  return "Drive forward";
}

function startSending() {
  stopSending();
  sendInterval = window.setInterval(() => send(lastDrive.left, lastDrive.right), 80);
}

function stopSending() {
  if (sendInterval) window.clearInterval(sendInterval);
  sendInterval = undefined;
  lastDrive = { left: 0, right: 0 };
  send(0, 0);
}

async function setSpeedMode(mode: SpeedMode) {
  speedMode = mode;
  renderSpeedMode(mode);
  if (!robotUrl && !token) return;
  const base = robotUrl || currentRobotHttpBase();
  const url = controlUrls.speedMode || (base ? `${base}/pilot/speed-mode` : "");
  if (!url || !token) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, speed_mode: mode }),
    });
  } catch {
    // Older robot APIs do not have speed-mode yet; server-side caps still own safety.
  }
}

function currentRobotHttpBase(): string | null {
  if (!driveWs?.url) return null;
  return httpBaseFromDriveUrl(driveWs.url);
}

function httpBaseFromDriveUrl(driveUrl: string): string {
  const httpUrl = driveUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  try {
    const url = new URL(httpUrl, location.href);
    if (url.pathname === "/ws/drive") return url.origin;
    url.pathname = url.pathname.replace(/\/ws\/drive$/, "");
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return httpUrl.replace(/\/ws\/drive(?:\?.*)?$/, "");
  }
}

function renderSpeedMode(mode: SpeedMode) {
  els.throttle.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", (button as HTMLButtonElement).dataset.speed === mode);
  });
}

function renderTelemetry(frame: TelemetryFrame) {
  lastTelemetryAt = Date.now();
  const left = frame.left_cmd ?? 0;
  const right = frame.right_cmd ?? 0;
  els.left.textContent = left.toFixed(2);
  els.right.textContent = right.toFixed(2);
  els.source.textContent = frame.source || "bridge";
  els.battery.textContent = frame.battery_v !== undefined ? `${frame.battery_v.toFixed(2)}V` : "--";
  els.cap.textContent = frame.max_speed !== undefined ? frame.max_speed.toFixed(2) : "--";
  const camera = cameraHealth(frame);
  els.cameraState.textContent = camera.label;
  els.cameraState.className = camera.tone;
  els.lidar.textContent = lidarLabel(frame);
  els.yaw.textContent = frame.yaw !== undefined ? `${frame.yaw.toFixed(0)}deg` : "--";
  els.odo.textContent = odometryLabel(frame);
  renderStageProgress(frame);
  speedMode = frame.speed_mode || speedMode;
  renderSpeedMode(speedMode);

  const deadmanText = frame.estop
    ? "estop"
    : frame.stopped_by_deadman
      ? "stopped"
      : frame.deadman_ok
        ? "ready"
        : "stale";
  els.deadman.textContent = deadmanText;
  els.deadman.className = frame.estop || frame.stopped_by_deadman ? "bad" : frame.deadman_ok ? "ok" : "warn";

  const lag = frame.ts_ms ? Math.max(0, Date.now() - frame.ts_ms) : null;
  els.latency.textContent = lag === null ? "--" : `${lag}ms`;
  els.latency.className = lag !== null && lag > 500 ? "warn" : "";
  els.lidar.className = frame.lidar?.blocked ? "bad" : "";

  if (frame.estop) {
    els.direction.textContent = "Emergency stop";
  } else if (frame.lidar?.blocked) {
    els.direction.textContent = "Obstacle ahead";
  } else if (!started) {
    els.direction.textContent = "Tap start to drive";
  } else if (!driveUnlocked()) {
    updateRaceTimer();
  }
}

function cameraHealth(frame: TelemetryFrame): { label: string; tone: "" | "ok" | "warn" | "bad" } {
  const camera = frame.camera ?? frame.sensors?.camera;
  if (forceLocalCamera || videoState === "local") {
    return { label: camera?.status ? `local/${camera.status}` : "local", tone: "ok" };
  }
  if (videoState === "reconnecting") return { label: "reconnect", tone: "warn" };
  if (videoState === "fallback") return { label: "missing", tone: "bad" };

  const age = camera?.last_frame_age_ms ?? frame.raw_frame_age_ms ?? frame.sensors?.raw_frame?.age_ms;
  const health = camera?.health ?? deriveCameraHealth(camera?.status, age);
  if (age !== undefined && age > 1500) return { label: `stale ${age.toFixed(0)}ms`, tone: "warn" };
  if (health === "healthy") {
    const fps = camera?.fps !== undefined ? ` ${camera.fps.toFixed(0)}fps` : "";
    return { label: `${camera?.status || "ok"}${fps}`, tone: "ok" };
  }
  if (health === "degraded") return { label: camera?.reconnect_state || camera?.status || "degraded", tone: "warn" };
  if (health === "missing") return { label: camera?.status || "missing", tone: "bad" };
  return { label: camera?.status || "--", tone: "" };
}

function deriveCameraHealth(status?: string, age?: number): string {
  if (age !== undefined && age > 1500) return "stale";
  if (status === "simulated" || status === "proxy") return "healthy";
  if (status === "configured") return "degraded";
  if (status === "unavailable" || status === "missing" || status === "error") return "missing";
  return "";
}

function lidarLabel(frame: TelemetryFrame): string {
  const lidar = frame.lidar;
  if (!lidar) return "--";
  const distance = lidar.front_m ?? lidar.min_m;
  if (distance === undefined) return lidar.blocked ? "blocked" : "--";
  return `${lidar.blocked ? "!" : ""}${distance.toFixed(2)}m`;
}

function odometryLabel(frame: TelemetryFrame): string {
  const left = frame.odometry_left;
  const right = frame.odometry_right;
  if (left === undefined && right === undefined) return "--";
  if (left !== undefined && right !== undefined) return `${((left + right) / 2).toFixed(1)}m`;
  return `${(left ?? right ?? 0).toFixed(1)}m`;
}

function renderStageProgress(frame?: TelemetryFrame) {
  const calibration = stageCalibration;
  if (!calibration) {
    els.stageLabel.textContent = "stage";
    els.stageProgress.textContent = "--";
    (els.stageMarker as HTMLElement).style.left = "0%";
    return;
  }
  const runFt = Math.max(1, calibration.finishLineFt - calibration.startLineFt);
  const odometryFt = odometryMeters(frame) * 3.28084;
  const progress = Math.max(0, Math.min(1, (odometryFt - calibration.startLineFt) / runFt));
  const traveledFt = Math.max(0, Math.min(runFt, odometryFt - calibration.startLineFt));
  const slotAssignment = calibration.robotAssignments[driverSlot];
  els.stageLabel.textContent = `${runFt.toFixed(0)}ft / ${calibration.laneWidthFt.toFixed(1)}ft ${slotAssignment?.lane ?? ""}`.trim();
  els.stageProgress.textContent = `${traveledFt.toFixed(1)}ft`;
  (els.stageMarker as HTMLElement).style.left = `${(progress * 100).toFixed(1)}%`;
}

function odometryMeters(frame?: TelemetryFrame): number {
  if (!frame) return 0;
  const left = frame.odometry_left;
  const right = frame.odometry_right;
  if (left !== undefined && right !== undefined) return (left + right) / 2;
  return left ?? right ?? 0;
}

function setupJoystick() {
  if (!window.nipplejs) {
    els.direction.textContent = "Joystick failed to load";
    return;
  }

  const joy = window.nipplejs.create({
    zone: els.zone,
    mode: "static",
    position: { left: "50%", top: "58%" },
    color: "#59a6ff",
    size: 140,
  });

  joy.on("move", (_event, data) => {
    const force = Math.min(data.force ?? 0, 1);
    const angle = data.angle?.radian ?? Math.PI / 2;
    const fwd = Math.sin(angle) * force;
    const turn = Math.cos(angle) * force;
    lastDrive = {
      left: Math.max(-1, Math.min(1, fwd + turn * 0.6)),
      right: Math.max(-1, Math.min(1, fwd - turn * 0.6)),
    };
  });
  joy.on("start", startSending);
  joy.on("end", stopSending);
}

function setupControls() {
  els.estop.onclick = () => {
    stopSending();
    if (controlUrls.stop) {
      fetch(controlUrls.stop, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }).catch(() => undefined);
      return;
    }
    const base = currentRobotHttpBase();
    if (base) {
      fetch(`${base}/stop`, { method: "POST" }).catch(() => undefined);
    } else {
      fetch(`/estop/${robotName}`, { method: "POST" }).catch(() => undefined);
    }
  };

  els.startButton.onclick = async () => {
    els.startButton.disabled = true;
    els.startButton.textContent = roundId && !raceEntryComplete ? "SIGNING" : "CONNECTING";
    try {
      await completeRaceEntryIfNeeded();
      started = true;
      els.startButton.textContent = "CONNECTING";
      connect();
    } catch (err) {
      started = false;
      els.startButton.disabled = false;
      els.startButton.textContent = "TRY AGAIN";
      setModalStatus(err instanceof Error ? err.message : "race entry failed", "bad");
    }
  };

  els.throttle.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const next = parseSpeedMode((button as HTMLButtonElement).dataset.speed || "");
      if (next) setSpeedMode(next);
    });
  });
  renderSpeedMode(speedMode);
}

setInterval(() => {
  updateRaceTimer();
  if (lastTelemetryAt && Date.now() - lastTelemetryAt > 1200) {
    els.latency.textContent = "stale";
    els.latency.className = "warn";
    els.source.textContent = "stale";
    els.cameraState.textContent = "stale";
    els.cameraState.className = "warn";
  }
}, 500);

els.robotName.textContent = `/ ${robotName}`;
renderRoundState();
if (roundId) {
  els.modalTitle.textContent = "Enter Race";
  els.modalCopy.textContent = `Sign entry for ${driverSlot}. Camera stays live once your entry is confirmed.`;
  setModalStatus("Wallet signature required");
  void loadStageCalibration();
}
if (robotUrl) {
  configureVideo(`${wsFromHttp(robotUrl)}/ws/drive`, `${robotUrl}/stream`);
}
setupControls();
setupJoystick();

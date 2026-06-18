import {
  createWalletSigner,
  walletDisplayName,
  type RaceAuthorizationRequest,
} from "./signer.js";
import { estimateStagePosition } from "../src/stage-estimator.js";

type SpeedMode = "low" | "medium" | "high";

type AuthResponse = {
  token?: string;
  robot?: string;
  driveWs?: string;
  cameraWs?: string;
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
  chainRaceId?: string;
  stakeUsdc: string;
  stakeAsset?: "usdc" | "native-eth";
  stakeWei?: string;
  stakeDisplay?: string;
  chainNetwork?: string;
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
  sensorOffsets?: Record<string, {
    cameraForwardFt?: number;
    cameraRightFt?: number;
    lidarForwardFt?: number;
    lidarRightFt?: number;
  }>;
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
  soft_odometry_limited?: boolean;
  soft_odometry_limit_m?: number;
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
  pan?: number;
  tilt?: number;
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
    __pilotReady?: boolean;
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
const manualMode = params.get("mode") === "manual";
const roundId = manualMode ? null : params.get("round");
const x402OnlyEntry = params.get("entry") === "x402" || params.get("show") === "1";
const driverSlot = parseDriverSlot(params.get("slot")) || "challenger";
const requestedSpeedMode = parseSpeedMode(params.get("speed"));
let speedMode: SpeedMode = manualMode
  ? requestedSpeedMode === "high" ? "high" : "medium"
  : requestedSpeedMode || "medium";
document.documentElement.dataset.mode = manualMode ? "manual" : "race";

let driveWs: WebSocket | null = null;
let cameraWs: WebSocket | null = null;
let telemetryWs: WebSocket | null = null;
let token = "";
let connected = false;
let telemetryConnected = false;
let started = false;
let pilotStarting = false;
let hasConnected = false;
let sendInterval: number | undefined;
let cameraSendInterval: number | undefined;
let reconnectTimer: number | undefined;
let cameraReconnectTimer: number | undefined;
let cameraReconnectUrl = "";
let lastDrive = { left: 0, right: 0 };
let lastCamera = { pan: 0, tilt: 0 };
let lastTelemetryAt = 0;
let localStream: MediaStream | null = null;
let raceEntryComplete = false;
let controlUrls: { speedMode?: string; stop?: string } = {};
let stageCalibration: StageCalibration | null = null;
let stageCalibrationLoaded = false;
let videoState: "idle" | "streaming" | "reconnecting" | "fallback" | "local" = "idle";
let roundState: PilotRoundState | null = null;
let currentStreamUrl = "";
let pendingStreamUrl = "";
let streamReconnectTimer: number | undefined;
let streamWatchdogTimer: number | undefined;
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
  cameraDetail: byId("cameraDetail"),
  lidar: byId("lidar"),
  yaw: byId("yaw"),
  odo: byId("odo"),
  minimap: byId("minimap"),
  stageLabel: byId("stageLabel"),
  stageProgress: byId("stageProgress"),
  stageMarker: byId("stageMarker"),
  stageLane: byId("stageLane"),
  stageConfidence: byId("stageConfidence"),
  left: byId("left"),
  right: byId("right"),
  estop: byId("estop") as HTMLButtonElement,
  throttle: byId("throttle"),
  zone: byId("zone"),
  driveZone: byId("driveZone"),
  cameraZone: byId("cameraZone"),
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

function deriveCameraWs(url: string): string {
  return url.replace(/\/ws\/drive/, "/ws/camera");
}

function setConn(state: "connecting" | "up" | "down", text: string) {
  els.conn.className = `conn ${state === "connecting" ? "" : state}`;
  els.connText.textContent = text;
}

function setModalStatus(text: string, tone: "dim" | "ok" | "bad" = "dim") {
  els.modalStatus.textContent = text;
  els.modalStatus.className = `modal-status ${tone === "dim" ? "" : tone}`;
}

async function beginPilot() {
  if (started || pilotStarting) return;
  pilotStarting = true;
  els.startButton.disabled = true;
  els.startButton.textContent = roundId && !raceEntryComplete ? "CHECKING" : "CONNECTING";
  setModalStatus("Opening pilot session...");
  try {
    await completeRaceEntryIfNeeded();
    started = true;
    setModalStatus("Connecting controls...");
    connect();
  } catch (err) {
    pilotStarting = false;
    started = false;
    els.startButton.disabled = false;
    els.startButton.textContent = "TRY AGAIN";
    setModalStatus(err instanceof Error ? err.message : "race entry failed", "bad");
  }
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
      cameraWs: `${wsFromHttp(robotUrl)}/ws/camera`,
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
      cameraWs: body.cameraWs || (body.driveWs ? deriveCameraWs(body.driveWs) : undefined),
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
    cameraWs: body.cameraWs || (body.driveWs ? deriveCameraWs(body.driveWs) : undefined),
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
    if (manualMode) {
      stopCameraSending(false);
    } else {
      openCameraSocket(auth.cameraWs || deriveCameraWs(auth.driveWs));
    }
    if (auth.telemetryWs) openTelemetrySocket(auth.telemetryWs);
    els.startModal.classList.add("hidden");
    pilotStarting = false;
  } catch (err) {
    pilotStarting = false;
    const message = err instanceof Error ? err.message : "connection failed";
    setConn("down", message);
    if (roundId && isRaceWaitError(message)) {
      setConn("connecting", "waiting for race start");
      setModalStatus(message.includes("round must be locked") ? "Waiting for second driver..." : "Waiting for countdown...");
      reconnectTimer = window.setTimeout(connect, 1200);
      return;
    }
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
  if (await useExistingRaceEntryIfReady()) return;
  const round = await getPilotRound();
  if (round.stakeAsset === "native-eth") {
    throw new Error("Stake from the Clanker500 join screen first");
  }
  const signer = createWalletSigner();

  setModalStatus(`Connecting ${signer.label}...`);
  const session = await signer.connect();

  setModalStatus("Claiming driver slot...");
  await postJson(`/race/round/${roundId}/claim-slot`, {
    slot: driverSlot,
    wallet: session.address,
    displayName: walletDisplayName(session),
  });

  setModalStatus("Paying race fee...");
  try {
    await signer.payRaceFee(session, {
      roundId,
      slot: driverSlot,
      displayName: walletDisplayName(session),
    });
  } catch (err) {
    if (!x402OnlyEntry) throw err;
    setModalStatus("Recording Arc entry...");
    await postJson(`/race/round/${roundId}/show-enter`, {
      slot: driverSlot,
      wallet: session.address,
      displayName: walletDisplayName(session),
      reason: err instanceof Error ? err.message : "x402 pending",
    });
    raceEntryComplete = true;
    setModalStatus("Entry confirmed. Waiting for countdown...", "ok");
    return;
  }

  if (x402OnlyEntry) {
    setModalStatus("Confirming race entry...");
    await postJson(`/race/round/${roundId}/stake-authorize`, {
      slot: driverSlot,
      authorization: {
        adapter: "manual",
        status: "verified",
        source: "show-x402-entry",
        amountUsdc: "0",
      },
    });
    raceEntryComplete = true;
    setModalStatus("Entry confirmed. Waiting for countdown...", "ok");
    return;
  }

  setModalStatus("Authorizing matched stake...");
  await signer.authorizeStake(session, {
    roundId,
    slot: driverSlot,
  });

  setModalStatus("Opening race escrow...");
  await postJson(`/race/round/${roundId}/chain/open`, {});

  setModalStatus("Preparing typed authorization...");
  const request = await postJson(`/race/round/${roundId}/chain/authorization-request`, {
    slot: driverSlot,
    wallet: session.address,
  }) as RaceAuthorizationRequest;

  setModalStatus("Sign race entry and permit...");
  const signed = await signer.signRaceIntent(session, request);
  if (!signed.entryDeadline || !signed.permitDeadline) {
    throw new Error("race authorization deadlines missing");
  }

  setModalStatus("Submitting race entry...");
  await postJson(`/race/round/${roundId}/chain/join`, {
    slot: driverSlot,
    entrySignature: signed.entrySignature,
    permitSignature: signed.permitSignature,
    entryDeadline: signed.entryDeadline,
    permitDeadline: signed.permitDeadline,
  });
  raceEntryComplete = true;
  setModalStatus("Race entry confirmed", "ok");
}

function isRaceWaitError(message: string): boolean {
  return message.includes("round must be locked before pilot delegation")
    || message.includes("countdown has not been scheduled")
    || message.includes("round has not started");
}

async function useExistingRaceEntryIfReady(): Promise<boolean> {
  if (!roundId) return false;
  const round = await getPilotRound();
  const driver = round.drivers?.[driverSlot];
  if (!driver) return false;
  const chainReady = !round.chainRaceId || driver.chainJoined === true;
  if (driver.feePaid === true && driver.stakeAuthorized === true && chainReady) {
    roundState = {
      id: round.id,
      status: round.status,
      chainRaceId: round.chainRaceId,
      stakeUsdc: round.stakeUsdc,
      stakeAsset: round.stakeAsset,
      stakeWei: round.stakeWei,
      stakeDisplay: round.stakeDisplay,
      chainNetwork: round.chainNetwork,
      feeUsdc: round.feeUsdc,
      durationSecs: round.durationSecs,
      countdownSecs: round.countdownSecs,
      roundStartsAt: round.roundStartsAt,
      startedAt: round.startedAt,
      driver: {
        slot: driverSlot,
        wallet: driver.wallet,
        displayName: driver.displayName,
        robot: driver.robot,
        lane: driver.lane,
        feePaid: driver.feePaid,
        stakeAuthorized: driver.stakeAuthorized,
        chainJoined: Boolean(driver.chainJoined),
      },
    };
    renderRoundState();
    raceEntryComplete = true;
    setModalStatus("Race entry already confirmed", "ok");
    return true;
  }
  return false;
}

async function getPilotRound(): Promise<PilotRoundState & {
  drivers?: Record<DriverSlot, PilotRoundState["driver"]>;
}> {
  const res = await fetch(`/race/round/${encodeURIComponent(roundId!)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `round lookup failed ${res.status}`);
  return json;
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
  els.stakeState.textContent = roundState?.stakeAsset === "native-eth"
    ? roundState.stakeDisplay ?? "ETH"
    : roundState?.stakeUsdc ? `$${roundState.stakeUsdc}` : "--";
  els.feeState.textContent = roundState?.feeUsdc ? `$${roundState.feeUsdc}` : "--";
  updateRaceTimer();
}

function roundStartMs(): number | null {
  return roundState?.startedAt ?? roundState?.roundStartsAt ?? null;
}

function driveUnlocked(): boolean {
  if (!started) return false;
  if (manualMode) return true;
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

function openCameraSocket(url: string) {
  clearCameraReconnect();
  cameraReconnectUrl = url;
  cameraWs?.close();
  const socket = new WebSocket(url);
  cameraWs = socket;
  socket.onopen = () => {
    startCameraSending();
  };
  socket.onmessage = (event) => {
    try {
      const body = JSON.parse(event.data);
      if (body?.error) els.cameraDetail.textContent = body.error;
    } catch {
      // Ignore non-control messages from older bridge versions.
    }
  };
  socket.onclose = () => {
    if (cameraWs !== socket) return;
    stopCameraSending(false);
    if (started && connected) {
      cameraReconnectTimer = window.setTimeout(() => openCameraSocket(cameraReconnectUrl), 900);
    }
  };
}

function clearCameraReconnect() {
  if (cameraReconnectTimer) window.clearTimeout(cameraReconnectTimer);
  cameraReconnectTimer = undefined;
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
  const base = httpBaseFromDriveUrl(driveUrl);
  const nextStreamUrl = streamUrl || `${base}/stream`;
  if (forceLocalCamera) {
    clearStreamReconnect();
    clearStreamWatchdog();
    currentStreamUrl = nextStreamUrl;
    pendingStreamUrl = "";
    startLocalCamera();
    return;
  }
  if (
    currentStreamUrl === nextStreamUrl
    && els.video.src
    && (videoState === "streaming" || videoState === "reconnecting")
  ) {
    pendingStreamUrl = "";
    return;
  }
  if (hasVisibleRemoteFrame()) {
    pendingStreamUrl = nextStreamUrl;
    return;
  }
  clearStreamReconnect();
  clearStreamWatchdog();
  currentStreamUrl = nextStreamUrl;
  pendingStreamUrl = "";
  streamReconnectAttempts = 0;
  connectRemoteStream();
}

function connectRemoteStream(forceRefresh = false) {
  if (!currentStreamUrl) return;
  const hadFrame = hasVisibleRemoteFrame();
  videoState = streamReconnectAttempts > 0 ? "reconnecting" : "idle";
  if (!hadFrame) {
    els.videoFallback.textContent = streamReconnectAttempts > 0 ? "camera reconnecting" : "connecting camera";
    els.videoFallback.style.display = "grid";
    els.video.classList.add("off");
  }
  els.video.style.display = "block";
  els.video.src = forceRefresh ? cacheBustUrl(currentStreamUrl) : currentStreamUrl;
  els.video.onload = () => {
    videoState = "streaming";
    streamReconnectAttempts = 0;
    clearStreamWatchdog();
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
  const hadFrame = hasVisibleRemoteFrame();
  videoState = "reconnecting";
  clearStreamWatchdog();
  if (!hadFrame) {
    els.video.classList.add("off");
    els.videoFallback.textContent = "camera reconnecting";
    els.videoFallback.style.display = "grid";
  }
  if (pendingStreamUrl && pendingStreamUrl !== currentStreamUrl) {
    currentStreamUrl = pendingStreamUrl;
    pendingStreamUrl = "";
    streamReconnectAttempts = 0;
  }
  scheduleStreamReconnect();
}

function hasVisibleRemoteFrame() {
  return Boolean(
    els.video.src
    && !els.video.classList.contains("off")
    && (videoState === "streaming" || videoState === "reconnecting"),
  );
}

function scheduleStreamReconnect() {
  clearStreamReconnect();
  streamReconnectAttempts += 1;
  const delayMs = Math.min(5000, 700 + streamReconnectAttempts * 800);
  streamReconnectTimer = window.setTimeout(() => connectRemoteStream(true), delayMs);
}

function clearStreamReconnect() {
  if (streamReconnectTimer) window.clearTimeout(streamReconnectTimer);
  streamReconnectTimer = undefined;
}

function startStreamWatchdog() {
  clearStreamWatchdog();
}

function clearStreamWatchdog() {
  if (streamWatchdogTimer) window.clearInterval(streamWatchdogTimer);
  streamWatchdogTimer = undefined;
}

function cacheBustUrl(value: string): string {
  const url = new URL(value, location.href);
  url.searchParams.set("stream_ts", String(Date.now()));
  return url.toString();
}

async function startLocalCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    fallbackToRemoteStream("camera unavailable");
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
    fallbackToRemoteStream("camera permission needed");
  }
}

function fallbackToRemoteStream(message: string) {
  if (currentStreamUrl) {
    videoState = "reconnecting";
    els.videoFallback.textContent = `${message}; trying robot camera`;
    els.videoFallback.style.display = "grid";
    connectRemoteStream();
    return;
  }
  videoState = "fallback";
  els.videoFallback.textContent = message;
  els.videoFallback.style.display = "grid";
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

function sendCamera(pan: number, tilt: number) {
  if (!started) return;
  if (!cameraWs || cameraWs.readyState !== WebSocket.OPEN) return;
  cameraWs.send(JSON.stringify({ pan, tilt, token, speed_mode: speedMode }));
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
  clearSendInterval();
  send(lastDrive.left, lastDrive.right);
  sendInterval = window.setInterval(() => send(lastDrive.left, lastDrive.right), 33);
}

function startCameraSending() {
  clearCameraSendInterval();
  cameraSendInterval = window.setInterval(() => sendCamera(lastCamera.pan, lastCamera.tilt), 33);
}

function clearSendInterval() {
  if (sendInterval) window.clearInterval(sendInterval);
  sendInterval = undefined;
}

function clearCameraSendInterval() {
  if (cameraSendInterval) window.clearInterval(cameraSendInterval);
  cameraSendInterval = undefined;
}

function stopSending() {
  clearSendInterval();
  stopCameraSending();
  lastDrive = { left: 0, right: 0 };
  setStickKnob(els.driveZone, 0, 0);
  send(0, 0);
}

function stopCameraSending(sendZero = true) {
  clearCameraSendInterval();
  lastCamera = { pan: 0, tilt: 0 };
  if (sendZero) sendCamera(0, 0);
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
  els.cameraDetail.textContent = camera.detail;
  els.cameraDetail.className = camera.tone;
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
  els.lidar.className = "";

  if (frame.estop) {
    els.direction.textContent = "Emergency stop";
  } else if (frame.soft_odometry_limited) {
    els.direction.textContent = "Stage limit";
  } else if (!started) {
    els.direction.textContent = "Tap start to drive";
  } else if (!driveUnlocked()) {
    updateRaceTimer();
  }
}

function cameraHealth(frame: TelemetryFrame): { label: string; detail: string; tone: "" | "ok" | "warn" | "bad" } {
  const camera = frame.camera ?? frame.sensors?.camera;
  const detail = cameraDetail(camera, frame);
  if (forceLocalCamera || videoState === "local") {
    return { label: camera?.status ? `local/${camera.status}` : "local", detail, tone: "ok" };
  }
  if (videoState === "reconnecting") return { label: "reconnect", detail, tone: "warn" };
  if (videoState === "fallback") return { label: "missing", detail, tone: "bad" };

  const age = camera?.last_frame_age_ms ?? frame.raw_frame_age_ms ?? frame.sensors?.raw_frame?.age_ms;
  const health = camera?.health ?? deriveCameraHealth(camera?.status, age);
  if (age !== undefined && age > 1500) return { label: "stale", detail, tone: "warn" };
  if (health === "healthy") {
    return { label: camera?.status || "ok", detail, tone: "ok" };
  }
  if (health === "degraded") return { label: camera?.reconnect_state || camera?.status || "degraded", detail, tone: "warn" };
  if (health === "missing") return { label: camera?.status || "missing", detail, tone: "bad" };
  return { label: camera?.status || "--", detail, tone: "" };
}

function deriveCameraHealth(status?: string, age?: number): string {
  if (age !== undefined && age > 1500) return "stale";
  if (status === "simulated" || status === "proxy") return "healthy";
  if (status === "configured") return "degraded";
  if (status === "unavailable" || status === "missing" || status === "error") return "missing";
  return "";
}

function cameraDetail(camera: CameraTelemetry | undefined, frame: TelemetryFrame): string {
  const age = camera?.last_frame_age_ms ?? frame.raw_frame_age_ms ?? frame.sensors?.raw_frame?.age_ms;
  const panTilt = camera?.pan !== undefined || camera?.tilt !== undefined
    ? `p${(camera.pan ?? 0).toFixed(1)} t${(camera.tilt ?? 0).toFixed(1)}`
    : undefined;
  const parts = [
    camera?.fps !== undefined ? `${camera.fps.toFixed(0)}fps` : undefined,
    age !== undefined ? `${age.toFixed(0)}ms` : undefined,
    panTilt,
    camera?.resolution,
    camera?.brightness !== undefined ? `b${camera.brightness.toFixed(0)}` : undefined,
    camera?.reconnect_state && camera.reconnect_state !== "stable" ? camera.reconnect_state : undefined,
  ].filter(Boolean);
  return parts.length ? parts.slice(0, 3).join(" ") : "--";
}

function lidarLabel(frame: TelemetryFrame): string {
  const lidar = frame.lidar;
  if (!lidar) return "--";
  const distance = lidar.front_m ?? lidar.min_m;
  if (distance === undefined) return "--";
  return `${distance.toFixed(2)}m`;
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
    els.stageLane.textContent = "--";
    els.stageConfidence.textContent = "--";
    els.minimap.className = "minimap missing";
    setStageMarker(0, 50, 0);
    return;
  }
  const slotAssignment = calibration.robotAssignments[driverSlot];
  const estimate = estimateStagePosition({
    calibration,
    slot: driverSlot,
    robot: frame?.robot ?? slotAssignment?.robot ?? robotName,
    frame,
  });
  const x = estimate.progress === null ? 0 : estimate.progress * 100;
  const y = estimate.lanePositionPct ?? 50;
  const heading = estimate.headingDeg ?? 0;
  const lane = estimate.lane ?? slotAssignment?.lane;

  els.minimap.className = `minimap ${estimate.state}`;
  els.stageLabel.textContent = `${estimate.runFt.toFixed(0)}ft x ${estimate.laneWidthFt.toFixed(1)}ft`;
  els.stageProgress.textContent = estimate.progressFt === null ? "--" : `${estimate.progressFt.toFixed(1)}ft`;
  els.stageLane.textContent = `${lane ?? "lane"} ${estimate.headingDeg === null ? "no yaw" : `${estimate.headingDeg.toFixed(0)}deg`}`;
  els.stageConfidence.textContent = estimate.state === "missing"
    ? "missing"
    : `${Math.round(estimate.confidence * 100)}%`;
  setStageMarker(x, y, heading);
}

function setStageMarker(xPercent: number, yPercent: number, headingDeg: number) {
  const marker = els.stageMarker as HTMLElement;
  marker.style.left = `${xPercent.toFixed(1)}%`;
  marker.style.top = `${yPercent.toFixed(1)}%`;
  marker.style.transform = `translate(-50%, -50%) rotate(${headingDeg.toFixed(1)}deg)`;
}

function setupJoystick() {
  setupPointerStick(els.driveZone, {
    onMove: ({ fwd, turn, x, y }) => {
      setStickKnob(els.driveZone, x, y);
      lastDrive = {
        left: Math.max(-1, Math.min(1, fwd + turn * 0.6)),
        right: Math.max(-1, Math.min(1, fwd - turn * 0.6)),
      };
      if (manualMode && sendInterval) send(lastDrive.left, lastDrive.right);
    },
    onStart: startSending,
    onEnd: () => {
      if (!sendInterval) startSending();
    },
  });

  if (manualMode) return;

  setupPointerStick(els.cameraZone, {
    onMove: ({ fwd, turn, x, y }) => {
      setStickKnob(els.cameraZone, x, y);
      lastCamera = {
        pan: Math.max(-1, Math.min(1, turn)),
        tilt: Math.max(-1, Math.min(1, fwd)),
      };
    },
    onStart: startCameraSending,
    onEnd: () => {
      lastCamera = { pan: 0, tilt: 0 };
      setStickKnob(els.cameraZone, 0, 0);
      sendCamera(0, 0);
    },
  });
}

function setupPointerStick(
  zone: HTMLElement,
  opts: {
    onStart: () => void;
    onMove: (value: { fwd: number; turn: number; x: number; y: number }) => void;
    onEnd: () => void;
  },
) {
  let activeInput: string | null = null;
  let lastTouchAt = 0;

  const begin = (id: string, clientX: number, clientY: number) => {
    if (!started) return;
    activeInput = id;
    opts.onStart();
    opts.onMove(pointAxes(zone, clientX, clientY));
  };

  const move = (id: string, clientX: number, clientY: number) => {
    if (activeInput !== id) return;
    opts.onMove(pointAxes(zone, clientX, clientY));
  };

  const end = (id: string) => {
    if (activeInput !== id) return;
    activeInput = null;
    opts.onEnd();
  };

  zone.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    zone.setPointerCapture?.(event.pointerId);
    begin(`p${event.pointerId}`, event.clientX, event.clientY);
  });
  zone.addEventListener("pointermove", (event) => {
    event.preventDefault();
    move(`p${event.pointerId}`, event.clientX, event.clientY);
  });
  zone.addEventListener("pointerup", (event) => {
    event.preventDefault();
    zone.releasePointerCapture?.(event.pointerId);
    end(`p${event.pointerId}`);
  });
  zone.addEventListener("pointercancel", (event) => {
    event.preventDefault();
    zone.releasePointerCapture?.(event.pointerId);
    end(`p${event.pointerId}`);
  });

  zone.addEventListener("touchstart", (event) => {
    event.preventDefault();
    lastTouchAt = Date.now();
    const touch = event.changedTouches[0];
    if (!touch) return;
    begin(`t${touch.identifier}`, touch.clientX, touch.clientY);
  }, { passive: false });
  zone.addEventListener("touchmove", (event) => {
    event.preventDefault();
    for (const touch of Array.from(event.changedTouches)) {
      move(`t${touch.identifier}`, touch.clientX, touch.clientY);
    }
  }, { passive: false });
  const touchEnd = (event: TouchEvent) => {
    event.preventDefault();
    lastTouchAt = Date.now();
    for (const touch of Array.from(event.changedTouches)) {
      end(`t${touch.identifier}`);
    }
  };
  zone.addEventListener("touchend", touchEnd, { passive: false });
  zone.addEventListener("touchcancel", touchEnd, { passive: false });

  zone.addEventListener("mousedown", (event) => {
    if (Date.now() - lastTouchAt < 700) return;
    event.preventDefault();
    begin("m0", event.clientX, event.clientY);
  });
  window.addEventListener("mousemove", (event) => {
    if (activeInput !== "m0") return;
    event.preventDefault();
    move("m0", event.clientX, event.clientY);
  });
  window.addEventListener("mouseup", (event) => {
    if (activeInput !== "m0") return;
    event.preventDefault();
    end("m0");
  });
}

function pointAxes(zone: HTMLElement, clientX: number, clientY: number): { fwd: number; turn: number; x: number; y: number } {
  const rect = zone.getBoundingClientRect();
  const radius = Math.max(1, Math.min(rect.width, rect.height) * 0.42);
  const rawX = clientX - (rect.left + rect.width / 2);
  const rawY = clientY - (rect.top + rect.height / 2);
  const distance = Math.hypot(rawX, rawY);
  const scale = distance > radius ? radius / distance : 1;
  const x = rawX * scale;
  const y = rawY * scale;
  return {
    fwd: Math.max(-1, Math.min(1, -y / radius)),
    turn: Math.max(-1, Math.min(1, x / radius)),
    x,
    y,
  };
}

function setStickKnob(zone: HTMLElement, x: number, y: number) {
  const knob = zone.querySelector(".stick-knob") as HTMLElement | null;
  if (!knob) return;
  knob.style.setProperty("--x", `${x.toFixed(1)}px`);
  knob.style.setProperty("--y", `${y.toFixed(1)}px`);
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

  const startFromEvent = (event: Event) => {
    event.preventDefault();
    void beginPilot();
  };
  els.startButton.addEventListener("click", startFromEvent);
  els.startButton.addEventListener("pointerup", startFromEvent);
  els.startButton.addEventListener("touchend", startFromEvent, { passive: false });

  els.throttle.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const next = parseSpeedMode((button as HTMLButtonElement).dataset.speed || "");
      if (next) setSpeedMode(next);
    });
  });
  renderSpeedMode(speedMode);

  window.addEventListener("pagehide", stopSending);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopSending();
  });
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
if (manualMode) {
  els.modalTitle.textContent = "Start Manual Drive";
  els.modalCopy.textContent = "Connect to the Clanker500 camera and unlock direct low-speed control.";
  setModalStatus("Manual mode bypasses race timing");
  els.direction.textContent = "Tap start";
  els.raceTimer.textContent = "manual";
} else if (roundId) {
  els.modalTitle.textContent = "Enter Race";
  els.modalCopy.textContent = `Sign entry for ${driverSlot}. Camera stays live once your entry is confirmed.`;
  setModalStatus("Wallet signature required");
  void loadStageCalibration();
}
if (robotUrl) {
  configureVideo(`${wsFromHttp(robotUrl)}/ws/drive`, `${robotUrl}/stream`);
} else {
  configureVideo(
    `${wsFromHttp(location.origin)}/ws/drive?robot=${encodeURIComponent(robotName)}`,
    `/robot/${encodeURIComponent(robotName)}/stream`,
  );
}
setupControls();
setupJoystick();
window.__pilotReady = true;

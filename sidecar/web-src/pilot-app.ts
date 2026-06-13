type SpeedMode = "low" | "medium" | "high";

type AuthResponse = {
  token?: string;
  robot?: string;
  driveWs?: string;
  telemetryWs?: string;
  streamUrl?: string;
  speedModeUrl?: string;
  stopUrl?: string;
  error?: string;
};

type DriverSlot = "challenger" | "opponent";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
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
  source?: string;
  camera?: { status?: string };
  lidar?: { front_m?: number; min_m?: number; blocked?: boolean };
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
    ethereum?: EthereumProvider;
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
  source: byId("source"),
  cameraState: byId("cameraState"),
  lidar: byId("lidar"),
  yaw: byId("yaw"),
  odo: byId("odo"),
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

async function connect() {
  clearTimeout(reconnectTimer);
  setConn("connecting", "connecting");
  try {
    const auth = await authorize();
    if (!auth.token || !auth.driveWs) throw new Error("authorization missing drive endpoint");
    token = auth.token;
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
  const provider = window.ethereum;
  if (!provider) throw new Error("wallet required for race entry");

  setModalStatus("Connecting wallet...");
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
  const wallet = accounts[0];
  if (!wallet) throw new Error("wallet account unavailable");

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
    chain: {
      chainIdHex: string;
      rpcUrl: string;
      name: string;
      nativeCurrency: { name: string; symbol: string; decimals: number };
    };
    entry: { message: { deadline: string } };
    permit: { message: { deadline: string } };
  };

  await ensureWalletChain(provider, request.chain);

  setModalStatus("Sign race entry...");
  const entrySignature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [wallet, JSON.stringify(request.entry)],
  }) as string;

  setModalStatus("Sign token permit...");
  const permitSignature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [wallet, JSON.stringify(request.permit)],
  }) as string;

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

async function ensureWalletChain(provider: EthereumProvider, chain: {
  chainIdHex: string;
  rpcUrl: string;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chain.chainIdHex }],
    });
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? Number((err as { code: unknown }).code) : 0;
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: chain.chainIdHex,
        chainName: chain.name,
        rpcUrls: [chain.rpcUrl],
        nativeCurrency: chain.nativeCurrency,
      }],
    });
  }
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

function openDriveSocket(url: string) {
  driveWs?.close();
  driveWs = new WebSocket(url);
  driveWs.onopen = () => {
    connected = true;
    hasConnected = true;
    setConn("up", telemetryConnected ? "drive + telemetry" : "drive connected");
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
  const base = httpBaseFromDriveUrl(driveUrl);
  if (forceLocalCamera) {
    startLocalCamera();
    return;
  }
  els.videoFallback.textContent = "camera feed unavailable";
  els.video.src = streamUrl || `${base}/stream`;
  els.video.onload = () => {
    els.video.classList.remove("off");
    els.video.style.display = "block";
    els.localVideo.classList.add("off");
    els.localVideo.style.display = "none";
    els.videoFallback.style.display = "none";
  };
  els.video.onerror = () => {
    els.video.classList.add("off");
    if (started) {
      startLocalCamera();
    } else {
      els.videoFallback.style.display = "grid";
    }
  };
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
    els.localVideo.srcObject = localStream;
    els.localVideo.style.display = "block";
    els.localVideo.classList.remove("off");
    els.video.style.display = "none";
    els.videoFallback.style.display = "none";
  } catch {
    els.videoFallback.textContent = "camera permission needed";
    els.videoFallback.style.display = "grid";
  }
}

function send(left: number, right: number) {
  if (!started) return;
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
  els.cameraState.textContent = cameraLabel(frame);
  els.lidar.textContent = lidarLabel(frame);
  els.yaw.textContent = frame.yaw !== undefined ? `${frame.yaw.toFixed(0)}deg` : "--";
  els.odo.textContent = odometryLabel(frame);
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
  }
}

function cameraLabel(frame: TelemetryFrame): string {
  if (forceLocalCamera) return frame.camera?.status ? `local/${frame.camera.status}` : "local";
  return frame.camera?.status || "--";
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
  if (lastTelemetryAt && Date.now() - lastTelemetryAt > 1200) {
    els.latency.textContent = "stale";
    els.latency.className = "warn";
    els.source.textContent = "stale";
  }
}, 500);

els.robotName.textContent = `/ ${robotName}`;
if (roundId) {
  els.modalTitle.textContent = "Enter Race";
  els.modalCopy.textContent = `Sign entry for ${driverSlot}. Camera stays live once your entry is confirmed.`;
  setModalStatus("Wallet signature required");
}
if (robotUrl) {
  configureVideo(`${wsFromHttp(robotUrl)}/ws/drive`, `${robotUrl}/stream`);
}
setupControls();
setupJoystick();

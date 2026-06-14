import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type DriverSlot = "challenger" | "opponent";

export type AprilTagDetection = {
  id?: number;
  tagId?: number;
  confidence?: number;
  decisionMargin?: number;
  hamming?: number;
  center?: { x?: number; y?: number };
  x?: number;
  y?: number;
};

export type AprilTagFrame = {
  frameId?: string;
  ts_ms?: number;
  timestampMs?: number;
  brightness?: number;
  lighting?: string;
  tags?: AprilTagDetection[];
  detections?: AprilTagDetection[];
  operatorWinner?: DriverSlot;
  operatorFinishedAtMs?: number;
};

export type AprilTagSpikeInput = {
  frames: AprilTagFrame[];
  operator?: {
    winner?: DriverSlot;
    finishedAtMs?: number;
  };
};

export type AprilTagSpikeConfig = {
  challengerTagIds: number[];
  opponentTagIds: number[];
  finishBand: { minX: number; maxX: number };
  minConfidence: number;
  lowBrightnessThreshold: number;
};

export type AprilTagSpikeReport = {
  schema: "onchain-rover.apriltag-finish-spike.v1";
  generatedAtMs: number;
  frameCount: number;
  config: AprilTagSpikeConfig;
  inferredWinner: DriverSlot | null;
  detected: boolean;
  bestDetection: SpikeDetection | null;
  detections: SpikeDetection[];
  falsePositives: SpikeFalsePositive[];
  comparison: {
    operatorWinner: DriverSlot | null;
    operatorFinishedAtMs: number | null;
    matchesOperator: boolean | null;
    latencyMs: number | null;
  };
  lighting: {
    lowBrightnessFrames: number;
    lowBrightnessRatio: number;
    minBrightness: number | null;
    maxBrightness: number | null;
    constraints: string[];
  };
  reliability: {
    promoteToMainFlow: boolean;
    confidence: number;
    falsePositiveCount: number;
    notes: string[];
  };
};

type SpikeDetection = {
  slot: DriverSlot;
  tagId: number;
  frameId: string;
  detectedAtMs: number;
  confidence: number;
  x: number;
  y: number | null;
  method: "apriltag-finish-band";
};

type SpikeFalsePositive = {
  tagId: number;
  frameId: string;
  detectedAtMs: number;
  confidence: number;
  x: number;
  reason: string;
};

export function evaluateAprilTagFinishSpike(
  input: AprilTagSpikeInput,
  config: Partial<AprilTagSpikeConfig> = {},
): AprilTagSpikeReport {
  const cfg = normalizeConfig(config);
  const detections: SpikeDetection[] = [];
  const falsePositives: SpikeFalsePositive[] = [];
  const brightness: number[] = [];
  let operatorWinner = input.operator?.winner ?? null;
  let operatorFinishedAtMs = input.operator?.finishedAtMs ?? null;

  input.frames.forEach((frame, index) => {
    const frameId = frame.frameId ?? `frame-${index}`;
    const detectedAtMs = timestamp(frame.ts_ms ?? frame.timestampMs, index);
    if (frame.operatorWinner) operatorWinner = frame.operatorWinner;
    const frameOperatorFinishedAtMs = numberField(frame.operatorFinishedAtMs);
    if (frameOperatorFinishedAtMs !== null) operatorFinishedAtMs = frameOperatorFinishedAtMs;
    if (Number.isFinite(Number(frame.brightness))) brightness.push(Number(frame.brightness));

    for (const tag of frame.tags ?? frame.detections ?? []) {
      const tagId = numberField(tag.id ?? tag.tagId);
      const x = numberField(tag.center?.x ?? tag.x);
      if (tagId === null || x === null) continue;
      const confidence = confidenceFor(tag);
      if (x < cfg.finishBand.minX || x > cfg.finishBand.maxX) continue;
      const slot = slotForTag(tagId, cfg);
      if (!slot) {
        falsePositives.push({ tagId, frameId, detectedAtMs, confidence, x, reason: "unknown tag in finish band" });
        continue;
      }
      if (confidence < cfg.minConfidence) {
        falsePositives.push({ tagId, frameId, detectedAtMs, confidence, x, reason: "low confidence in finish band" });
        continue;
      }
      detections.push({
        slot,
        tagId,
        frameId,
        detectedAtMs,
        confidence,
        x,
        y: numberField(tag.center?.y ?? tag.y),
        method: "apriltag-finish-band",
      });
    }
  });

  detections.sort((a, b) => a.detectedAtMs - b.detectedAtMs || b.confidence - a.confidence);
  const bestDetection = detections[0] ?? null;
  const lowBrightnessFrames = brightness.filter((value) => value <= cfg.lowBrightnessThreshold).length;
  const lowBrightnessRatio = brightness.length ? lowBrightnessFrames / brightness.length : 0;
  const matchesOperator = operatorWinner && bestDetection ? operatorWinner === bestDetection.slot : null;
  const latencyMs = bestDetection && operatorFinishedAtMs !== null
    ? bestDetection.detectedAtMs - operatorFinishedAtMs
    : null;
  const reliabilityNotes = reliabilityNotesFor({
    bestDetection,
    matchesOperator,
    falsePositiveCount: falsePositives.length,
    lowBrightnessRatio,
    hasOperator: Boolean(operatorWinner),
  });
  const confidence = Number((bestDetection?.confidence ?? 0).toFixed(3));
  const promoteToMainFlow =
    Boolean(bestDetection) &&
    matchesOperator === true &&
    falsePositives.length === 0 &&
    confidence >= 0.75 &&
    lowBrightnessRatio <= 0.25;

  return {
    schema: "onchain-rover.apriltag-finish-spike.v1",
    generatedAtMs: Date.now(),
    frameCount: input.frames.length,
    config: cfg,
    inferredWinner: bestDetection?.slot ?? null,
    detected: Boolean(bestDetection),
    bestDetection,
    detections,
    falsePositives,
    comparison: {
      operatorWinner,
      operatorFinishedAtMs,
      matchesOperator,
      latencyMs,
    },
    lighting: {
      lowBrightnessFrames,
      lowBrightnessRatio: Number(lowBrightnessRatio.toFixed(3)),
      minBrightness: brightness.length ? Math.min(...brightness) : null,
      maxBrightness: brightness.length ? Math.max(...brightness) : null,
      constraints: lightingConstraints(lowBrightnessRatio, brightness.length),
    },
    reliability: {
      promoteToMainFlow,
      confidence,
      falsePositiveCount: falsePositives.length,
      notes: reliabilityNotes,
    },
  };
}

function normalizeConfig(input: Partial<AprilTagSpikeConfig>): AprilTagSpikeConfig {
  return {
    challengerTagIds: input.challengerTagIds?.length ? input.challengerTagIds : numberList(process.env.APRILTAG_CHALLENGER_IDS, [1]),
    opponentTagIds: input.opponentTagIds?.length ? input.opponentTagIds : numberList(process.env.APRILTAG_OPPONENT_IDS, [2]),
    finishBand: input.finishBand ?? finishBandFromEnv(),
    minConfidence: finite(input.minConfidence, numberEnv("APRILTAG_MIN_CONFIDENCE", 0.6), 0, 1),
    lowBrightnessThreshold: finite(input.lowBrightnessThreshold, numberEnv("APRILTAG_LOW_BRIGHTNESS", 0.28), 0, 1),
  };
}

function slotForTag(tagId: number, cfg: AprilTagSpikeConfig): DriverSlot | null {
  if (cfg.challengerTagIds.includes(tagId)) return "challenger";
  if (cfg.opponentTagIds.includes(tagId)) return "opponent";
  return null;
}

function confidenceFor(tag: AprilTagDetection): number {
  const explicit = numberField(tag.confidence);
  if (explicit !== null) return finite(explicit, explicit, 0, 1);
  const margin = numberField(tag.decisionMargin);
  const hamming = numberField(tag.hamming);
  const marginScore = margin === null ? 0.65 : finite(margin / 80, 0.65, 0.2, 0.98);
  const hammingPenalty = hamming === null ? 0 : Math.min(0.35, hamming * 0.12);
  return Number(finite(marginScore - hammingPenalty, 0.5, 0, 1).toFixed(3));
}

function reliabilityNotesFor(opts: {
  bestDetection: SpikeDetection | null;
  matchesOperator: boolean | null;
  falsePositiveCount: number;
  lowBrightnessRatio: number;
  hasOperator: boolean;
}): string[] {
  const notes: string[] = [];
  if (!opts.bestDetection) notes.push("no mapped tag crossed the finish band");
  if (!opts.hasOperator) notes.push("no operator result supplied for comparison");
  if (opts.matchesOperator === false) notes.push("automated winner disagreed with operator result");
  if (opts.falsePositiveCount > 0) notes.push(`${opts.falsePositiveCount} possible false positive tag events`);
  if (opts.lowBrightnessRatio > 0.25) notes.push("lighting was below threshold for more than 25% of frames");
  if (!notes.length) notes.push("spike result is consistent with operator result under this fixture");
  return notes;
}

function lightingConstraints(lowBrightnessRatio: number, sampleCount: number): string[] {
  if (!sampleCount) return ["no brightness samples supplied"];
  if (lowBrightnessRatio > 0.5) return ["low-light run; add task lighting before promoting"];
  if (lowBrightnessRatio > 0.25) return ["mixed lighting; rerun with fixed exposure and more samples"];
  return ["lighting acceptable for this sample"];
}

function finishBandFromEnv() {
  const raw = process.env.APRILTAG_FINISH_BAND ?? "0.46,0.54";
  const [min, max] = raw.split(",").map((value) => Number(value.trim()));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 1 || min >= max) {
    throw new Error("APRILTAG_FINISH_BAND must be min,max normalized x coordinates");
  }
  return { minX: min, maxX: max };
}

function numberList(raw: string | undefined, fallback: number[]) {
  if (!raw) return fallback;
  const values = raw.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value));
  return values.length ? values : fallback;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function numberField(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finite(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function timestamp(value: unknown, index: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : index;
}

function parseInput(text: string): AprilTagSpikeInput {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty AprilTag spike input");
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    if (Array.isArray(json.frames)) return json;
    throw new Error("JSON input must include frames[]");
  }
  if (trimmed.startsWith("[")) return { frames: JSON.parse(trimmed) };
  return {
    frames: trimmed.split(/\n+/).map((line) => JSON.parse(line)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: npm run spike:apriltag-finish -- detections.jsonl");
    process.exit(2);
  }
  const report = evaluateAprilTagFinishSpike(parseInput(readFileSync(file, "utf8")));
  console.log(JSON.stringify(report, null, 2));
}

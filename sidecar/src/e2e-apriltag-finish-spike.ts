import { evaluateAprilTagFinishSpike } from "./apriltag-finish-spike.js";

const report = evaluateAprilTagFinishSpike({
  operator: { winner: "opponent", finishedAtMs: 1_320 },
  frames: [
    {
      frameId: "f-001",
      ts_ms: 1_000,
      brightness: 0.21,
      tags: [{ id: 1, center: { x: 0.28, y: 0.52 }, confidence: 0.86 }],
    },
    {
      frameId: "f-002",
      ts_ms: 1_120,
      brightness: 0.42,
      tags: [{ id: 99, center: { x: 0.5, y: 0.48 }, confidence: 0.9 }],
    },
    {
      frameId: "f-003",
      ts_ms: 1_260,
      brightness: 0.58,
      tags: [{ id: 2, center: { x: 0.51, y: 0.45 }, confidence: 0.82 }],
    },
  ],
}, {
  challengerTagIds: [1],
  opponentTagIds: [2],
  finishBand: { minX: 0.46, maxX: 0.54 },
  minConfidence: 0.6,
  lowBrightnessThreshold: 0.28,
});

assert(report.detected, "expected detection");
assert(report.inferredWinner === "opponent", `expected opponent winner, got ${report.inferredWinner}`);
assert(report.bestDetection?.tagId === 2, "expected tag 2 as best detection");
assert(report.comparison.matchesOperator === true, "expected operator match");
assert(report.comparison.latencyMs === -60, `expected -60ms latency, got ${report.comparison.latencyMs}`);
assert(report.falsePositives.length === 1, "expected one false positive");
assert(report.falsePositives[0].tagId === 99, "expected unknown tag false positive");
assert(report.lighting.lowBrightnessFrames === 1, "expected one low-brightness frame");
assert(report.reliability.promoteToMainFlow === false, "false positive should block promotion");

console.log("AprilTag finish spike e2e passed");
console.log(JSON.stringify({
  inferredWinner: report.inferredWinner,
  confidence: report.reliability.confidence,
  falsePositiveCount: report.reliability.falsePositiveCount,
  latencyMs: report.comparison.latencyMs,
}, null, 2));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

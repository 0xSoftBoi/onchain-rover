import { replaySensorFixture, type SensorReplayFixture } from "./sensor-replay.js";

async function main() {
  const { fixture, round, trace } = await replaySensorFixture({
    realtime: false,
    minFrameDelayMs: 12,
  });

  assert(round.status === "racing", `expected replay round to be racing, got ${round.status}`);
  assert(trace.traceId, "trace id missing");
  assert(
    Number(trace.frameCount ?? 0) >= fixture.frames.length,
    `expected at least ${fixture.frames.length} replay frames, got ${trace.frameCount}`,
  );

  assertExpectedEvents(fixture, trace);
  assertExpectedDrivers(fixture, trace);

  console.log("Sensor replay e2e passed");
  console.log(`  fixture: ${fixture.name}`);
  console.log(`  roundId: ${round.id}`);
  console.log(`  frames:  ${trace.frameCount}`);
  console.log(`  events:  ${eventTypes(trace).join(", ")}`);
}

function assertExpectedEvents(fixture: SensorReplayFixture, trace: any) {
  for (const type of fixture.expected?.events ?? []) {
    assert(hasEvent(trace, type), `trace missing expected event: ${type}`);
  }
}

function assertExpectedDrivers(fixture: SensorReplayFixture, trace: any) {
  for (const [slot, expected] of Object.entries(fixture.expected?.drivers ?? {})) {
    const driver = trace.drivers?.[slot];
    assert(driver, `trace missing ${slot} driver summary`);

    if (expected.robot) {
      assert(driver.robot === expected.robot, `${slot} robot mismatch: ${driver.robot}`);
    }
    if (expected.lane) {
      assert(driver.stage?.lane === expected.lane, `${slot} lane mismatch: ${driver.stage?.lane}`);
    }
    if (expected.minProgressFt !== undefined) {
      const progressFt = Number(driver.stage?.progressFt ?? 0);
      assert(
        progressFt >= expected.minProgressFt,
        `${slot} progress ${progressFt}ft below expected ${expected.minProgressFt}ft`,
      );
    }
    if (expected.cameraStaleCountAtLeast !== undefined) {
      const staleCount = Number(driver.camera?.staleCount ?? 0);
      assert(
        staleCount >= expected.cameraStaleCountAtLeast,
        `${slot} camera stale count ${staleCount} below expected ${expected.cameraStaleCountAtLeast}`,
      );
    }
    if (expected.lidarStaleEvent) {
      assert(hasEvent(trace, "lidar-stale", slot), `${slot} lidar-stale event missing`);
    }
  }
}

function hasEvent(trace: any, type: string, slot?: string) {
  return (trace.eventSequence ?? []).some((event: { type?: string; slot?: string }) => {
    if (event.type !== type) return false;
    return slot ? event.slot === slot : true;
  });
}

function eventTypes(trace: any): string[] {
  return [...new Set((trace.eventSequence ?? [])
    .map((event: { type?: string }) => event.type)
    .filter(Boolean))] as string[];
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

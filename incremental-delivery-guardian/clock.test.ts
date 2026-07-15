import assert from "node:assert/strict";
import test from "node:test";

import {
  ClockFoldError,
  foldClockEvents,
  measureCadence,
  type ClockEvent,
} from "./clock.ts";
import { DEFAULT_GUARDIAN_POLICY } from "./config.ts";

const minute = (value: number) => value * 60_000;

const base = {
  ownerSessionId: "owner-1",
  timelineId: "timeline-1",
  wallStartedAtMs: 1_000_000,
  heartbeatGraceMs: minute(1),
  maxWallSkewMs: 0,
} as const;

const at = (kind: "started" | "heartbeat" | "settled" | "observed" | "recovered", monotonicMs: number, extra: Record<string, unknown> = {}): ClockEvent => ({
  kind,
  ownerSessionId: "owner-1",
  timelineId: "timeline-1",
  monotonicMs,
  wallMs: base.wallStartedAtMs + monotonicMs,
  ...extra,
} as ClockEvent);

function expectClockError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ClockFoldError);
    assert.equal(error.code, code);
    return true;
  });
}

test("unions overlapping parent and owned-child activity", () => {
  const snapshot = foldClockEvents({
    ...base,
    events: [
      at("started", minute(0), { activityId: "parent" }),
      at("started", minute(5), { activityId: "child" }),
      at("settled", minute(10), { activityId: "parent" }),
      at("settled", minute(15), { activityId: "child" }),
    ],
  });

  assert.equal(snapshot.activeMs, minute(15));
  assert.equal(snapshot.wallMs, minute(15));
  assert.equal(snapshot.cadenceValid, true);
  assert.deepEqual(snapshot.recoveries, []);
  assert.deepEqual(snapshot.checkpoint.closedActivityIds, ["parent", "child"]);
});

test("unions nested completions, disjoint intervals, and touching boundaries", () => {
  const nested = foldClockEvents({
    ...base,
    events: [
      at("started", minute(0), { activityId: "parent" }),
      at("started", minute(5), { activityId: "child" }),
      at("settled", minute(10), { activityId: "child" }),
      at("settled", minute(15), { activityId: "parent" }),
    ],
  });
  const disjoint = foldClockEvents({
    ...base,
    events: [
      at("started", minute(0), { activityId: "first" }),
      at("settled", minute(5), { activityId: "first" }),
      at("started", minute(10), { activityId: "second" }),
      at("settled", minute(15), { activityId: "second" }),
    ],
  });
  const touching = foldClockEvents({
    ...base,
    events: [
      at("started", minute(0), { activityId: "first" }),
      at("settled", minute(5), { activityId: "first" }),
      at("started", minute(5), { activityId: "second" }),
      at("settled", minute(10), { activityId: "second" }),
    ],
  });

  assert.equal(nested.activeMs, minute(15));
  assert.equal(disjoint.activeMs, minute(10));
  assert.equal(touching.activeMs, minute(10));
});

test("unions parallel children and excludes settled user-wait time", () => {
  const snapshot = foldClockEvents({
    ...base,
    events: [
      at("started", minute(0), { activityId: "child-a" }),
      at("started", minute(0), { activityId: "child-b" }),
      at("settled", minute(10), { activityId: "child-a" }),
      at("settled", minute(10), { activityId: "child-b" }),
      at("observed", minute(30)),
    ],
  });

  assert.equal(snapshot.activeMs, minute(10));
  assert.equal(snapshot.wallMs, minute(30));
});

test("counts a still-open activity through the last observation", () => {
  const snapshot = foldClockEvents({
    ...base,
    events: [
      at("started", minute(0), { activityId: "parent" }),
      at("observed", minute(10)),
    ],
  });

  assert.equal(snapshot.activeMs, minute(10));
  assert.deepEqual(snapshot.openActivityIds, ["parent"]);
});

test("round-trips an open checkpoint without double-counting", () => {
  const snapshot = foldClockEvents({
    ...base,
    checkpoint: {
      activeMs: minute(10),
      lastWallMs: base.wallStartedAtMs + minute(10),
      lastMonotonicMs: minute(10),
      timelineId: "timeline-1",
      openActivities: [{
        activityId: "parent",
        startedMs: minute(0),
        lastHeartbeatMs: minute(10),
      }],
    },
    events: [],
  });

  assert.equal(snapshot.activeMs, minute(10));
  assert.equal(snapshot.checkpoint.activeMs, minute(10));
  assert.deepEqual(snapshot.checkpoint.openActivities, [{
    activityId: "parent",
    startedMs: minute(0),
    lastHeartbeatMs: minute(10),
  }]);
});

test("replays an emitted open checkpoint after a later observation", () => {
  const first = foldClockEvents({
    ...base,
    heartbeatGraceMs: minute(10),
    events: [
      at("started", minute(0), { activityId: "parent" }),
      at("heartbeat", minute(1), { activityId: "parent" }),
      at("observed", minute(10)),
    ],
  });
  const replayed = foldClockEvents({
    ...base,
    heartbeatGraceMs: minute(10),
    checkpoint: first.checkpoint,
    events: [],
  });

  assert.equal(replayed.activeMs, minute(10));
  assert.deepEqual(replayed.checkpoint, first.checkpoint);
});

test("resume with a checkpoint and no events changes neither clock", () => {
  const snapshot = foldClockEvents({
    ...base,
    checkpoint: {
      activeMs: minute(12),
      lastWallMs: base.wallStartedAtMs + minute(20),
      lastMonotonicMs: minute(20),
      timelineId: "prior-timeline",
    },
    events: [],
  });

  assert.equal(snapshot.activeMs, minute(12));
  assert.equal(snapshot.wallMs, minute(20));
  assert.equal(snapshot.lastMonotonicMs, 0);
});

test("settling at the start time is a valid zero-duration interval", () => {
  const snapshot = foldClockEvents({
    ...base,
    events: [
      at("started", minute(2), { activityId: "instant" }),
      at("settled", minute(2), { activityId: "instant" }),
    ],
  });

  assert.equal(snapshot.activeMs, 0);
  assert.deepEqual(snapshot.openActivityIds, []);
});

test("crash recovery caps activity at heartbeat grace and records the recovery", () => {
  const snapshot = foldClockEvents({
    ...base,
    checkpoint: {
      activeMs: minute(15),
      lastWallMs: base.wallStartedAtMs + minute(10),
      lastMonotonicMs: minute(10),
      timelineId: "timeline-1",
      openActivities: [{
        activityId: "parent",
        startedMs: minute(0),
        lastHeartbeatMs: minute(10),
      }],
    },
    events: [at("recovered", minute(20), { activityId: "parent" })],
    heartbeatGraceMs: minute(2),
  });

  assert.equal(snapshot.activeMs, minute(17));
  assert.equal(snapshot.wallMs, minute(20));
  assert.deepEqual(snapshot.openActivityIds, []);
  assert.deepEqual(snapshot.recoveries, [{
    activityId: "parent",
    lastHeartbeatMs: minute(10),
    recoveredThroughMs: minute(12),
  }]);
  assert.equal(snapshot.cadenceValid, true);
});

test("live heartbeat state is required and retained for recovery", () => {
  const snapshot = foldClockEvents({
    ...base,
    heartbeatGraceMs: minute(2),
    events: [
      at("started", minute(0), { activityId: "parent" }),
      at("heartbeat", minute(10), { activityId: "parent" }),
      at("recovered", minute(20), { activityId: "parent" }),
    ],
  });

  assert.equal(snapshot.activeMs, minute(12));
  assert.deepEqual(snapshot.recoveries, [{
    activityId: "parent",
    lastHeartbeatMs: minute(10),
    recoveredThroughMs: minute(12),
  }]);
});

test("persists cadence-measurement anomalies across resume", () => {
  const invalid = foldClockEvents({
    ...base,
    events: [{ ...at("observed", minute(1)), wallMs: base.wallStartedAtMs + minute(5) }],
  });
  const resumed = foldClockEvents({
    ...base,
    timelineId: "timeline-2",
    checkpoint: invalid.checkpoint,
    events: [],
  });

  assert.equal(invalid.cadenceValid, false);
  assert.equal(resumed.cadenceValid, false);
  assert.deepEqual(resumed.anomalies, invalid.anomalies);
});

test("marks process suspension as wall-monotonic skew", () => {
  const snapshot = foldClockEvents({
    ...base,
    maxWallSkewMs: minute(1),
    events: [
      at("started", minute(0), { activityId: "parent" }),
      at("observed", minute(10)),
      { ...at("observed", minute(10)), wallMs: base.wallStartedAtMs + minute(60) },
    ],
  });

  assert.equal(snapshot.wallMs, minute(60));
  assert.equal(snapshot.activeMs, minute(10));
  assert.deepEqual(snapshot.anomalies.map(({ code }) => code), ["wall_monotonic_skew"]);
  assert.equal(measureCadence(snapshot, DEFAULT_GUARDIAN_POLICY).available, false);
});

test("marks a persisted or observed wall time before registration invalid", () => {
  const persisted = foldClockEvents({
    ...base,
    checkpoint: {
      activeMs: 0,
      lastWallMs: base.wallStartedAtMs - 1,
      lastMonotonicMs: 0,
      timelineId: "prior",
    },
    events: [],
  });
  const observed = foldClockEvents({
    ...base,
    events: [{ ...at("observed", 0), wallMs: base.wallStartedAtMs - 1 }],
  });

  assert.deepEqual(persisted.anomalies, [{
    code: "backward_wall",
    eventIndex: -1,
    previousMs: base.wallStartedAtMs,
    observedMs: base.wallStartedAtMs - 1,
  }]);
  assert.equal(persisted.wallMs, -1);
  assert.deepEqual(observed.anomalies.map(({ code }) => code), ["backward_wall", "wall_monotonic_skew"]);
});

test("marks backward and skewed observations invalid without clamping elapsed time", () => {
  const snapshot = foldClockEvents({
    ...base,
    maxWallSkewMs: minute(1),
    events: [
      at("observed", minute(10)),
      { ...at("observed", minute(9)), wallMs: base.wallStartedAtMs + minute(11) },
      { ...at("observed", minute(12)), wallMs: base.wallStartedAtMs + minute(8) },
      { ...at("observed", minute(13)), wallMs: base.wallStartedAtMs + minute(20) },
    ],
  });

  assert.equal(snapshot.cadenceValid, false);
  assert.deepEqual(snapshot.anomalies.map(({ code }) => code), [
    "backward_monotonic",
    "wall_monotonic_skew",
    "backward_wall",
    "wall_monotonic_skew",
    "wall_monotonic_skew",
  ]);
  assert.equal(snapshot.wallMs, minute(20));
  assert.deepEqual(measureCadence(snapshot, DEFAULT_GUARDIAN_POLICY), {
    available: false,
    anomalies: snapshot.anomalies,
  });
});

test("validates the first observation against its monotonic reference", () => {
  const fresh = foldClockEvents({
    ...base,
    events: [{ ...at("observed", minute(10)), wallMs: base.wallStartedAtMs + minute(20) }],
  });
  const resumed = foldClockEvents({
    ...base,
    checkpoint: {
      activeMs: 0,
      lastWallMs: base.wallStartedAtMs + minute(10),
      lastMonotonicMs: minute(10),
      timelineId: "timeline-1",
    },
    events: [{ ...at("observed", minute(9)), wallMs: base.wallStartedAtMs + minute(11) }],
  });

  assert.deepEqual(fresh.anomalies.map(({ code }) => code), ["wall_monotonic_skew"]);
  assert.deepEqual(resumed.anomalies.map(({ code }) => code), ["backward_monotonic", "wall_monotonic_skew"]);
});

test("accepts wall skew exactly at tolerance", () => {
  const snapshot = foldClockEvents({
    ...base,
    maxWallSkewMs: minute(1),
    events: [{ ...at("observed", minute(10)), wallMs: base.wallStartedAtMs + minute(11) }],
  });

  assert.equal(snapshot.cadenceValid, true);
  assert.deepEqual(snapshot.anomalies, []);
});

test("measures every cadence threshold below, at, and above the boundary", () => {
  const cases = [
    ["activeTarget", "activeMs", DEFAULT_GUARDIAN_POLICY.cadence.activeTargetMs],
    ["activeReview", "activeMs", DEFAULT_GUARDIAN_POLICY.cadence.activeReviewMs],
    ["activeEscalation", "activeMs", DEFAULT_GUARDIAN_POLICY.cadence.activeEscalationMs],
    ["wallWarning", "wallMs", DEFAULT_GUARDIAN_POLICY.cadence.wallWarningMs],
    ["wallEscalation", "wallMs", DEFAULT_GUARDIAN_POLICY.cadence.wallEscalationMs],
  ] as const;
  const snapshot = foldClockEvents({ ...base, events: [] });

  for (const [factName, elapsedName, threshold] of cases) {
    for (const [offset, reached] of [[-1, false], [0, true], [1, true]] as const) {
      const measured = measureCadence({ ...snapshot, [elapsedName]: threshold + offset }, DEFAULT_GUARDIAN_POLICY);
      assert.equal(measured.available, true);
      if (measured.available) assert.deepEqual(measured[factName], {
        elapsedMs: threshold + offset,
        thresholdMs: threshold,
        reached,
      });
    }
  }
});

test("rejects malformed and unattributed lifecycle events", () => {
  const fold = (events: ClockEvent[]) => foldClockEvents({ ...base, events });

  expectClockError(() => foldClockEvents({ ...base, ownerSessionId: " ", events: [] }), "invalid_identity");
  expectClockError(() => foldClockEvents({ ...base, timelineId: "", events: [] }), "invalid_identity");
  expectClockError(() => fold([at("started", minute(1), { activityId: "" })]), "invalid_identity");
  expectClockError(() => fold([
    at("started", minute(0), { activityId: "a" }),
    at("heartbeat", minute(1), { activityId: "a" }),
    { ...at("recovered", minute(2), { activityId: "a" }), kind: "bogus" } as unknown as ClockEvent,
  ]), "invalid_event_kind");
  expectClockError(() => fold([
    at("started", minute(1), { activityId: "a" }),
    at("started", minute(2), { activityId: "a" }),
  ]), "duplicate_start");
  expectClockError(() => fold([at("heartbeat", minute(1), { activityId: "missing" })]), "activity_not_started");
  expectClockError(() => fold([at("settled", minute(1), { activityId: "missing" })]), "activity_not_started");
  expectClockError(() => fold([
    at("started", minute(2), { activityId: "a" }),
    at("settled", minute(1), { activityId: "a" }),
  ]), "settle_before_start");
  expectClockError(() => fold([
    at("started", minute(2), { activityId: "a" }),
    at("heartbeat", minute(1), { activityId: "a" }),
  ]), "heartbeat_before_start");
  expectClockError(() => fold([
    at("started", minute(0), { activityId: "a" }),
    at("recovered", minute(1), { activityId: "a" }),
  ]), "recovery_without_heartbeat");
  expectClockError(() => fold([
    at("started", minute(0), { activityId: "a" }),
    at("settled", minute(1), { activityId: "a" }),
    at("heartbeat", minute(2), { activityId: "a" }),
  ]), "activity_already_settled");
  expectClockError(() => fold([{ ...at("observed", minute(1)), ownerSessionId: "foreign" }]), "foreign_owner");
  expectClockError(() => fold([{ ...at("observed", minute(1)), timelineId: "other" }]), "timeline_mismatch");
  expectClockError(() => fold([{ ...at("observed", minute(1)), wallMs: -1 }]), "invalid_time");
  expectClockError(() => foldClockEvents({
    ...base,
    checkpoint: {
      activeMs: -1,
      lastWallMs: base.wallStartedAtMs,
      lastMonotonicMs: 0,
      timelineId: "timeline-1",
    },
    events: [],
  }), "invalid_time");
});

test("rejects malformed checkpoint activity state", () => {
  const checkpoint = {
    activeMs: 0,
    lastWallMs: base.wallStartedAtMs + minute(10),
    lastMonotonicMs: minute(10),
    timelineId: "timeline-1",
  } as const;
  const fold = (overrides: Record<string, unknown>) => foldClockEvents({
    ...base,
    checkpoint: { ...checkpoint, ...overrides },
    events: [],
  });

  expectClockError(() => fold({
    timelineId: "prior",
    openActivities: [{ activityId: "a", startedMs: 0 }],
  }), "checkpoint_timeline_mismatch");
  expectClockError(() => fold({
    openActivities: [{ activityId: "a", startedMs: minute(11) }],
  }), "invalid_checkpoint");
  expectClockError(() => fold({
    openActivities: [{ activityId: "a", startedMs: 0, lastHeartbeatMs: minute(11) }],
  }), "invalid_checkpoint");
  expectClockError(() => foldClockEvents({
    ...base,
    heartbeatGraceMs: minute(20),
    checkpoint: {
      ...checkpoint,
      openActivities: [{ activityId: "a", startedMs: minute(5), lastHeartbeatMs: minute(4) }],
    },
    events: [],
  }), "invalid_checkpoint");
  expectClockError(() => foldClockEvents({
    ...base,
    heartbeatGraceMs: minute(4),
    checkpoint: {
      ...checkpoint,
      openActivities: [{ activityId: "a", startedMs: 0, lastHeartbeatMs: minute(5) }],
    },
    events: [],
  }), "invalid_checkpoint");
  assert.doesNotThrow(() => foldClockEvents({
    ...base,
    heartbeatGraceMs: minute(5),
    checkpoint: {
      ...checkpoint,
      openActivities: [{ activityId: "a", startedMs: 0, lastHeartbeatMs: minute(5) }],
    },
    events: [],
  }));
  expectClockError(() => fold({
    openActivities: [{ activityId: "a", startedMs: 0 }, { activityId: "a", startedMs: 0 }],
  }), "invalid_checkpoint");
  expectClockError(() => fold({ closedActivityIds: ["a", "a"] }), "invalid_checkpoint");
  expectClockError(() => fold({ closedActivityIds: [" "] }), "invalid_identity");
  expectClockError(() => fold({
    closedActivityIds: ["a"],
    openActivities: [{ activityId: "a", startedMs: 0 }],
  }), "invalid_checkpoint");
  expectClockError(() => fold({
    openActivities: [{ activityId: " ", startedMs: 0 }],
  }), "invalid_identity");
  expectClockError(() => fold({
    openActivities: [{ activityId: "a", startedMs: 0, lastHeartbeatMs: -1 }],
  }), "invalid_time");
});

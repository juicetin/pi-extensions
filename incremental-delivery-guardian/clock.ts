import type { GuardianPolicyConfig } from "./schemas.ts";

export type ClockEventKind = "started" | "heartbeat" | "settled" | "observed" | "recovered";

interface ClockEventBase {
  kind: ClockEventKind;
  ownerSessionId: string;
  timelineId: string;
  monotonicMs: number;
  wallMs: number;
}

export interface ActivityClockEvent extends ClockEventBase {
  kind: "started" | "heartbeat" | "settled" | "recovered";
  activityId: string;
}

export interface ObservedClockEvent extends ClockEventBase {
  kind: "observed";
}

export type ClockEvent = ActivityClockEvent | ObservedClockEvent;

export interface CheckpointActivity {
  activityId: string;
  startedMs: number;
  lastHeartbeatMs?: number;
}

export interface ClockCheckpoint {
  activeMs: number;
  lastWallMs: number;
  lastMonotonicMs: number;
  timelineId: string;
  openActivities?: readonly CheckpointActivity[];
  closedActivityIds?: readonly string[];
  anomalies?: readonly ClockAnomaly[];
}

export interface ClockFoldInput {
  ownerSessionId: string;
  timelineId: string;
  wallStartedAtMs: number;
  checkpoint?: ClockCheckpoint;
  events: readonly ClockEvent[];
  heartbeatGraceMs: number;
  maxWallSkewMs: number;
}

export type ClockAnomalyCode = "backward_monotonic" | "backward_wall" | "wall_monotonic_skew";

export interface ClockAnomaly {
  code: ClockAnomalyCode;
  eventIndex: number;
  previousMs: number;
  observedMs: number;
}

export interface ClockRecoveryFact {
  activityId: string;
  lastHeartbeatMs: number;
  recoveredThroughMs: number;
}

export interface ClockSnapshot {
  activeMs: number;
  wallMs: number;
  lastWallMs: number;
  lastMonotonicMs: number;
  timelineId: string;
  cadenceValid: boolean;
  anomalies: readonly ClockAnomaly[];
  recoveries: readonly ClockRecoveryFact[];
  openActivityIds: readonly string[];
  checkpoint: ClockCheckpoint;
}

export type ClockFoldErrorCode =
  | "activity_already_settled"
  | "activity_not_started"
  | "checkpoint_timeline_mismatch"
  | "duplicate_start"
  | "foreign_owner"
  | "heartbeat_before_start"
  | "invalid_checkpoint"
  | "invalid_event_kind"
  | "invalid_identity"
  | "invalid_interval"
  | "invalid_time"
  | "recovery_without_heartbeat"
  | "settle_before_start"
  | "timeline_mismatch";

export class ClockFoldError extends Error {
  readonly code: ClockFoldErrorCode;

  constructor(code: ClockFoldErrorCode, message: string) {
    super(message);
    this.name = "ClockFoldError";
    this.code = code;
  }
}

interface ActivityState {
  startedMs: number;
  checkpointStartedMs: number;
  lastHeartbeatMs?: number;
}

interface Interval {
  startMs: number;
  endMs: number;
}

function unionDuration(intervals: readonly Interval[]): number {
  if (intervals.some(({ startMs, endMs }) => endMs < startMs)) {
    throw new ClockFoldError("invalid_interval", "Clock interval ends before it starts.");
  }
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs);
  let total = 0;
  let current: Interval | undefined;
  for (const interval of sorted) {
    if (current === undefined) current = { ...interval };
    else if (interval.startMs <= current.endMs) current.endMs = Math.max(current.endMs, interval.endMs);
    else {
      total += current.endMs - current.startMs;
      current = { ...interval };
    }
  }
  return current === undefined ? total : total + current.endMs - current.startMs;
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ClockFoldError("invalid_time", `${field} must be a non-negative integer.`);
  }
}

function assertIdentity(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ClockFoldError("invalid_identity", `${field} must be non-empty.`);
  }
}

const EVENT_KINDS = new Set<ClockEventKind>(["started", "heartbeat", "settled", "observed", "recovered"]);

function validateEvent(event: ClockEvent, input: ClockFoldInput): void {
  if (!EVENT_KINDS.has(event.kind)) {
    throw new ClockFoldError("invalid_event_kind", `Unknown clock event kind: ${String(event.kind)}.`);
  }
  if (event.ownerSessionId !== input.ownerSessionId) {
    throw new ClockFoldError("foreign_owner", "Clock event owner does not match the slice owner.");
  }
  if (event.timelineId !== input.timelineId) {
    throw new ClockFoldError("timeline_mismatch", "Clock event is not on the owner-observed timeline.");
  }
  assertNonNegativeInteger(event.monotonicMs, "event.monotonicMs");
  assertNonNegativeInteger(event.wallMs, "event.wallMs");
  if (event.kind !== "observed") assertIdentity(event.activityId, "event.activityId");
}

function validateCheckpoint(
  checkpoint: ClockCheckpoint | undefined,
  timelineId: string,
  heartbeatGraceMs: number,
): void {
  if (checkpoint === undefined) return;
  assertNonNegativeInteger(checkpoint.activeMs, "checkpoint.activeMs");
  assertNonNegativeInteger(checkpoint.lastWallMs, "checkpoint.lastWallMs");
  assertNonNegativeInteger(checkpoint.lastMonotonicMs, "checkpoint.lastMonotonicMs");
  if ((checkpoint.openActivities?.length ?? 0) > 0 && checkpoint.timelineId !== timelineId) {
    throw new ClockFoldError("checkpoint_timeline_mismatch", "Open checkpoint activities require their original timeline.");
  }
  for (const activity of checkpoint.openActivities ?? []) {
    assertIdentity(activity.activityId, "checkpoint.activity.activityId");
    assertNonNegativeInteger(activity.startedMs, "checkpoint.activity.startedMs");
    if (activity.lastHeartbeatMs !== undefined) {
      assertNonNegativeInteger(activity.lastHeartbeatMs, "checkpoint.activity.lastHeartbeatMs");
    }
    if (activity.lastHeartbeatMs !== undefined && activity.lastHeartbeatMs < activity.startedMs) {
      throw new ClockFoldError("invalid_checkpoint", "Checkpoint heartbeat precedes its activity start.");
    }
    if (activity.startedMs > checkpoint.lastMonotonicMs
      || (activity.lastHeartbeatMs ?? activity.startedMs) > checkpoint.lastMonotonicMs) {
      throw new ClockFoldError("invalid_checkpoint", "Checkpoint activity time exceeds its last observation.");
    }
    if (activity.lastHeartbeatMs !== undefined
      && activity.lastHeartbeatMs + heartbeatGraceMs < checkpoint.lastMonotonicMs) {
      throw new ClockFoldError("invalid_checkpoint", "Checkpoint heartbeat grace expired before its last observation.");
    }
  }
}

function restoreActivities(checkpoint: ClockCheckpoint | undefined): {
  open: Map<string, ActivityState>;
  closed: Set<string>;
} {
  const open = new Map<string, ActivityState>();
  const closedIds = checkpoint?.closedActivityIds ?? [];
  closedIds.forEach((activityId) => {
    assertIdentity(activityId, "checkpoint.closedActivityId");
  });
  const closed = new Set(closedIds);
  if (closed.size !== closedIds.length) {
    throw new ClockFoldError("invalid_checkpoint", "Checkpoint contains duplicate closed activity IDs.");
  }
  for (const activity of checkpoint?.openActivities ?? []) {
    if (open.has(activity.activityId) || closed.has(activity.activityId)) {
      throw new ClockFoldError("invalid_checkpoint", `Duplicate checkpoint activity ${activity.activityId}.`);
    }
    open.set(activity.activityId, {
      startedMs: checkpoint?.lastMonotonicMs ?? activity.startedMs,
      checkpointStartedMs: activity.startedMs,
      lastHeartbeatMs: activity.lastHeartbeatMs,
    });
  }
  return { open, closed };
}

function detectAnomalies(
  event: ClockEvent,
  eventIndex: number,
  previousWallMs: number,
  previousMonotonicMs: number,
  compareMonotonic: boolean,
  maxWallSkewMs: number,
): ClockAnomaly[] {
  const anomalies: ClockAnomaly[] = [];
  if (compareMonotonic && event.monotonicMs < previousMonotonicMs) {
    anomalies.push({ code: "backward_monotonic", eventIndex, previousMs: previousMonotonicMs, observedMs: event.monotonicMs });
  }
  if (event.wallMs < previousWallMs) {
    anomalies.push({ code: "backward_wall", eventIndex, previousMs: previousWallMs, observedMs: event.wallMs });
  }
  const wallDelta = event.wallMs - previousWallMs;
  const monotonicDelta = event.monotonicMs - previousMonotonicMs;
  if (compareMonotonic && Math.abs(wallDelta - monotonicDelta) > maxWallSkewMs) {
    anomalies.push({ code: "wall_monotonic_skew", eventIndex, previousMs: monotonicDelta, observedMs: wallDelta });
  }
  return anomalies;
}

function requireOpen(open: Map<string, ActivityState>, activityId: string, closed: Set<string>): ActivityState {
  const activity = open.get(activityId);
  if (activity !== undefined) return activity;
  if (closed.has(activityId)) throw new ClockFoldError("activity_already_settled", `Activity ${activityId} is already settled.`);
  throw new ClockFoldError("activity_not_started", `Activity ${activityId} has not started.`);
}

function applyActivityEvent(
  event: ActivityClockEvent,
  open: Map<string, ActivityState>,
  closed: Set<string>,
  intervals: Interval[],
  recoveries: ClockRecoveryFact[],
  heartbeatGraceMs: number,
): void {
  if (event.kind === "started") {
    if (open.has(event.activityId) || closed.has(event.activityId)) {
      throw new ClockFoldError("duplicate_start", `Activity ${event.activityId} was started more than once.`);
    }
    open.set(event.activityId, {
      startedMs: event.monotonicMs,
      checkpointStartedMs: event.monotonicMs,
    });
    return;
  }
  const activity = requireOpen(open, event.activityId, closed);
  if (event.monotonicMs < activity.startedMs) {
    const code = event.kind === "settled" ? "settle_before_start" : "heartbeat_before_start";
    throw new ClockFoldError(code, `Activity ${event.activityId} event precedes its start.`);
  }
  if (event.kind === "heartbeat") {
    activity.lastHeartbeatMs = event.monotonicMs;
    return;
  }
  if (event.kind === "settled") {
    intervals.push({ startMs: activity.startedMs, endMs: event.monotonicMs });
    open.delete(event.activityId);
    closed.add(event.activityId);
    return;
  }
  if (activity.lastHeartbeatMs === undefined) {
    throw new ClockFoldError("recovery_without_heartbeat", `Activity ${event.activityId} has no heartbeat.`);
  }
  const endMs = Math.min(activity.lastHeartbeatMs + heartbeatGraceMs, event.monotonicMs);
  intervals.push({ startMs: activity.startedMs, endMs });
  open.delete(event.activityId);
  closed.add(event.activityId);
  recoveries.push({
    activityId: event.activityId,
    lastHeartbeatMs: activity.lastHeartbeatMs,
    recoveredThroughMs: endMs,
  });
}

export function foldClockEvents(input: ClockFoldInput): ClockSnapshot {
  assertIdentity(input.ownerSessionId, "ownerSessionId");
  assertIdentity(input.timelineId, "timelineId");
  assertNonNegativeInteger(input.wallStartedAtMs, "wallStartedAtMs");
  assertNonNegativeInteger(input.heartbeatGraceMs, "heartbeatGraceMs");
  assertNonNegativeInteger(input.maxWallSkewMs, "maxWallSkewMs");
  validateCheckpoint(input.checkpoint, input.timelineId, input.heartbeatGraceMs);
  const { open, closed } = restoreActivities(input.checkpoint);
  const intervals: Interval[] = [];
  const recoveries: ClockRecoveryFact[] = [];
  const anomalies: ClockAnomaly[] = [...(input.checkpoint?.anomalies ?? [])];
  let lastWallMs = input.checkpoint?.lastWallMs ?? input.wallStartedAtMs;
  let compareMonotonic = input.checkpoint === undefined || input.checkpoint.timelineId === input.timelineId;
  let lastMonotonicMs = compareMonotonic ? (input.checkpoint?.lastMonotonicMs ?? 0) : 0;

  input.events.forEach((event, eventIndex) => {
    validateEvent(event, input);
    anomalies.push(...detectAnomalies(
      event,
      eventIndex,
      lastWallMs,
      lastMonotonicMs,
      compareMonotonic,
      input.maxWallSkewMs,
    ));
    if (event.kind !== "observed") {
      applyActivityEvent(event, open, closed, intervals, recoveries, input.heartbeatGraceMs);
    }
    lastWallMs = event.wallMs;
    lastMonotonicMs = event.monotonicMs;
    compareMonotonic = true;
  });
  const openIntervals = [...open.values()].map((activity) => ({
    startMs: activity.startedMs,
    endMs: Math.max(activity.startedMs, lastMonotonicMs),
  }));

  if (lastWallMs < input.wallStartedAtMs && input.events.length === 0) {
    anomalies.push({ code: "backward_wall", eventIndex: -1, previousMs: input.wallStartedAtMs, observedMs: lastWallMs });
  }
  const activeMs = (input.checkpoint?.activeMs ?? 0) + unionDuration([...intervals, ...openIntervals]);
  const checkpoint: ClockCheckpoint = {
    activeMs,
    lastWallMs,
    lastMonotonicMs,
    timelineId: input.timelineId,
    openActivities: [...open.entries()].map(([activityId, activity]) => ({
      activityId,
      startedMs: activity.checkpointStartedMs,
      lastHeartbeatMs: activity.lastHeartbeatMs,
    })),
    closedActivityIds: [...closed],
    anomalies,
  };
  return {
    activeMs,
    wallMs: lastWallMs - input.wallStartedAtMs,
    lastWallMs,
    lastMonotonicMs,
    timelineId: input.timelineId,
    cadenceValid: anomalies.length === 0,
    anomalies,
    recoveries,
    openActivityIds: [...open.keys()],
    checkpoint,
  };
}

export interface ThresholdFact {
  elapsedMs: number;
  thresholdMs: number;
  reached: boolean;
}

export type CadenceMeasurement = {
  available: true;
  activeTarget: ThresholdFact;
  activeReview: ThresholdFact;
  activeHardSeal: ThresholdFact;
  wallWarning: ThresholdFact;
  wallHardSeal: ThresholdFact;
} | {
  available: false;
  anomalies: readonly ClockAnomaly[];
};

function thresholdFact(elapsedMs: number, thresholdMs: number): ThresholdFact {
  return { elapsedMs, thresholdMs, reached: elapsedMs >= thresholdMs };
}

export function measureCadence(
  snapshot: ClockSnapshot,
  policy: { readonly cadence: Readonly<GuardianPolicyConfig["cadence"]> },
): CadenceMeasurement {
  if (!snapshot.cadenceValid) return { available: false, anomalies: snapshot.anomalies };
  return {
    available: true,
    activeTarget: thresholdFact(snapshot.activeMs, policy.cadence.activeTargetMs),
    activeReview: thresholdFact(snapshot.activeMs, policy.cadence.activeReviewMs),
    activeHardSeal: thresholdFact(snapshot.activeMs, policy.cadence.activeHardSealMs),
    wallWarning: thresholdFact(snapshot.wallMs, policy.cadence.wallWarningMs),
    wallHardSeal: thresholdFact(snapshot.wallMs, policy.cadence.wallHardSealMs),
  };
}

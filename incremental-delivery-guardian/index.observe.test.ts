import assert from "node:assert/strict";
import test from "node:test";

import {
  GUARDIAN_OBSERVATION_EVENT,
  GUARDIAN_REGISTRATION_EVENT,
  GUARDIAN_REGISTRATION_RESULT_EVENT,
  GUARDIAN_TELEMETRY_EVENT,
  DELIVERY_SLICE_SCHEMA_HASH,
  createPassiveGuardianExtension,
} from "./index.ts";

class FakeBus {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler); this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

function fakePi() {
  const bus = new FakeBus();
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    events: bus,
    on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); },
  };
  createPassiveGuardianExtension()(pi as never);
  return { bus, handlers };
}

function slice(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    registrationId: "reg-1",
    repositoryId: "owner/repo",
    repositoryRoot: "/data/repos/repo",
    ownerId: "owner-1",
    outcome: "deliver guardian registration",
    acceptanceCriteria: ["operations remain unchanged"],
    beadId: "piext-tbj",
    branch: "bd-piext-tbj",
    baseRef: "bd-piext-ou7",
    domains: ["guardian"],
    pathGroups: [{ name: "source", roots: ["incremental-delivery-guardian"] }],
    exclusions: ["node_modules"],
    verificationPlan: ["npm run test:guardian"],
    riskClass: "policy_change",
    dependencies: ["piext-ou7"],
    ...overrides,
  };
}

function availableObservation(overrides: Record<string, unknown> = {}) {
  const fact = { thresholdMs: 3 * 60 * 60 * 1_000, elapsedMs: 3 * 60 * 60 * 1_000, reached: true };
  return {
    registrationId: "reg-1",
    observationId: "obs-1",
    cadence: {
      available: true,
      activeElapsedMs: fact.elapsedMs,
      wallElapsedMs: fact.elapsedMs,
      activeTarget: fact,
      activeReview: { ...fact, thresholdMs: 4 * 60 * 60 * 1_000, reached: false },
      activeEscalation: { ...fact, thresholdMs: 6 * 60 * 60 * 1_000, reached: false },
      wallWarning: { ...fact, thresholdMs: 12 * 60 * 60 * 1_000, reached: false },
      wallEscalation: { ...fact, thresholdMs: 24 * 60 * 60 * 1_000, reached: false },
      anomalies: [],
    },
    scope: {
      classification: "in_scope",
      reasonCode: "declared_path",
      evidence: { requestedPath: "src/a.ts", canonicalPath: "src/a.ts", pathGroup: "source" },
    },
    ledger: {
      supportMinutes: { value: 0, threshold: 30, reached: false },
      microItems: { value: 0, threshold: 5, reached: false },
    },
    componentIssues: [],
    ...overrides,
  };
}

function ctx(cwd = "/data/repos/repo") {
  const notifications: Array<{ message: string; level: string }> = [];
  return { cwd, hasUI: true, ui: { notify(message: string, level: string) { notifications.push({ message, level }); } }, notifications };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await Promise.resolve();
}

test("registration works without reviewer, provider, or audit capability", async () => {
  const { bus, handlers } = fakePi();
  const results: unknown[] = [];
  bus.on(GUARDIAN_REGISTRATION_RESULT_EVENT, (value) => results.push(value));
  await handlers.get("session_start")!({}, ctx());
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice());
  assert.deepEqual(results, [{ status: "registered", registrationId: "reg-1", repositoryId: "owner/repo" }]);
  assert.match(DELIVERY_SLICE_SCHEMA_HASH, /^[a-f0-9]{64}$/);
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice());
  assert.equal((results[1] as any).code, "duplicate_registration");
  assert.equal((results[1] as any).componentIssue.component, "harness_adapter");
});

test("advisory observations emit facts and nudges without mutation authority", async () => {
  const { bus, handlers } = fakePi();
  const telemetry: any[] = [];
  bus.on(GUARDIAN_TELEMETRY_EVENT, (value) => telemetry.push(value));
  await handlers.get("session_start")!({}, ctx());
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice());
  bus.emit(GUARDIAN_OBSERVATION_EVENT, availableObservation());
  await flush();
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].status, "assessed");
  assert.equal(telemetry[0].outcome, "nudge");
  assert.deepEqual(telemetry[0].reasonCodes, ["cadence_active_target_reached"]);
  assert.equal(telemetry[0].mutationEffect, "unchanged");
  assert.equal("mutation" in telemetry[0], false);
  assert.equal("block" in telemetry[0], false);
});

test("component gaps and malformed observations are visible telemetry", async () => {
  const { bus, handlers } = fakePi();
  const telemetry: any[] = [];
  const context = ctx();
  bus.on(GUARDIAN_TELEMETRY_EVENT, (value) => telemetry.push(value));
  await handlers.get("session_start")!({}, context);
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice());
  bus.emit(GUARDIAN_OBSERVATION_EVENT, availableObservation({
    componentIssues: [
      { component: "audit", code: "store_unavailable" },
      { component: "reviewer", code: "capability_unavailable" },
      { component: "provider", code: "request_unavailable" },
    ],
  }));
  bus.emit(GUARDIAN_OBSERVATION_EVENT, { registrationId: "reg-1", observationId: "bad" });
  bus.emit(GUARDIAN_OBSERVATION_EVENT, availableObservation({ observationId: 5 }));
  bus.emit(GUARDIAN_OBSERVATION_EVENT, availableObservation({ observationId: "" }));
  await flush();
  assert.equal(telemetry[0].outcome, "telemetry_unavailable");
  assert.deepEqual(telemetry[0].reasonCodes, ["audit_store_unavailable", "reviewer_capability_unavailable", "provider_request_unavailable", "cadence_active_target_reached"]);
  assert.equal(telemetry[1].status, "telemetry_unavailable");
  assert.equal(telemetry[1].componentIssue.component, "harness_adapter");
  assert.equal(telemetry[2].code, "registration_unavailable");
  assert.equal(telemetry[3].code, "registration_unavailable");
  assert.equal(context.notifications.length, 0);
});

test("tool_call and user_bash handlers return immediately and preserve operations by identity", async () => {
  const { bus, handlers } = fakePi();
  const telemetry: any[] = [];
  bus.on(GUARDIAN_TELEMETRY_EVENT, (value) => telemetry.push(value));
  const context = ctx();
  await handlers.get("session_start")!({}, context);
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice());
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice({ registrationId: "reg-z" }));
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice({ registrationId: "reg-a" }));

  const input = Object.freeze({ path: "src/a.ts", edits: Object.freeze([{ oldText: "a", newText: "b" }]) });
  const toolEvent = { toolCallId: "tool-1", toolName: "edit", input };
  const toolReturn = handlers.get("tool_call")!(toolEvent, context);
  assert.equal(toolReturn, undefined);
  assert.equal(toolEvent.input, input);
  assert.deepEqual(toolEvent.input, input);

  const bashEvent = Object.freeze({ command: "printf ok", excludeFromContext: false, cwd: context.cwd });
  const bashReturn = handlers.get("user_bash")!(bashEvent, context);
  assert.equal(bashReturn, undefined);
  await flush();
  assert.deepEqual(telemetry.slice(-2), [
    { status: "operation_observed", source: "tool_call", operationId: "tool-1", operationName: "edit", registrationIds: ["reg-1", "reg-a", "reg-z"], mutationEffect: "unchanged" },
    { status: "operation_observed", source: "user_bash", operationId: "user_bash:1", operationName: "bash", registrationIds: ["reg-1", "reg-a", "reg-z"], mutationEffect: "unchanged" },
  ]);
  const otherContext = ctx("/data/other");
  handlers.get("tool_call")!({ toolCallId: "other", toolName: "read", input: {} }, otherContext);
  handlers.get("user_bash")!({ command: "pwd", cwd: otherContext.cwd }, otherContext);
  await flush();
  assert.deepEqual(telemetry.at(-2).registrationIds, []);
  assert.deepEqual(telemetry.at(-1).registrationIds, []);
  assert.equal(telemetry.at(-1).operationId, "user_bash:2");
});

test("invalid, pre-session, and repository-mismatched registration stays visible", async () => {
  const { bus, handlers } = fakePi();
  const results: any[] = [];
  const telemetry: any[] = [];
  bus.on(GUARDIAN_REGISTRATION_RESULT_EVENT, (value) => results.push(value));
  bus.on(GUARDIAN_TELEMETRY_EVENT, (value) => telemetry.push(value));
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice());
  assert.equal(results[0].code, "session_unavailable");
  assert.equal(results[0].componentIssue.component, "harness_adapter");
  await handlers.get("session_start")!({}, ctx());
  bus.emit(GUARDIAN_REGISTRATION_EVENT, { ...slice(), mode: "enforce" });
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice({ registrationId: "reg-2", repositoryRoot: "/data/other" }));
  bus.emit(GUARDIAN_OBSERVATION_EVENT, availableObservation());
  await flush();
  assert.equal(results[1].status, "invalid");
  assert.equal(results[1].componentIssue.component, "harness_adapter");
  assert.equal(results[2].code, "repository_mismatch");
  assert.equal(results[2].componentIssue.component, "harness_adapter");
  assert.equal(telemetry[0].status, "telemetry_unavailable");
  assert.equal(telemetry[0].code, "registration_unavailable");
  assert.equal(telemetry[0].componentIssue.component, "harness_adapter");
});

test("registration contract rejects empty, duplicate, relative, and malformed fields", async () => {
  const { bus, handlers } = fakePi();
  const results: any[] = [];
  bus.on(GUARDIAN_REGISTRATION_RESULT_EVENT, (value) => results.push(value));
  await handlers.get("session_start")!({}, ctx());
  for (const invalid of [
    slice({ registrationId: "bad space" }),
    slice({ outcome: "" }),
    slice({ acceptanceCriteria: [] }),
    slice({ acceptanceCriteria: ["same", "same"] }),
    slice({ repositoryRoot: "relative/repo" }),
    slice({ pathGroups: [] }),
    slice({ exclusions: ["same", "same"] }),
    slice({ dependencies: ["same", "same"] }),
  ]) bus.emit(GUARDIAN_REGISTRATION_EVENT, invalid);
  assert.equal(results.length, 8);
  assert.ok(results.every((result) => result.status === "invalid" && result.code === "registration_contract_invalid"));
});

test("protected CORTO roots receive no registration or observation capability", async () => {
  const crossRoot = fakePi();
  const crossResults: any[] = [];
  crossRoot.bus.on(GUARDIAN_REGISTRATION_RESULT_EVENT, (value) => crossResults.push(value));
  await crossRoot.handlers.get("session_start")!({}, ctx());
  crossRoot.bus.emit(GUARDIAN_REGISTRATION_EVENT, slice({ repositoryRoot: "/data/repos/corto-spike/.worktrees/bd-corto-4d2m-branch-mcp-infrastructure" }));
  assert.equal(crossResults[0].status, "excluded");

  for (const protectedRoot of [
    "/data/repos/corto-spike/.worktrees/bd-corto-4d2m-branch-mcp-infrastructure",
    "/data/repos/corto-spike/.worktrees/bd-corto-prod-lawconnect-downstream-enable",
    "/data/repos/corto-spike/.worktrees/x/../bd-corto-4d2m-branch-mcp-infrastructure/child",
  ]) {
    const { bus, handlers } = fakePi();
    const results: any[] = [];
    const telemetry: any[] = [];
    bus.on(GUARDIAN_REGISTRATION_RESULT_EVENT, (value) => results.push(value));
    bus.on(GUARDIAN_TELEMETRY_EVENT, (value) => telemetry.push(value));
    const context = ctx(protectedRoot);
    await handlers.get("session_start")!({}, context);
    bus.emit(GUARDIAN_REGISTRATION_EVENT, slice({ repositoryRoot: protectedRoot }));
    assert.equal(handlers.get("tool_call")!({ toolCallId: "x", toolName: "read", input: { path: "secret" } }, context), undefined);
    assert.equal(handlers.get("user_bash")!({ command: "pwd", cwd: protectedRoot }, context), undefined);
    bus.emit(GUARDIAN_OBSERVATION_EVENT, availableObservation());
    await flush();
    assert.equal(results[0].status, "excluded");
    assert.deepEqual(telemetry, []);
  }
});

test("telemetry publication and queued-task failures remain visible without affecting handlers", async () => {
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (message?: unknown) => { errors.push(String(message)); };
  try {
    const { bus, handlers } = fakePi();
    const context = ctx();
    await handlers.get("session_start")!({}, context);
    bus.emit(GUARDIAN_REGISTRATION_EVENT, slice());
    bus.on(GUARDIAN_TELEMETRY_EVENT, () => { throw new Error("listener failed"); });
    assert.equal(handlers.get("tool_call")!({ toolCallId: "x", toolName: "read", input: {} }, context), undefined);
    await flush();
    assert.ok(context.notifications.some((entry) => entry.message === "Guardian telemetry publication unavailable."));

    const malformed = new Proxy({}, { get() { throw new Error("decode failed"); } });
    bus.emit(GUARDIAN_OBSERVATION_EVENT, malformed);
    await flush();
    assert.ok(context.notifications.some((entry) => entry.message === "Guardian telemetry unavailable."));
    assert.ok(errors.some((entry) => entry.includes("publication unavailable")));
    assert.ok(errors.some((entry) => entry.includes("task unavailable")));

    const noContext = fakePi();
    noContext.bus.on(GUARDIAN_REGISTRATION_RESULT_EVENT, () => { throw new Error("listener failed"); });
    assert.doesNotThrow(() => noContext.bus.emit(GUARDIAN_REGISTRATION_EVENT, slice()));
  } finally {
    console.error = originalError;
  }
});

test("session shutdown clears registrations, stops observation, and removes bus listeners", async () => {
  const { bus, handlers } = fakePi();
  const results: any[] = [];
  const telemetry: any[] = [];
  bus.on(GUARDIAN_REGISTRATION_RESULT_EVENT, (value) => results.push(value));
  bus.on(GUARDIAN_TELEMETRY_EVENT, (value) => telemetry.push(value));
  await handlers.get("session_start")!({}, ctx());
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice());
  await handlers.get("session_shutdown")!({}, ctx());
  bus.emit(GUARDIAN_REGISTRATION_EVENT, slice({ registrationId: "reg-2" }));
  handlers.get("tool_call")!({ toolCallId: "after", toolName: "read", input: {} }, ctx());
  await flush();
  assert.deepEqual(results.map((entry) => entry.registrationId), ["reg-1"]);
  assert.deepEqual(telemetry, []);
});

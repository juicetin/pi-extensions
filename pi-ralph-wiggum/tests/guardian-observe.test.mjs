import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ralphExtension from "../index.ts";
import { createPassiveGuardianExtension, GUARDIAN_TELEMETRY_EVENT } from "../../incremental-delivery-guardian/index.ts";

function fakePi({ failObservation = false } = {}) {
  const handlers = new Map();
  const bus = new Map();
  const tools = new Map();
  const telemetry = [];
  const emitted = [];
  const sent = [];
  const pi = {
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(message, options) { sent.push({ message, options }); },
    events: {
      on(name, handler) { const list = bus.get(name) ?? []; list.push(handler); bus.set(name, list); return () => bus.set(name, (bus.get(name) ?? []).filter((entry) => entry !== handler)); },
      emit(name, data) {
        if (failObservation && name === "incremental-delivery-guardian:observe") throw new Error("bus unavailable");
        emitted.push({ name, data });
        for (const handler of bus.get(name) ?? []) handler(data);
      },
    },
  };
  pi.events.on(GUARDIAN_TELEMETRY_EVENT, (event) => telemetry.push(event));
  return { pi, handlers, tools, telemetry, emitted, sent };
}

async function fire(runtime, name, event, context) {
  let result;
  for (const handler of runtime.handlers.get(name) ?? []) {
    const next = await handler(event, context);
    if (next !== undefined) result = next;
  }
  await new Promise((resolve) => setImmediate(resolve));
  return result;
}

function fixture({ paths = [], domains = [], activeMs = 0, checkpoint = true, openActivities = [] } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-guardian-observe-"));
  fs.mkdirSync(path.join(cwd, ".ralph"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".ralph", "loop.md"), "# Loop\n");
  const now = Date.now();
  const timelineId = "ralph:loop:timeline";
  const state = {
    name: "loop", taskFile: ".ralph/loop.md", iteration: 3, maxIterations: 20, itemsPerIteration: 1,
    reflectEvery: 0, reflectInstructions: "reflect", active: true, status: "active", startedAt: new Date(now - 1000).toISOString(),
    lastReflectionAt: 0, ownerSessionId: "owner", schemaVersion: 1, consumedDeliveryReceiptHashes: [],
    guardian: {
      schemaVersion: 1, timelineId, wallStartedAtMs: now - 1000,
      ...(checkpoint ? { clockCheckpoint: { activeMs, lastWallMs: now - 1, lastMonotonicMs: now - 1, timelineId, openActivities, closedActivityIds: [], anomalies: [] } } : {}),
      observedScope: { paths, domains },
    },
  };
  const statePath = path.join(cwd, ".ralph", "loop.state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const notifications = [];
  const context = {
    cwd, sessionManager: { getSessionId: () => "owner" }, hasUI: true,
    ui: { notify(message, level) { notifications.push({ message, level }); }, setStatus() {}, setWidget() {}, theme: { fg(_n, t) { return t; }, bold(t) { return t; } } },
    isIdle: () => true, hasPendingMessages: () => false,
  };
  return { cwd, statePath, context, notifications };
}

async function setup(options, fixtureOptions) {
  const runtime = fakePi(options);
  createPassiveGuardianExtension()(runtime.pi);
  ralphExtension(runtime.pi);
  const f = fixture(fixtureOptions);
  await fire(runtime, "session_start", {}, f.context);
  return { ...runtime, ...f };
}

test("Ralph lifecycle publishes normalized advisory facts without changing prompt control", async () => {
  const runtime = await setup({}, {});
  const registration = runtime.emitted.find(({ name }) => name === "incremental-delivery-guardian:register")?.data;
  assert.equal(registration.repositoryId, path.basename(runtime.cwd));
  assert.deepEqual(registration.domains, ["ralph"]);
  assert.deepEqual(registration.exclusions, []);
  const result = await fire(runtime, "before_agent_start", { systemPrompt: "base" }, runtime.context);
  assert.match(result.systemPrompt, /RALPH LOOP/);
  const assessed = runtime.telemetry.find((event) => event.status === "assessed");
  assert.equal(assessed?.mutationEffect, "unchanged");
  assert.equal(assessed?.outcome, "normal");
  assert.deepEqual(assessed?.reasonCodes, []);
  assert.ok(assessed?.facts.some((fact) => fact.kind === "cadence"));
  assert.deepEqual(assessed?.facts.find((fact) => fact.kind === "scope")?.fact, {
    classification: "in_scope",
    reasonCode: "declared_scope",
    evidence: { kind: "path", domain: "ralph", pathGroup: "repository", requestedPaths: [], canonicalPaths: [] },
  });
  assert.deepEqual(assessed?.facts.filter((fact) => fact.kind === "scope_ledger").map((fact) => fact.fact), [
    { value: 0, threshold: 30, reached: false },
    { value: 0, threshold: 5, reached: false },
  ]);
  let state = JSON.parse(fs.readFileSync(runtime.statePath));
  assert.deepEqual(state.guardian.clockCheckpoint.openActivities.map(({ activityId }) => activityId), ["iteration:3"]);
  assert.deepEqual(state.guardian.clockCheckpoint.closedActivityIds, []);
  await fire(runtime, "before_agent_start", { systemPrompt: "base" }, runtime.context);
  state = JSON.parse(fs.readFileSync(runtime.statePath));
  assert.equal(state.guardian.clockCheckpoint.openActivities.length, 1);
  assert.equal(typeof state.guardian.clockCheckpoint.openActivities[0].lastHeartbeatMs, "number");
  await fire(runtime, "agent_end", { messages: [] }, runtime.context);
  state = JSON.parse(fs.readFileSync(runtime.statePath));
  assert.deepEqual(state.guardian.clockCheckpoint.openActivities, []);
  assert.deepEqual(state.guardian.clockCheckpoint.closedActivityIds, ["iteration:3"]);
  assert.ok(state.guardian.clockCheckpoint.activeMs >= 0);
  assert.deepEqual(state.guardian.observedScope, { paths: [], domains: [] });
});

test("scope and cadence thresholds request advice but never deny lifecycle", async () => {
  const runtime = await setup({}, { paths: ["a", "b", "c", "d", "e", "f"], domains: ["api"], activeMs: 7 * 60 * 60 * 1000 });
  const result = await fire(runtime, "before_agent_start", { systemPrompt: "base" }, runtime.context);
  assert.match(result.systemPrompt, /RALPH LOOP/);
  const assessed = runtime.telemetry.findLast((event) => event.status === "assessed");
  assert.equal(assessed?.outcome, "review_requested");
  assert.equal(assessed?.reviewIntent?.kind, "request_review");
  assert.deepEqual(assessed?.facts.find((fact) => fact.kind === "scope")?.fact, {
    classification: "ambiguous",
    reasonCode: "missing_canonical_evidence",
    evidence: { kind: "path", domain: "api", pathGroup: "repository", requestedPaths: ["a", "b", "c", "d", "e", "f"], canonicalPaths: [] },
  });
  assert.deepEqual(assessed?.facts.filter((fact) => fact.kind === "scope_ledger").map((fact) => fact.fact), [
    { value: 0, threshold: 30, reached: false },
    { value: 6, threshold: 5, reached: true },
  ]);
  const rejected = await runtime.tools.get("ralph_done").execute("call", {}, undefined, undefined, runtime.context);
  assert.match(rejected.content[0].text, /delivery rejected/i);
  assert.equal(JSON.parse(fs.readFileSync(runtime.statePath)).iteration, 3);
});

test("path-only and domain-only observations independently produce advisory nudges", async () => {
  for (const observed of [{ paths: ["src/a.ts"], domains: [] }, { paths: [], domains: ["api"] }]) {
    const runtime = await setup({}, observed);
    await fire(runtime, "before_agent_start", { systemPrompt: "base" }, runtime.context);
    const assessed = runtime.telemetry.findLast((event) => event.status === "assessed");
    assert.equal(assessed?.outcome, "nudge");
    assert.ok(assessed?.reasonCodes.includes("scope_missing_canonical_evidence"));
  }
});

test("settle without an open activity is a harmless observation", async () => {
  const runtime = await setup({}, {});
  await fire(runtime, "agent_end", { messages: [] }, runtime.context);
  const state = JSON.parse(fs.readFileSync(runtime.statePath));
  assert.deepEqual(state.guardian.clockCheckpoint.openActivities, []);
  assert.deepEqual(state.guardian.clockCheckpoint.closedActivityIds, []);
  const assessed = runtime.telemetry.findLast((event) => event.status === "assessed");
  assert.equal(assessed?.mutationEffect, "unchanged");
  assert.equal(assessed?.outcome, "normal");
  assert.deepEqual(assessed?.reasonCodes, []);
});

test("foreign lifecycle observation becomes exact visible telemetry without blocking the prompt", async () => {
  const runtime = await setup({}, {});
  runtime.context.sessionManager.getSessionId = () => "foreign";
  const result = await fire(runtime, "before_agent_start", { systemPrompt: "base" }, runtime.context);
  assert.match(result.systemPrompt, /RALPH LOOP/);
  const unavailable = runtime.telemetry.findLast((event) => event.status === "assessed");
  assert.equal(unavailable?.outcome, "telemetry_unavailable");
  assert.deepEqual(unavailable?.reasonCodes, ["ralph_adapter_observation_unavailable"]);
  assert.deepEqual(unavailable?.facts.filter((fact) => fact.kind === "component_issue"), [
    { kind: "component_issue", issue: { component: "ralph_adapter", code: "observation_unavailable" } },
  ]);
});

test("missing and unrelated activity checkpoints start only the current iteration", async () => {
  for (const options of [
    { checkpoint: false },
    { openActivities: [{ activityId: "iteration:2", startedMs: Date.now() - 1, lastHeartbeatMs: Date.now() - 1 }] },
  ]) {
    const runtime = await setup({}, options);
    await fire(runtime, "before_agent_start", { systemPrompt: "base" }, runtime.context);
    const state = JSON.parse(fs.readFileSync(runtime.statePath));
    assert.ok(state.guardian.clockCheckpoint.openActivities.some(({ activityId }) => activityId === "iteration:3"));
    if (options.openActivities) assert.equal(state.guardian.clockCheckpoint.openActivities.length, 2);
  }
});

test("guardian publication failure is visible and cannot block Ralph lifecycle", async () => {
  const runtime = await setup({ failObservation: true }, {});
  const result = await fire(runtime, "before_agent_start", { systemPrompt: "base" }, runtime.context);
  assert.match(result.systemPrompt, /RALPH LOOP/);
  assert.ok(runtime.notifications.some(({ message, level }) => /telemetry publication unavailable/i.test(message) && level === "warning"));
  assert.equal(JSON.parse(fs.readFileSync(runtime.statePath)).status, "active");

  runtime.notifications.length = 0;
  runtime.context.hasUI = false;
  await fire(runtime, "agent_end", { messages: [] }, runtime.context);
  assert.deepEqual(runtime.notifications, []);
});

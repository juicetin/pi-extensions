import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ralphExtension from "../index.ts";

function runtime() {
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage() {},
  };
  ralphExtension(pi);
  return { events, commands, tools };
}

function context(cwd, ownerSessionId) {
  return {
    cwd,
    sessionManager: { getSessionId: () => ownerSessionId },
    hasUI: false,
    ui: { notify() {}, setStatus() {}, setWidget() {}, theme: { fg(_n, text) { return text; }, bold(text) { return text; } } },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

function tempLoop(state) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-guardian-state-"));
  fs.mkdirSync(path.join(cwd, ".ralph"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".ralph", "loop.md"), "# Loop\n", "utf8");
  const statePath = path.join(cwd, ".ralph", "loop.state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  return { cwd, statePath };
}

function exactDelivery() {
  return {
    ownerSessionId: "owner",
    claim: {
      repositoryId: "acme/repo", pullRequestNumber: 42, branch: "feature", headSha: "a".repeat(40), baseRef: "main",
      observedAt: "2026-07-15T10:05:00.000Z", maxAgeMs: 600000,
      local: { commitSha: "a".repeat(40), branch: "feature", pushed: true, verificationId: "verify-1", verificationCompletedAt: "2026-07-15T10:03:00.000Z" },
    },
    evidence: {
      provider: "github", repositoryId: "acme/repo", pullRequestNumber: 42, state: "open", merged: false,
      updatedAt: "2026-07-15T10:04:00.000Z", observedAt: "2026-07-15T10:04:00.000Z",
      headRef: "feature", headSha: "a".repeat(40), headRepositoryId: "acme/repo", baseRef: "main", baseRepositoryId: "acme/repo",
      ciState: "success", reviewState: "approved",
    },
  };
}

const baseState = {
  name: "loop",
  taskFile: ".ralph/loop.md",
  iteration: 3,
  maxIterations: 20,
  itemsPerIteration: 1,
  reflectEvery: 0,
  reflectInstructions: "reflect",
  active: true,
  status: "active",
  startedAt: "2026-07-08T11:54:18.989Z",
  lastReflectionAt: 0,
};

test("new loops persist versioned empty advisory observations", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-guardian-start-"));
  const app = runtime();
  await app.tools.get("ralph_start").execute("call", { name: "loop", taskContent: "# Loop", maxIterations: 5 }, undefined, undefined, context(cwd, "owner"));
  const state = JSON.parse(fs.readFileSync(path.join(cwd, ".ralph", "loop.state.json"), "utf8"));
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.guardian.schemaVersion, 1);
  assert.equal(state.guardian.timelineId, `ralph:loop:${state.startedAt}`);
  assert.equal(state.guardian.wallStartedAtMs, Date.parse(state.startedAt));
  assert.deepEqual(state.guardian.observedScope, { paths: [], domains: [] });
  assert.equal(state.guardian.clockCheckpoint, undefined);
});

test("legacy resume migrates state without advancing or manufacturing observations", async () => {
  const fixture = tempLoop(baseState);
  const app = runtime();
  await app.commands.get("ralph").handler("resume loop", context(fixture.cwd, "owner"));
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  assert.equal(state.iteration, 3);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.guardian.wallStartedAtMs, Date.parse(baseState.startedAt));
  assert.deepEqual(state.guardian.observedScope, { paths: [], domains: [] });
  assert.equal(state.guardian.clockCheckpoint, undefined);
});

test("resume preserves clock checkpoints and scope observations exactly", async () => {
  const guardian = {
    schemaVersion: 1,
    timelineId: "ralph:loop:timeline",
    wallStartedAtMs: 1000,
    clockCheckpoint: { activeMs: 900, lastWallMs: 5000, lastMonotonicMs: 4000, timelineId: "ralph:loop:timeline", openActivities: [], closedActivityIds: ["turn-1"], anomalies: [] },
    observedScope: { paths: ["src/a.ts"], domains: ["api"] },
  };
  const fixture = tempLoop({ ...baseState, schemaVersion: 1, ownerSessionId: "old", guardian });
  const app = runtime();
  await app.commands.get("ralph").handler("resume loop", context(fixture.cwd, "new"));
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  assert.equal(state.iteration, 3);
  assert.deepEqual(state.guardian, guardian);
});

test("advisory timing and scope observations never block iteration advancement", async () => {
  const guardian = {
    schemaVersion: 1,
    timelineId: "ralph:loop:timeline",
    wallStartedAtMs: 0,
    clockCheckpoint: { activeMs: 999999999, lastWallMs: 999999999, lastMonotonicMs: 999999999, timelineId: "ralph:loop:timeline", openActivities: [], closedActivityIds: [], anomalies: [] },
    observedScope: { paths: ["every/file.ts"], domains: ["api", "db", "ui"] },
  };
  const fixture = tempLoop({ ...baseState, schemaVersion: 1, ownerSessionId: "owner", guardian });
  const app = runtime();
  const ctx = context(fixture.cwd, "owner");
  await app.events.get("session_start")({}, ctx);
  const result = await app.tools.get("ralph_done").execute("call", exactDelivery(), undefined, undefined, ctx);
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  assert.match(result.content[0].text, /Next iteration queued/);
  assert.equal(state.iteration, 4);
  assert.deepEqual(state.guardian, guardian);
});

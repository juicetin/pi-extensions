import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ralphExtension from "../index.ts";

function app() {
  const events = new Map();
  const tools = new Map();
  const pi = { on: (name, handler) => events.set(name, handler), registerCommand() {}, registerTool: (tool) => tools.set(tool.name, tool), sendUserMessage() {} };
  ralphExtension(pi);
  return { events, tools };
}

function ctx(cwd, ownerSessionId = "session-1") {
  return { cwd, sessionManager: { getSessionId: () => ownerSessionId }, hasUI: false, ui: { notify() {}, setStatus() {}, setWidget() {}, theme: { fg(_n, t) { return t; }, bold(t) { return t; } } }, isIdle: () => true, hasPendingMessages: () => false };
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-delivery-"));
  fs.mkdirSync(path.join(cwd, ".ralph"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".ralph", "loop.md"), "# Loop\n", "utf8");
  const startedAt = "2026-07-15T10:00:00.000Z";
  const state = {
    name: "loop", taskFile: ".ralph/loop.md", iteration: 3, maxIterations: 20, itemsPerIteration: 1,
    reflectEvery: 0, reflectInstructions: "reflect", active: true, status: "active", startedAt,
    lastReflectionAt: 0, ownerSessionId: "session-1", schemaVersion: 1,
    guardian: { schemaVersion: 1, timelineId: `ralph:loop:${startedAt}`, wallStartedAtMs: Date.parse(startedAt), observedScope: { paths: [], domains: [] } },
  };
  const statePath = path.join(cwd, ".ralph", "loop.state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { cwd, statePath };
}

function submission(overrides = {}) {
  const claim = {
    repositoryId: "acme/repo", pullRequestNumber: 42, branch: "feature", headSha: "a".repeat(40), baseRef: "main",
    observedAt: "2026-07-15T10:05:00.000Z", maxAgeMs: 600000,
    local: { commitSha: "a".repeat(40), branch: "feature", pushed: true, verificationId: "verify-1", verificationCompletedAt: "2026-07-15T10:03:00.000Z" },
  };
  const evidence = {
    provider: "github", repositoryId: "acme/repo", pullRequestNumber: 42, state: "open", merged: false,
    updatedAt: "2026-07-15T10:04:00.000Z", observedAt: "2026-07-15T10:04:00.000Z",
    headRef: "feature", headSha: "a".repeat(40), headRepositoryId: "acme/repo", baseRef: "main", baseRepositoryId: "acme/repo",
    ciState: "success", reviewState: "approved",
  };
  return { ownerSessionId: "session-1", complete: false, claim, evidence, ...overrides };
}

async function bound() {
  const f = fixture();
  const runtime = app();
  const context = ctx(f.cwd);
  await runtime.events.get("session_start")({}, context);
  return { ...f, ...runtime, context };
}

async function done(runtime, params) {
  return runtime.tools.get("ralph_done").execute("call", params, undefined, undefined, runtime.context);
}

test("empty, text-only, push-only, and malformed completion claims cannot advance", async () => {
  for (const [params, code] of [
    [{}, "claim_mismatch"],
    [{ receipt: "pushed" }, "claim_mismatch"],
    [{ ownerSessionId: "session-1", claim: { local: { pushed: true } } }, "invalid_request"],
    [submission({ complete: "yes" }), "invalid_request"],
    [submission({ evidence: { ...submission().evidence, provider: "gitlab" } }), "invalid_request"],
  ]) {
    const runtime = await bound();
    const result = await done(runtime, params);
    assert.equal(result.details.code, code);
    assert.match(result.content[0].text, new RegExp(`Ralph delivery rejected: ${code}`));
    assert.equal(JSON.parse(fs.readFileSync(runtime.statePath)).iteration, 3);
  }
});

test("foreign, stale, and mismatched evidence cannot advance", async () => {
  const invalid = [
    [submission({ ownerSessionId: "other" }), "claim_mismatch"],
    [submission({ evidence: { ...submission().evidence, observedAt: "2026-07-15T09:00:00.000Z" } }), "stale_evidence"],
    [submission({ claim: { ...submission().claim, headSha: "b".repeat(40) } }), "claim_mismatch"],
  ];
  for (const [params, code] of invalid) {
    const runtime = await bound();
    const result = await done(runtime, params);
    assert.equal(result.details.code, code);
    assert.match(result.content[0].text, new RegExp(`Ralph delivery rejected: ${code}`));
    assert.equal(JSON.parse(fs.readFileSync(runtime.statePath)).iteration, 3);
  }

  const runtime = await bound();
  runtime.context.sessionManager.getSessionId = () => "foreign-runtime";
  let result = await done(runtime, submission());
  assert.equal(result.details.code, "claim_mismatch");
  assert.equal(JSON.parse(fs.readFileSync(runtime.statePath)).iteration, 3);

  result = await done(runtime, submission({ ownerSessionId: "foreign-runtime" }));
  assert.equal(result.details.code, "claim_mismatch");
  assert.equal(JSON.parse(fs.readFileSync(runtime.statePath)).iteration, 3);
});

test("valid exact evidence advances once and records its structured receipt", async () => {
  const runtime = await bound();
  const result = await done(runtime, submission());
  const state = JSON.parse(fs.readFileSync(runtime.statePath));
  assert.match(result.content[0].text, /Next iteration queued/);
  assert.equal(state.iteration, 4);
  assert.equal(state.lastDelivery.iteration, 3);
  assert.equal(state.lastDelivery.completed, false);
  assert.equal(state.lastDelivery.receipt.headSha, "a".repeat(40));
  assert.deepEqual(result.details.receipt, state.lastDelivery.receipt);
  assert.match(state.lastDelivery.receipt.receiptHash, /^[a-f0-9]{64}$/);
});

test("normalized Bitbucket evidence uses the same strict lifecycle contract", async () => {
  const runtime = await bound();
  const result = await done(runtime, submission({ evidence: { ...submission().evidence, provider: "bitbucket" } }));
  const state = JSON.parse(fs.readFileSync(runtime.statePath));
  assert.match(result.content[0].text, /Next iteration queued/);
  assert.equal(state.lastDelivery.receipt.provider, "bitbucket");
});

test("the same receipt cannot be replayed for another iteration", async () => {
  const runtime = await bound();
  await done(runtime, submission());
  const replay = await done(runtime, submission());
  const state = JSON.parse(fs.readFileSync(runtime.statePath));
  assert.match(replay.content[0].text, /receipt_replayed/);
  assert.equal(replay.details.code, "receipt_replayed");
  assert.equal(state.iteration, 4);
  assert.equal(state.consumedDeliveryReceiptHashes.length, 1);
});

test("completion marker alone cannot complete, while exact structured completion can", async () => {
  const runtime = await bound();
  await runtime.events.get("agent_end")({ messages: [{ role: "assistant", content: [{ type: "text", text: "<promise>COMPLETE</promise>" }] }] }, runtime.context);
  assert.equal(JSON.parse(fs.readFileSync(runtime.statePath)).status, "active");
  const result = await done(runtime, submission({ complete: true }));
  const state = JSON.parse(fs.readFileSync(runtime.statePath));
  assert.match(result.content[0].text, /completed/i);
  assert.equal(state.status, "completed");
  assert.equal(state.iteration, 3);
  assert.equal(state.lastDelivery.iteration, 3);
  assert.equal(state.lastDelivery.completed, true);
  assert.deepEqual(result.details.receipt, state.lastDelivery.receipt);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ralphExtension from "../index.ts";

function makeCtx(cwd, sessionId) {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    hasUI: false,
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
      confirm: async () => false,
      theme: { fg(_name, text) { return text; }, bold(text) { return text; } },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

function makeRuntime() {
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const sentUserMessages = [];
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(message, options) { sentUserMessages.push({ message, options }); },
  };
  ralphExtension(pi);
  return { events, commands, tools, sentUserMessages };
}

function makeLoop(ownerSessionId) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-session-boundary-"));
  fs.mkdirSync(path.join(cwd, ".ralph"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".ralph", "loop.md"), "# Loop\n", "utf8");
  const state = {
    name: "loop",
    taskFile: ".ralph/loop.md",
    iteration: 4,
    maxIterations: 50,
    itemsPerIteration: 1,
    reflectEvery: 0,
    reflectInstructions: "reflect",
    active: true,
    status: "active",
    startedAt: "2026-07-08T11:54:18.989Z",
    lastReflectionAt: 0,
    ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
  };
  const statePath = path.join(cwd, ".ralph", "loop.state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  return { cwd, statePath, state };
}

async function injectedPrompt(runtime, ctx) {
  await runtime.events.get("session_start")({}, ctx);
  return runtime.events.get("before_agent_start")({ systemPrompt: "base prompt" }, ctx);
}

test("legacy, foreign, and missing-session states never auto-bind or change provenance", async () => {
  for (const [owner, sessionId] of [[undefined, "fresh"], ["other", "fresh"], ["owner", undefined]]) {
    const fixture = makeLoop(owner);
    const before = fs.readFileSync(fixture.statePath, "utf8");
    const result = await injectedPrompt(makeRuntime(), makeCtx(fixture.cwd, sessionId));
    assert.equal(result, undefined);
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), before);
  }
});

test("an exact owner rehydrates after reload", async () => {
  const fixture = makeLoop("same-session");
  const result = await injectedPrompt(makeRuntime(), makeCtx(fixture.cwd, "same-session"));
  assert.match(result?.systemPrompt ?? "", /RALPH LOOP - loop - Iteration 4\/50/);
});

test("explicit resume transfers ownership without manufacturing progress", async () => {
  const fixture = makeLoop("other-session");
  const runtime = makeRuntime();
  const ctx = makeCtx(fixture.cwd, "new-owner");
  await runtime.commands.get("ralph").handler("resume loop", ctx);
  const resumed = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  assert.equal(resumed.ownerSessionId, "new-owner");
  assert.equal(resumed.iteration, fixture.state.iteration);
  assert.equal(resumed.startedAt, fixture.state.startedAt);
  assert.equal(runtime.sentUserMessages.length, 1);
});

test("foreign stop and done signals cannot mutate another session's loop", async () => {
  const fixture = makeLoop("other-session");
  const runtime = makeRuntime();
  const ctx = makeCtx(fixture.cwd, "fresh-session");
  await runtime.events.get("session_start")({}, ctx);
  await runtime.commands.get("ralph").handler("stop", ctx);
  await runtime.events.get("agent_end")({ messages: [{ role: "assistant", content: [{ type: "text", text: "<promise>COMPLETE</promise>" }] }] }, ctx);
  const unchanged = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  assert.equal(unchanged.status, "active");
  assert.equal(unchanged.completedAt, undefined);
});

test("the exact owner can stop its loop", async () => {
  const fixture = makeLoop("same-session");
  const runtime = makeRuntime();
  const ctx = makeCtx(fixture.cwd, "same-session");
  await runtime.events.get("session_start")({}, ctx);
  await runtime.commands.get("ralph").handler("stop", ctx);
  const stopped = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  assert.equal(stopped.status, "paused");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import guardianExtension from "./index.ts";

const root = new URL("../", import.meta.url);

test("package manifest registers the guardian source extension exactly once", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { pi?: { extensions?: string[] } };
  const registrations = manifest.pi?.extensions?.filter((path) => path === "./incremental-delivery-guardian/index.ts") ?? [];
  assert.deepEqual(registrations, ["./incremental-delivery-guardian/index.ts"]);
});

test("packaged guardian keeps runtime, documentation, and repository-only test boundaries", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
  const files = (JSON.parse(output) as [{ files: Array<{ path: string }> }])[0].files.map((file) => file.path);
  for (const required of [
    "incremental-delivery-guardian/index.ts",
    "incremental-delivery-guardian/assessment.ts",
    "incremental-delivery-guardian/audit.ts",
    "incremental-delivery-guardian/clock.ts",
    "incremental-delivery-guardian/ledger.ts",
    "incremental-delivery-guardian/scope.ts",
    "incremental-delivery-guardian/README.md",
  ]) assert.ok(files.includes(required), `${required} missing from package`);
  assert.equal(files.some((path) => path.startsWith("incremental-delivery-guardian/") && path.endsWith(".test.ts")), false);
});

test("source extension registers passive hooks without replacement results", async () => {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const listeners = new Map<string, (data: unknown) => void>();
  const pi = {
    events: {
      emit() {},
      on(channel: string, handler: (data: unknown) => void) { listeners.set(channel, handler); return () => listeners.delete(channel); },
    },
    on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); },
  };
  guardianExtension(pi as never);
  const context = { cwd: "/data/repos/example", hasUI: false, ui: { notify() {} } };
  await handlers.get("session_start")!({}, context);
  const input = Object.freeze({ path: "src/a.ts" });
  const toolEvent = { toolCallId: "tool-1", toolName: "read", input };
  assert.equal(handlers.get("tool_call")!(toolEvent, context), undefined);
  assert.equal(toolEvent.input, input);
  assert.equal(handlers.get("user_bash")!({ command: "pwd", cwd: context.cwd }, context), undefined);
});

test("documentation contains one advisory contract and no mutation-mode vocabulary", () => {
  const readme = readFileSync(new URL("incremental-delivery-guardian/README.md", root), "utf8");
  assert.match(readme, /mutationEffect: \"unchanged\"/);
  assert.match(readme, /Reviewer, provider, and audit integrations are not registration prerequisites/);
  assert.doesNotMatch(readme, /\b(?:off|enforce) mode\b|\bobserve mode\b/i);
  assert.doesNotMatch(readme, /tool_call[^\n]*(?:block|rewrite)|user_bash[^\n]*operations replacement/i);
});

import assert from "node:assert/strict";
import test from "node:test";

import { validateDeliveryEvidence, validateProtectedLifecycleEvidence } from "./provider.ts";
import {
  BitbucketEvidenceProvider,
  BitbucketProviderError,
  BitbucketRestClient,
  attemptOptionalBitbucketEvidence,
  type BitbucketReadClient,
} from "./providers.bitbucket.ts";

const pr = {
  id: 12, state: "OPEN", created_on: "2026-07-15T09:00:00Z", updated_on: "2026-07-15T10:00:00Z",
  source: { branch: { name: "feature" }, commit: { hash: "abc123" }, repository: { full_name: "team/repo" } },
  destination: { branch: { name: "main" }, repository: { full_name: "team/repo" } },
  participants: [{ user: { uuid: "reviewer-1" }, approved: true, state: "approved", participated_on: "2026-07-15T09:45:00Z" }],
};
const activity = { values: [{ update: { date: "2026-07-15T09:30:00Z", source: { commit: { hash: "abc123" } } } }] };
const pipelines = { values: [{ created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "abc123" } }, state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } }] };

function fakeClient(overrides: Partial<{ pull: unknown; activity: unknown; pipelines: unknown }> = {}) {
  const calls: string[] = [];
  const client: BitbucketReadClient = { get: async (path) => {
    calls.push(path);
    if (path.includes("/activity")) return Object.hasOwn(overrides, "activity") ? overrides.activity : activity;
    if (path.includes("/pipelines/")) return Object.hasOwn(overrides, "pipelines") ? overrides.pipelines : pipelines;
    return Object.hasOwn(overrides, "pull") ? overrides.pull : pr;
  } };
  return { client, calls };
}

const request = { workspace: "team", repo: "repo", pullRequestNumber: 12, observedAt: "2026-07-15T10:05:00Z" } as const;
const claim = {
  repositoryId: "team/repo", pullRequestNumber: 12, branch: "feature", headSha: "abc123", baseRef: "main",
  observedAt: "2026-07-15T10:05:00Z", maxAgeMs: 10 * 60_000,
  local: { commitSha: "abc123", branch: "feature", pushed: true, verificationId: "verify-bb", verificationCompletedAt: "2026-07-15T10:04:00Z" },
} as const;

test("Bitbucket provider reads exact PR, head activity, and pipeline through bounded official REST paths", async () => {
  const { client, calls } = fakeClient();
  const evidence = await new BitbucketEvidenceProvider(client).read(request);
  assert.deepEqual(evidence, {
    provider: "bitbucket", repositoryId: "team/repo", pullRequestNumber: 12,
    state: "open", merged: false, updatedAt: "2026-07-15T10:00:00Z", observedAt: "2026-07-15T10:05:00Z",
    headRef: "feature", headSha: "abc123", headRepositoryId: "team/repo",
    baseRef: "main", baseRepositoryId: "team/repo", ciState: "success", reviewState: "approved",
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "/repositories/team/repo/pullrequests/12");
  assert.equal(calls[1], "/repositories/team/repo/pullrequests/12/activity?pagelen=100");
  assert.match(calls[2]!, /^\/repositories\/team\/repo\/pipelines\/\?pagelen=100&sort=-created_on&q=/);
  assert.equal(validateDeliveryEvidence(claim, evidence).provider, "bitbucket");
  assert.equal(validateProtectedLifecycleEvidence(claim, evidence).provider, "bitbucket");
  const merged = await new BitbucketEvidenceProvider(fakeClient({ pull: { ...pr, state: "MERGED" } }).client).read(request);
  assert.equal(merged.state, "closed");
  assert.equal(merged.merged, true);
  const declined = await new BitbucketEvidenceProvider(fakeClient({ pull: { ...pr, state: "DECLINED" } }).client).read(request);
  assert.equal(declined.state, "closed");
  assert.equal(declined.merged, false);
});

test("review state is bound to the latest exact-head update and current participant state", async () => {
  const stale = fakeClient({ pull: { ...pr, participants: [{ user: { uuid: "r" }, approved: true, state: "approved", participated_on: "2026-07-15T09:20:00Z" }] } });
  assert.equal((await new BitbucketEvidenceProvider(stale.client).read(request)).reviewState, "pending");
  const staleOffset = fakeClient({ pull: { ...pr, participants: [{ user: { uuid: "r" }, approved: true, state: "approved", participated_on: "2026-07-15T10:00:00+01:00" }] } });
  assert.equal((await new BitbucketEvidenceProvider(staleOffset.client).read(request)).reviewState, "pending");
  const changes = fakeClient({ pull: { ...pr, participants: [{ user: { uuid: "r" }, approved: false, state: "changes_requested", participated_on: "2026-07-15T09:45:00Z" }] } });
  assert.equal((await new BitbucketEvidenceProvider(changes.client).read(request)).reviewState, "changes_requested");
  const oldHeadUpdate = fakeClient({ activity: { values: [
    { comment: { id: 1 } },
    { update: { date: "2026-07-15T09:55:00Z", source: { commit: { hash: "old" } } } },
    { update: { date: "2026-07-15T09:30:00Z", source: { commit: { hash: "abc123" } } } },
  ] } });
  assert.equal((await new BitbucketEvidenceProvider(oldHeadUpdate.client).read(request)).reviewState, "approved");
  const latestExactUpdate = fakeClient({ activity: { values: [
    { update: { date: "2026-07-15T09:50:00Z", source: { commit: { hash: "abc123" } } } },
    { update: { date: "2026-07-15T09:40:00Z", source: { commit: { hash: "abc123" } } } },
  ] } });
  assert.equal((await new BitbucketEvidenceProvider(latestExactUpdate.client).read(request)).reviewState, "pending");
  const exactBoundary = fakeClient({ pull: { ...pr, participants: [{ user: { uuid: "r" }, approved: true, state: "approved", participated_on: "2026-07-15T09:30:00Z" }] } });
  assert.equal((await new BitbucketEvidenceProvider(exactBoundary.client).read(request)).reviewState, "approved");
  for (const participant of [
    { user: { uuid: "r" }, approved: false, state: "approved", participated_on: "2026-07-15T09:45:00Z" },
    { user: { uuid: "r" }, approved: true, state: "participated", participated_on: "2026-07-15T09:45:00Z" },
  ]) {
    const notApproved = fakeClient({ pull: { ...pr, participants: [participant] } });
    assert.equal((await new BitbucketEvidenceProvider(notApproved.client).read(request)).reviewState, "pending");
  }
});

test("pipeline result is exact-head, latest-first, and explicit", async () => {
  const cases = [
    [{ values: [] }, "unknown"],
    [{ values: [{ created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "abc123" } }, state: { name: "IN_PROGRESS", result: null } }] }, "pending"],
    [{ values: [{ created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "abc123" } }, state: { name: "PENDING", result: null } }] }, "pending"],
    [{ values: [{ created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "abc123" } }, state: { name: "PAUSED", result: { name: "SUCCESSFUL" } } }] }, "unknown"],
    [{ values: [{ created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "abc123" } }, state: { name: "COMPLETED", result: null } }] }, "unknown"],
    [{ values: [{ created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "abc123" } }, state: { name: "COMPLETED" } }] }, "unknown"],
    [{ values: [{ created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "abc123" } }, state: { name: "COMPLETED", result: { name: "CANCELLED" } } }] }, "unknown"],
    [{ values: [{ created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "abc123" } }, state: { name: "COMPLETED", result: { name: "FAILED" } } }] }, "failure"],
    [{ values: [
      { created_on: "2026-07-15T09:40:00Z", target: { commit: { hash: "abc123" } }, state: { name: "COMPLETED", result: { name: "FAILED" } } },
      { created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "abc123" } }, state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } },
    ] }, "success"],
    [{ values: [
      { created_on: "2026-07-15T10:00:00+01:00", target: { commit: { hash: "abc123" } }, state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } },
      { created_on: "2026-07-15T09:30:00Z", target: { commit: { hash: "abc123" } }, state: { name: "COMPLETED", result: { name: "FAILED" } } },
    ] }, "failure"],
  ] as const;
  for (const [response, expected] of cases) {
    const { client } = fakeClient({ pipelines: response });
    assert.equal((await new BitbucketEvidenceProvider(client).read(request)).ciState, expected);
  }
  const wrongHead = fakeClient({ pipelines: { values: [{ created_on: "2026-07-15T09:50:00Z", target: { commit: { hash: "other" } }, state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } }] } });
  await assert.rejects(() => new BitbucketEvidenceProvider(wrongHead.client).read(request), (error: unknown) => error instanceof BitbucketProviderError && error.code === "incomplete_evidence");
});

test("pagination, malformed payloads, and transport failure reject evidence", async () => {
  for (const overrides of [
    { activity: { ...activity, next: "next-page" } },
    { pipelines: { ...pipelines, next: "next-page" } },
    { pull: null },
    { pull: [] },
    { pull: 123 },
    { pull: { ...pr, source: null } },
    { pull: { ...pr, source: { ...pr.source, commit: { hash: 123 } } } },
    { pull: { ...pr, source: { ...pr.source, commit: { hash: "" } } } },
    { pull: { ...pr, source: { ...pr.source, repository: { full_name: 123 } } } },
    { pull: { ...pr, source: { ...pr.source, repository: { full_name: "" } } } },
    { pull: { ...pr, participants: {} } },
    { pull: { ...pr, updated_on: "invalid" } },
  ]) await assert.rejects(() => new BitbucketEvidenceProvider(fakeClient(overrides).client).read(request), (error: unknown) => error instanceof BitbucketProviderError && error.code === "incomplete_evidence");
  assert.equal((await new BitbucketEvidenceProvider(fakeClient({ activity: { ...activity, next: "" } }).client).read(request)).headSha, "abc123");
  for (const invalidRequest of [
    { ...request, workspace: "" },
    { ...request, repo: "" },
    { ...request, pullRequestNumber: 0 },
    { ...request, pullRequestNumber: 1.5 },
    { ...request, observedAt: "2026-02-31T10:05:00Z" },
  ]) await assert.rejects(() => new BitbucketEvidenceProvider(fakeClient().client).read(invalidRequest), (error: unknown) => error instanceof BitbucketProviderError && error.code === "invalid_request");
  for (const invalidPull of [
    { ...pr, id: 13 },
    { ...pr, state: "UNKNOWN" },
  ]) await assert.rejects(() => new BitbucketEvidenceProvider(fakeClient({ pull: invalidPull }).client).read(request), (error: unknown) => error instanceof BitbucketProviderError && error.code === "incomplete_evidence");
  const providerCause = new Error("offline token=secret");
  const failing: BitbucketReadClient = { get: async () => { throw providerCause; } };
  await assert.rejects(() => new BitbucketEvidenceProvider(failing).read(request), (error: unknown) => error instanceof BitbucketProviderError && error.code === "provider_unavailable" && error.cause === providerCause && !error.message.includes("secret"));
});

test("optional failure remains visible and mutation-invariant", async () => {
  const mutation = Object.freeze({ operation: "edit", exitCode: 0 });
  const failing: BitbucketReadClient = { get: async () => { throw new Error("offline"); } };
  const result = await attemptOptionalBitbucketEvidence(new BitbucketEvidenceProvider(failing), request, mutation);
  assert.equal(result.status, "provider_unavailable");
  assert.equal(result.mutationEffect, "unchanged");
  assert.equal(result.mutation, mutation);
});

test("REST client uses bearer auth, GET only, timeout signal, and no retry fallback", async () => {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init: init! });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new BitbucketRestClient("token", 5_000, fetcher);
  assert.deepEqual(await client.get("/repositories/team/repo/pullrequests/12"), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input, "https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests/12");
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), "Bearer token");
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
  assert.throws(() => new BitbucketRestClient("", 5_000, fetcher));
  assert.throws(() => new BitbucketRestClient("token", 0, fetcher));
  assert.throws(() => new BitbucketRestClient("token", 5_000, null as never));
  await assert.rejects(() => client.get("https://evil.example/steal"), (error: unknown) => error instanceof BitbucketProviderError && error.code === "invalid_request");
  await assert.rejects(() => client.get("//evil.example/steal"), (error: unknown) => error instanceof BitbucketProviderError && error.code === "invalid_request");
  const networkError = new Error("network down");
  const unavailable = new BitbucketRestClient("token", 5_000, async () => { throw networkError; });
  await assert.rejects(() => unavailable.get("/repositories/team/repo"), (error: unknown) => error instanceof BitbucketProviderError && error.code === "provider_unavailable" && error.cause === networkError);
  const rejected = new BitbucketRestClient("token", 5_000, async () => new Response("denied", { status: 403 }));
  await assert.rejects(() => rejected.get("/repositories/team/repo"), (error: unknown) => error instanceof BitbucketProviderError && error.code === "provider_unavailable" && error.message.includes("403"));
  const invalidJson = new BitbucketRestClient("token", 5_000, async () => new Response("not-json", { status: 200 }));
  await assert.rejects(() => invalidJson.get("/repositories/team/repo"), (error: unknown) => error instanceof BitbucketProviderError && error.code === "incomplete_evidence" && error.cause instanceof SyntaxError);
});

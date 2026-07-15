import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  GitHubEvidenceProvider,
  ProviderEvidenceError,
  attemptOptionalGitHubEvidence,
  createGitHubOctokitOptions,
  validateDeliveryEvidence,
  validateProtectedLifecycleEvidence,
  type GitHubReadClient,
  type GitHubPullRequestEvidence,
} from "./provider.ts";

function fakeClient(overrides: Partial<{
  pull: Awaited<ReturnType<GitHubReadClient["pulls"]["get"]>>;
  checks: Awaited<ReturnType<GitHubReadClient["checks"]["listForRef"]>>;
  reviews: Awaited<ReturnType<GitHubReadClient["pulls"]["listReviews"]>>;
}> = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const client: GitHubReadClient = {
    pulls: {
      get: async (input) => {
        calls.push({ method: "pulls.get", input });
        return overrides.pull ?? {
          data: {
            state: "open",
            merged: false,
            updated_at: "2026-07-15T10:00:00Z",
            head: { ref: "feature", sha: "abc123", repo: { full_name: "owner/repo" } },
            base: { ref: "main", repo: { full_name: "owner/repo" } },
          },
          headers: {},
        };
      },
      listReviews: async (input) => {
        calls.push({ method: "pulls.listReviews", input });
        return overrides.reviews ?? {
          data: [
            { user: { id: 1 }, state: "CHANGES_REQUESTED", submitted_at: "2026-07-15T09:00:00Z" },
            { user: { id: 1 }, state: "APPROVED", submitted_at: "2026-07-15T09:30:00Z" },
          ],
          headers: {},
        };
      },
    },
    checks: {
      listForRef: async (input) => {
        calls.push({ method: "checks.listForRef", input });
        return overrides.checks ?? {
          data: { check_runs: [{ status: "completed", conclusion: "success" }] },
          headers: {},
        };
      },
    },
  };
  return { client, calls };
}

function claim() {
  return {
    repositoryId: "owner/repo",
    pullRequestNumber: 5,
    branch: "feature",
    headSha: "abc123",
    baseRef: "main",
    observedAt: "2026-07-15T10:05:00Z",
    maxAgeMs: 10 * 60 * 1_000,
    local: {
      commitSha: "abc123",
      branch: "feature",
      pushed: true,
      verificationId: "verify-1",
      verificationCompletedAt: "2026-07-15T10:04:00Z",
    },
  } as const;
}

function expectEvidenceError(action: () => unknown, code: ProviderEvidenceError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProviderEvidenceError);
    assert.equal(error.code, code);
    return true;
  });
}

test("GitHub adapter reads exact PR, check, and latest-review evidence without pagination gaps", async () => {
  const { client, calls } = fakeClient();
  const provider = new GitHubEvidenceProvider(client);
  const evidence = await provider.read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" });

  assert.deepEqual(evidence, {
    provider: "github",
    repositoryId: "owner/repo",
    pullRequestNumber: 5,
    state: "open",
    merged: false,
    updatedAt: "2026-07-15T10:00:00Z",
    observedAt: "2026-07-15T10:05:00Z",
    headRef: "feature",
    headSha: "abc123",
    headRepositoryId: "owner/repo",
    baseRef: "main",
    baseRepositoryId: "owner/repo",
    ciState: "success",
    reviewState: "approved",
  });
  assert.deepEqual(calls, [
    { method: "pulls.get", input: { owner: "owner", repo: "repo", pull_number: 5 } },
    { method: "checks.listForRef", input: { owner: "owner", repo: "repo", ref: "abc123", per_page: 100 } },
    { method: "pulls.listReviews", input: { owner: "owner", repo: "repo", pull_number: 5, per_page: 100 } },
  ]);
});

test("delivery receipt accepts pending CI but requires commit, push, verification, open PR, and exact head/base", () => {
  const evidence: GitHubPullRequestEvidence = {
    provider: "github",
    repositoryId: "owner/repo",
    pullRequestNumber: 5,
    state: "open",
    merged: false,
    updatedAt: "2026-07-15T10:00:00Z",
    observedAt: "2026-07-15T10:05:00Z",
    headRef: "feature",
    headSha: "abc123",
    headRepositoryId: "owner/repo",
    baseRef: "main",
    baseRepositoryId: "owner/repo",
    ciState: "pending",
    reviewState: "pending",
  };
  const receipt = validateDeliveryEvidence(claim(), evidence);
  assert.equal(receipt.ciState, "pending");
  assert.equal(receipt.reviewState, "pending");
  assert.equal(receipt.localVerificationId, "verify-1");

  for (const changed of [
    { ...claim(), pullRequestNumber: 6 },
    { ...claim(), branch: "other" },
    { ...claim(), headSha: "changed" },
    { ...claim(), baseRef: "develop" },
    { ...claim(), local: { ...claim().local, commitSha: "changed" } },
    { ...claim(), local: { ...claim().local, branch: "other" } },
    { ...claim(), local: { ...claim().local, pushed: false } },
    { ...claim(), local: { ...claim().local, verificationId: "   " } },
    { ...claim(), local: { ...claim().local, verificationCompletedAt: "2026-07-15T10:05:01Z" } },
  ]) expectEvidenceError(() => validateDeliveryEvidence(changed, evidence), "claim_mismatch");
  for (const changedEvidence of [
    { ...evidence, repositoryId: "other/repo" },
    { ...evidence, headRepositoryId: "other/repo" },
    { ...evidence, baseRepositoryId: "other/repo" },
    { ...evidence, headRef: "other" },
    { ...evidence, headSha: "changed" },
  ]) expectEvidenceError(() => validateDeliveryEvidence(claim(), changedEvidence), "claim_mismatch");
  expectEvidenceError(() => validateDeliveryEvidence({ ...claim(), observedAt: "2026-07-15T10:20:01Z" }, evidence), "stale_evidence");
  expectEvidenceError(() => validateDeliveryEvidence(claim(), { ...evidence, observedAt: "2026-07-15T10:05:01Z" }), "stale_evidence");
  assert.doesNotThrow(() => validateDeliveryEvidence({ ...claim(), observedAt: "2026-07-15T10:15:00Z" }, evidence));
  assert.doesNotThrow(() => validateDeliveryEvidence({ ...claim(), local: { ...claim().local, verificationCompletedAt: claim().observedAt } }, evidence));
  for (const invalid of [
    { ...claim(), maxAgeMs: 0 },
    { ...claim(), maxAgeMs: 1.5 },
    { ...claim(), observedAt: "invalid" },
    { ...claim(), local: { ...claim().local, verificationCompletedAt: "invalid" } },
  ]) expectEvidenceError(() => validateDeliveryEvidence(invalid, evidence), "invalid_request");
  expectEvidenceError(() => validateDeliveryEvidence(claim(), { ...evidence, state: "closed" }), "pull_request_not_open");
});

test("protected lifecycle requires successful CI and current approval", () => {
  const base = validateDeliveryEvidence(claim(), {
    provider: "github", repositoryId: "owner/repo", pullRequestNumber: 5,
    state: "open", merged: false, updatedAt: "2026-07-15T10:00:00Z", observedAt: "2026-07-15T10:05:00Z",
    headRef: "feature", headSha: "abc123", headRepositoryId: "owner/repo",
    baseRef: "main", baseRepositoryId: "owner/repo", ciState: "success", reviewState: "approved",
  });
  assert.deepEqual(validateProtectedLifecycleEvidence(base), base);
  expectEvidenceError(() => validateProtectedLifecycleEvidence({ ...base, headSha: "tampered" }), "receipt_invalid");
  expectEvidenceError(() => validateProtectedLifecycleEvidence({ ...base, receiptHash: "0".repeat(64) }), "receipt_invalid");
  const versionCore = { ...base, schemaVersion: 2 as const };
  const { receiptHash: ignored, ...withoutHash } = versionCore;
  const versionReceipt = { ...versionCore, receiptHash: createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex") };
  expectEvidenceError(() => validateProtectedLifecycleEvidence(versionReceipt as never), "receipt_invalid");
  expectEvidenceError(() => validateProtectedLifecycleEvidence({ ...base, ciState: "failure" }), "receipt_invalid");
  const pendingCi = validateDeliveryEvidence(claim(), { ...base, observedAt: base.providerObservedAt, state: "open", merged: false, headRef: base.branch, headRepositoryId: base.repositoryId, baseRepositoryId: base.repositoryId, updatedAt: "2026-07-15T10:00:00Z", ciState: "pending" });
  expectEvidenceError(() => validateProtectedLifecycleEvidence(pendingCi), "ci_not_successful");
  const changesRequested = validateDeliveryEvidence(claim(), { ...base, observedAt: base.providerObservedAt, state: "open", merged: false, headRef: base.branch, headRepositoryId: base.repositoryId, baseRepositoryId: base.repositoryId, updatedAt: "2026-07-15T10:00:00Z", reviewState: "changes_requested" });
  expectEvidenceError(() => validateProtectedLifecycleEvidence(changesRequested), "review_not_approved");
  const pendingReview = validateDeliveryEvidence(claim(), { ...base, observedAt: base.providerObservedAt, state: "open", merged: false, headRef: base.branch, headRepositoryId: base.repositoryId, baseRepositoryId: base.repositoryId, updatedAt: "2026-07-15T10:00:00Z", reviewState: "pending" });
  expectEvidenceError(() => validateProtectedLifecycleEvidence(pendingReview), "review_not_approved");
});

test("provider derives pending, failure, unknown, and latest-review states", async () => {
  const cases = [
    [{ data: { check_runs: [] }, headers: {} }, "unknown"],
    [{ data: { check_runs: [{ status: "queued", conclusion: null }] }, headers: {} }, "pending"],
    [{ data: { check_runs: [{ status: "queued", conclusion: "failure" }] }, headers: {} }, "pending"],
    [{ data: { check_runs: [{ status: "completed", conclusion: "failure" }] }, headers: {} }, "failure"],
    [{ data: { check_runs: [{ status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "success" }] }, headers: {} }, "failure"],
    [{ data: { check_runs: [{ status: "queued", conclusion: null }, { status: "completed", conclusion: "failure" }] }, headers: {} }, "failure"],
    [{ data: { check_runs: [{ status: "queued", conclusion: null }, { status: "completed", conclusion: "success" }] }, headers: {} }, "pending"],
    [{ data: { check_runs: [{ status: "completed", conclusion: null }] }, headers: {} }, "unknown"],
    [{ data: { check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: null }] }, headers: {} }, "unknown"],
    [{ data: { check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "neutral" }] }, headers: {} }, "success"],
  ] as const;
  for (const [checks, expected] of cases) {
    const { client } = fakeClient({ checks });
    assert.equal((await new GitHubEvidenceProvider(client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" })).ciState, expected);
  }
  const changed = fakeClient({ reviews: { data: [
    { user: { id: 1 }, state: "APPROVED", submitted_at: "2026-07-15T09:00:00Z" },
    { user: { id: 1 }, state: "CHANGES_REQUESTED", submitted_at: "2026-07-15T09:30:00Z" },
  ], headers: {} } });
  assert.equal((await new GitHubEvidenceProvider(changed.client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" })).reviewState, "changes_requested");
  const none = fakeClient({ reviews: { data: [], headers: {} } });
  assert.equal((await new GitHubEvidenceProvider(none.client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" })).reviewState, "pending");
  const outOfOrder = fakeClient({ reviews: { data: [
    { user: { id: 1 }, state: "APPROVED", submitted_at: "2026-07-15T09:30:00Z" },
    { user: { id: 1 }, state: "CHANGES_REQUESTED", submitted_at: "2026-07-15T09:00:00Z" },
  ], headers: {} } });
  assert.equal((await new GitHubEvidenceProvider(outOfOrder.client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" })).reviewState, "approved");
  for (const reviews of [
    [{ user: null, state: "APPROVED", submitted_at: "2026-07-15T09:00:00Z" }],
    [{ user: { id: 1 }, state: "APPROVED", submitted_at: null }],
    [{ user: { id: 1 }, state: "APPROVED", submitted_at: "invalid" }],
  ]) {
    const invalid = fakeClient({ reviews: { data: reviews, headers: {} } });
    await assert.rejects(() => new GitHubEvidenceProvider(invalid.client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" }), (error: unknown) => error instanceof ProviderEvidenceError && error.code === "incomplete_evidence");
  }
});

test("provider truncation and request failures are typed with no retry fallback", async () => {
  const truncated = fakeClient({
    checks: { data: { check_runs: [] }, headers: { link: '<next>; rel="next"' } },
  });
  await assert.rejects(
    () => new GitHubEvidenceProvider(truncated.client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" }),
    (error: unknown) => error instanceof ProviderEvidenceError && error.code === "incomplete_evidence",
  );

  await assert.rejects(
    () => new GitHubEvidenceProvider(fakeClient().client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-02-31T10:05:00Z" }),
    (error: unknown) => error instanceof ProviderEvidenceError && error.code === "invalid_request",
  );

  for (const invalidRequest of [
    { owner: "", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" },
    { owner: "owner", repo: "", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" },
    { owner: "owner", repo: "repo", pullRequestNumber: 0, observedAt: "2026-07-15T10:05:00Z" },
    { owner: "owner", repo: "repo", pullRequestNumber: 1.5, observedAt: "2026-07-15T10:05:00Z" },
  ]) await assert.rejects(() => new GitHubEvidenceProvider(fakeClient().client).read(invalidRequest), (error: unknown) => error instanceof ProviderEvidenceError && error.code === "invalid_request");

  const missingHead = fakeClient({ pull: { data: { state: "open", merged: false, updated_at: "2026-07-15T10:00:00Z", head: { ref: "feature", sha: "abc123", repo: null }, base: { ref: "main", repo: { full_name: "owner/repo" } } }, headers: {} } });
  await assert.rejects(() => new GitHubEvidenceProvider(missingHead.client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" }), (error: unknown) => error instanceof ProviderEvidenceError && error.code === "incomplete_evidence");
  const invalidUpdated = fakeClient({ pull: { data: { state: "open", merged: false, updated_at: "invalid", head: { ref: "feature", sha: "abc123", repo: { full_name: "owner/repo" } }, base: { ref: "main", repo: { full_name: "owner/repo" } } }, headers: {} } });
  await assert.rejects(() => new GitHubEvidenceProvider(invalidUpdated.client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" }), (error: unknown) => error instanceof ProviderEvidenceError && error.code === "incomplete_evidence");
  const closed = fakeClient({ pull: { data: { state: "closed", merged: false, updated_at: "2026-07-15T10:00:00Z", head: { ref: "feature", sha: "abc123", repo: { full_name: "owner/repo" } }, base: { ref: "main", repo: { full_name: "owner/repo" } } }, headers: {} } });
  assert.equal((await new GitHubEvidenceProvider(closed.client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" })).state, "closed");
  assert.throws(() => GitHubEvidenceProvider.authenticated("", 5_000));

  const failing = fakeClient();
  failing.client.pulls.get = async () => { throw new Error("network unavailable"); };
  await assert.rejects(
    () => new GitHubEvidenceProvider(failing.client).read({ owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" }),
    (error: unknown) => error instanceof ProviderEvidenceError && error.code === "provider_unavailable" && error.cause instanceof Error,
  );
});

test("optional provider context failure is visible and mutation-invariant", async () => {
  const { client } = fakeClient();
  client.pulls.get = async () => { throw new Error("offline"); };
  const mutation = Object.freeze({ operation: "edit", count: 1, exitCode: 0 });
  const result = await attemptOptionalGitHubEvidence(
    new GitHubEvidenceProvider(client),
    { owner: "owner", repo: "repo", pullRequestNumber: 5, observedAt: "2026-07-15T10:05:00Z" },
    mutation,
  );
  assert.equal(result.status, "provider_unavailable");
  assert.equal(result.mutationEffect, "unchanged");
  assert.equal(result.mutation, mutation);
});

test("Octokit options disable retries and require a finite timeout", () => {
  assert.deepEqual(createGitHubOctokitOptions("token", 5_000), {
    auth: "token",
    retry: { enabled: false },
    request: { timeout: 5_000 },
  });
  assert.throws(() => createGitHubOctokitOptions("", 5_000));
  assert.throws(() => createGitHubOctokitOptions("token", 0));
});

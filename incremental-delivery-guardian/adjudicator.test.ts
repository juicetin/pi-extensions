import assert from "node:assert/strict";
import test from "node:test";
import { requestFreshAdvisoryReview } from "./adjudicator.ts";

const mutation = { operation: "write", input: { path: "src/a.ts" }, result: { changed: true } };
const request = { reviewId: "review-1", proposalId: "proposal-1", reasonCodes: ["scope_immediate_expansion"], summary: "Assess whether to split this delivery slice.", timeoutMs: 25, maxTurns: 2, now: "2026-07-15T15:40:00Z" };

function launcher(result: unknown) {
  return async (input: unknown) => {
    assert.deepEqual(input, { proposalId: "proposal-1", reasonCodes: ["scope_immediate_expansion"], summary: request.summary, readOnly: true, fresh: true, maxTurns: 2 });
    return result;
  };
}

test("supported fresh read-only reviewer returns a canonical recommendation without mutation authority", async () => {
  const notices: unknown[] = [];
  const result = await requestFreshAdvisoryReview({ request, mutation, launch: launcher({ sessionId: "session-1", recommendation: "split_slice" }), notify: async (record) => { notices.push(record); } });
  assert.equal(result.status, "review_completed");
  assert.equal(result.mutation, mutation);
  assert.equal(result.mutationEffect, "unchanged");
  assert.deepEqual(result.record, { schemaVersion: 1, policyVersion: 1, reviewId: "review-1", proposalId: "proposal-1", reasonCodes: ["scope_immediate_expansion"], reviewer: { sessionId: "session-1", fresh: true, readOnly: true }, createdAt: request.now, status: "completed", recommendation: "split_slice" });
  assert.deepEqual(notices, [result.record]);
  assert.equal("authorization" in result, false);
});

for (const recommendation of ["continue", "split_slice", "defer", "replan"] as const) {
  test(`accepts canonical ${recommendation} advice`, async () => {
    const result = await requestFreshAdvisoryReview({ request, mutation, launch: launcher({ sessionId: "session-1", recommendation }), notify: async () => {} });
    assert.equal(result.status, "review_completed");
    if (result.record.status !== "completed") assert.fail("completed adapter result must contain completed review record");
    assert.equal(result.record.recommendation, recommendation);
  });
}

test("launcher absence is visibly unavailable and mutation-invariant", async () => {
  const result = await requestFreshAdvisoryReview({ request, mutation, notify: async () => {} });
  assert.deepEqual(result, { status: "review_unavailable", reason: "launcher_absent", mutation, mutationEffect: "unchanged" });
});

for (const [name, launch, reason] of [
  ["no answer", launcher(null), "no_answer"],
  ["undefined answer", launcher(undefined), "no_answer"],
  ["malformed output", launcher({ sessionId: "session-1", recommendation: "allow" }), "malformed_output"],
  ["missing session", launcher({ recommendation: "continue" }), "malformed_output"],
  ["launcher failure", async () => { throw new Error("offline"); }, "launcher_failed"],
] as const) {
  test(`${name} returns review_unavailable without changing mutation`, async () => {
    const result = await requestFreshAdvisoryReview({ request, mutation, launch, notify: async () => {} });
    assert.equal(result.status, "review_unavailable"); assert.equal(result.reason, reason); assert.equal(result.mutation, mutation); assert.equal(result.mutationEffect, "unchanged");
  });
}

test("timeout is enforced and returns review_unavailable", async () => {
  const result = await requestFreshAdvisoryReview({ request: { ...request, timeoutMs: 1 }, mutation, launch: async () => await new Promise(() => {}), notify: async () => {} });
  assert.equal(result.status, "review_unavailable"); assert.equal(result.reason, "timeout"); assert.equal(result.mutation, mutation);
});

test("notification failure returns review_unavailable without changing mutation", async () => {
  const result = await requestFreshAdvisoryReview({ request, mutation, launch: launcher({ sessionId: "session-1", recommendation: "continue" }), notify: async () => { throw new Error("offline"); } });
  assert.equal(result.status, "review_unavailable"); assert.equal(result.reason, "notification_failed"); assert.equal(result.mutation, mutation); assert.equal(result.mutationEffect, "unchanged");
});

test("strict request validation rejects malformed, unbounded, duplicate, or authority-bearing fields", async () => {
  const invalid = [
    { ...request, reviewId: "" },
    { ...request, proposalId: "" },
    { ...request, reasonCodes: [] },
    { ...request, reasonCodes: [""] },
    { ...request, reasonCodes: ["duplicate", "duplicate"] },
    { ...request, summary: "" },
    { ...request, summary: "x".repeat(8_193) },
    { ...request, timeoutMs: 0 },
    { ...request, timeoutMs: 120_001 },
    { ...request, maxTurns: 0 },
    { ...request, maxTurns: 9 },
    { ...request, now: "not-a-time" },
    { ...request, authorization: "allow" },
  ];
  for (const candidate of invalid) {
    await assert.rejects(() => requestFreshAdvisoryReview({ request: candidate as never, mutation, launch: launcher(null), notify: async () => {} }), /fresh_review_request_invalid/);
  }
});

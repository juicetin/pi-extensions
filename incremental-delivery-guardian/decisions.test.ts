import assert from "node:assert/strict";
import test from "node:test";

import {
  GuardianDecisionContractError,
  SensitiveActionAuthorizationError,
  validateSensitiveActionAuthorization,
  decodeAdvisoryReviewRecord,
  decodeDormantFlagLifecycle,
  type SensitiveActionAuthorization,
} from "./decisions.ts";

const review = {
  schemaVersion: 1,
  policyVersion: 1,
  reviewId: "review-1",
  proposalId: "proposal-1",
  status: "completed",
  recommendation: "split_slice",
  reasonCodes: ["scope_architecture_change"],
  reviewer: { sessionId: "fresh-session", fresh: true, readOnly: true },
  createdAt: "2026-07-15T10:00:00Z",
} as const;

const flag = {
  schemaVersion: 1,
  policyVersion: 1,
  flagId: "guardian-advisory-ui",
  owner: "platform-team",
  defaultState: "off",
  activationCriteria: ["canary passes", "owner approves"],
  rollbackPlan: "Disable the flag and restore the prior package version.",
  dependencyIds: ["piext-vr5"],
  removalCondition: "Remove after two stable releases.",
  verificationPlan: "Run canary and parity tests before activation.",
} as const;

const authorization: SensitiveActionAuthorization = {
  schemaVersion: 1,
  policyVersion: 1,
  authorizationId: "authorization-1",
  actor: {
    actorId: "operator-1",
    authenticatedPrincipalId: "principal-1",
    channel: "harness_web",
  },
  resource: {
    type: "pull_request",
    repositoryId: "juicetin/pi-extensions",
    resourceId: "5",
    immutableTarget: "6fdd846332f9985c3baac1784419e0d33b41701b",
  },
  operation: "merge",
  riskClass: "security",
  issuedAt: "2026-07-15T10:00:00Z",
  expiresAt: "2026-07-15T11:00:00Z",
  rationale: "Reviewed high-risk merge.",
  auditEventId: "event-1",
  oneUseNonce: "nonce-1",
};

const request = {
  resource: authorization.resource,
  operation: authorization.operation,
  riskClass: authorization.riskClass,
  now: "2026-07-15T10:30:00Z",
  consumedAuthorizationIds: [] as string[],
  consumedNonces: [] as string[],
};

function expectAuthorizationError(action: () => unknown, code: SensitiveActionAuthorizationError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SensitiveActionAuthorizationError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    return true;
  });
}

function expectDecisionError(action: () => unknown, code: GuardianDecisionContractError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof GuardianDecisionContractError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    return true;
  });
}

test("advisory review records are strict advice without mutation authority", () => {
  const decoded = decodeAdvisoryReviewRecord(review);
  assert.deepEqual(decoded, review);
  assert.notEqual(decoded, review);

  assert.throws(() => decodeAdvisoryReviewRecord({ ...review, authorized: true }));
  assert.throws(() => decodeAdvisoryReviewRecord({ ...review, addedBudgetMs: 10 }));
  assert.throws(() => decodeAdvisoryReviewRecord({ ...review, paths: ["src"] }));
  assert.throws(() => decodeAdvisoryReviewRecord({ ...review, reviewer: { ...review.reviewer, readOnly: false } }));
  assert.throws(() => decodeAdvisoryReviewRecord({ ...review, recommendation: "authorize_expansion" }));
  assert.throws(() => decodeAdvisoryReviewRecord({ ...review, reasonCodes: ["same", "same"] }));
  assert.throws(() => decodeAdvisoryReviewRecord({ ...review, createdAt: "tomorrow" }));
  assert.throws(
    () => decodeAdvisoryReviewRecord({ ...review, createdAt: "2026-02-31T00:00:00Z" }),
    (error: unknown) => {
      assert.ok(error instanceof GuardianDecisionContractError);
      assert.deepEqual(error.details, ["createdAt"]);
      return true;
    },
  );
  assert.doesNotThrow(() => decodeAdvisoryReviewRecord({ ...review, createdAt: "2028-02-29T00:00:00Z" }));

  for (const recommendation of ["continue", "split_slice", "defer", "replan"] as const) {
    const variant = decodeAdvisoryReviewRecord({ ...review, recommendation });
    assert.equal(variant.status, "completed");
    if (variant.status === "completed") assert.equal(variant.recommendation, recommendation);
  }
});

test("unavailable review records remain visible without a recommendation", () => {
  const unavailable = decodeAdvisoryReviewRecord({
    schemaVersion: 1,
    policyVersion: 1,
    reviewId: "review-2",
    proposalId: "proposal-2",
    status: "unavailable",
    reasonCodes: ["review_unavailable"],
    reviewer: { sessionId: "launch-attempt-1", fresh: true, readOnly: true },
    createdAt: "2026-07-15T10:00:00Z",
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal("recommendation" in unavailable, false);
});

test("dormant flags require complete default-off lifecycle metadata", () => {
  const decoded = decodeDormantFlagLifecycle(flag);
  assert.deepEqual(decoded, flag);
  assert.notEqual(decoded, flag);

  for (const invalid of [
    { ...flag, defaultState: "on" },
    { ...flag, owner: "" },
    { ...flag, activationCriteria: [] },
    { ...flag, rollbackPlan: "" },
    { ...flag, dependencyIds: [] },
    { ...flag, removalCondition: "" },
    { ...flag, verificationPlan: "" },
    { ...flag, activationAuthorized: true },
  ]) assert.throws(() => decodeDormantFlagLifecycle(invalid));
});

test("exact actor-bound sensitive authorization emits one consumption record", () => {
  const result = validateSensitiveActionAuthorization(authorization, request);
  assert.equal(result.validated, true);
  assert.equal(result.effect, "requires_atomic_consumption_before_action");
  assert.deepEqual(result.consumption, {
    authorizationId: "authorization-1",
    oneUseNonce: "nonce-1",
    actorId: "operator-1",
    auditEventId: "event-1",
    resource: authorization.resource,
    operation: "merge",
    consumedAt: request.now,
  });
  assert.notEqual(result.consumption.resource, authorization.resource);

  const activation = {
    ...authorization,
    authorizationId: "authorization-activate",
    oneUseNonce: "nonce-activate",
    actor: { ...authorization.actor, channel: "pi_tui" as const },
    resource: {
      type: "feature_flag" as const,
      repositoryId: "juicetin/pi-extensions",
      resourceId: "guardian-advisory-ui",
      immutableTarget: "flag-config-sha256",
    },
    operation: "activate" as const,
  };
  const activationResult = validateSensitiveActionAuthorization(activation, {
    ...request,
    resource: activation.resource,
    operation: "activate",
  });
  assert.equal(activationResult.validated, true);
  assert.equal(activationResult.consumption.operation, "activate");
  assert.equal(activationResult.consumption.resource.type, "feature_flag");

  assert.doesNotThrow(() => validateSensitiveActionAuthorization({
    ...authorization,
    authorizationId: "authorization-rpc",
    oneUseNonce: "nonce-rpc",
    actor: { ...authorization.actor, channel: "harness_rpc" },
  }, request));
});

test("sensitive authorization rejects replay, time, identity, and exact-target mismatches", () => {
  expectAuthorizationError(
    () => validateSensitiveActionAuthorization(authorization, { ...request, consumedAuthorizationIds: [authorization.authorizationId] }),
    "replayed",
  );
  expectAuthorizationError(
    () => validateSensitiveActionAuthorization(authorization, { ...request, consumedNonces: [authorization.oneUseNonce] }),
    "replayed",
  );
  expectAuthorizationError(() => validateSensitiveActionAuthorization(authorization, { ...request, now: authorization.expiresAt }), "expired");
  expectAuthorizationError(() => validateSensitiveActionAuthorization(authorization, { ...request, now: "2026-07-15T09:59:59Z" }), "not_yet_valid");
  assert.doesNotThrow(() => validateSensitiveActionAuthorization(authorization, { ...request, now: authorization.issuedAt }));
  expectAuthorizationError(
    () => validateSensitiveActionAuthorization({ ...authorization, actor: { ...authorization.actor, actorId: "" } }, request),
    "invalid_record",
  );

  for (const changedRequest of [
    { ...request, operation: "activate" as const },
    { ...request, riskClass: "deployment" as const },
    { ...request, resource: { ...request.resource, type: "feature_flag" as const } },
    { ...request, resource: { ...request.resource, repositoryId: "other/repo" } },
    { ...request, resource: { ...request.resource, resourceId: "6" } },
    { ...request, resource: { ...request.resource, immutableTarget: "changed-head" } },
  ]) expectAuthorizationError(() => validateSensitiveActionAuthorization(authorization, changedRequest), "target_mismatch");
});

test("decision decoding distinguishes versions and bounds validation details", () => {
  expectDecisionError(() => decodeAdvisoryReviewRecord(null), "invalid_record");
  expectDecisionError(() => decodeAdvisoryReviewRecord({ ...review, schemaVersion: 2 }), "unsupported_schema_version");
  expectDecisionError(() => decodeAdvisoryReviewRecord({ ...review, policyVersion: 2 }), "unsupported_policy_version");
  assert.throws(
    () => decodeDormantFlagLifecycle({ schemaVersion: 1, policyVersion: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof GuardianDecisionContractError);
      assert.equal(error.code, "invalid_record");
      assert.equal(error.details.length, 5);
      assert.ok(error.details.every((detail) => detail.startsWith("/") && detail.includes(":")));
      return true;
    },
  );
});

test("authorization decoding rejects versions, unknown fields, malformed time, and duplicate replay state", () => {
  expectAuthorizationError(() => validateSensitiveActionAuthorization({ ...authorization, schemaVersion: 2 } as never, request), "unsupported_schema_version");
  expectAuthorizationError(() => validateSensitiveActionAuthorization({ ...authorization, policyVersion: 2 } as never, request), "unsupported_policy_version");
  expectAuthorizationError(() => validateSensitiveActionAuthorization({ ...authorization, adjacentAuthority: true } as never, request), "invalid_record");
  expectAuthorizationError(() => validateSensitiveActionAuthorization({ ...authorization, expiresAt: "tomorrow" }, request), "invalid_record");
  expectAuthorizationError(() => validateSensitiveActionAuthorization({ ...authorization, expiresAt: "2026-02-31T00:00:00Z" }, request), "invalid_record");
  expectAuthorizationError(() => validateSensitiveActionAuthorization({ ...authorization, issuedAt: "2026-02-31T00:00:00Z" }, request), "invalid_record");
  expectAuthorizationError(
    () => validateSensitiveActionAuthorization({ ...authorization, resource: { ...authorization.resource, type: "feature_flag" } }, request),
    "invalid_record",
  );
  expectAuthorizationError(
    () => validateSensitiveActionAuthorization({ ...authorization, operation: "activate" }, request),
    "invalid_record",
  );
  assert.throws(
    () => validateSensitiveActionAuthorization(authorization, { ...request, now: "2026-02-31T00:00:00Z" }),
    (error: unknown) => {
      assert.ok(error instanceof SensitiveActionAuthorizationError);
      assert.equal(error.code, "invalid_request");
      assert.deepEqual(error.details, ["now"]);
      return true;
    },
  );
  assert.throws(
    () => validateSensitiveActionAuthorization({ schemaVersion: 1, policyVersion: 1 }, request),
    (error: unknown) => {
      assert.ok(error instanceof SensitiveActionAuthorizationError);
      assert.equal(error.code, "invalid_record");
      assert.equal(error.details.length, 5);
      assert.ok(error.details.every((detail) => detail.startsWith("/") && detail.includes(":")));
      return true;
    },
  );
  assert.throws(
    () => validateSensitiveActionAuthorization(authorization, {}),
    (error: unknown) => {
      assert.ok(error instanceof SensitiveActionAuthorizationError);
      assert.equal(error.code, "invalid_request");
      assert.equal(error.details.length, 5);
      assert.ok(error.details.every((detail) => detail.startsWith("/") && detail.includes(":")));
      return true;
    },
  );
  expectAuthorizationError(
    () => validateSensitiveActionAuthorization(authorization, { ...request, consumedAuthorizationIds: ["x", "x"] }),
    "invalid_request",
  );
  expectAuthorizationError(
    () => validateSensitiveActionAuthorization(authorization, { ...request, consumedNonces: ["x", "x"] }),
    "invalid_request",
  );
});

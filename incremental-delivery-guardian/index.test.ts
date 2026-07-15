import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GUARDIAN_POLICY,
  GUARDIAN_POLICY_VERSION,
  GUARDIAN_SCHEMA_HASH,
  GUARDIAN_SCHEMA_VERSION,
  GuardianContractError,
  decodeGuardianPolicy,
  decodePolicyOverride,
  decodeRepositoryPolicy,
  mergeGuardianPolicy,
  packageVersion,
} from "./index.ts";

const hours = (value: number) => value * 60 * 60 * 1_000;
const minutes = (value: number) => value * 60 * 1_000;

function expectContractError(action: () => unknown, code: GuardianContractError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof GuardianContractError);
    assert.equal(error.name, "GuardianContractError");
    assert.equal(error.code, code);
    assert.ok(error.message.length > 10);
    if (code === "invalid_record") assert.ok(error.details.length > 0);
    if (code.startsWith("unsupported_")) assert.deepEqual(error.details, []);
    return true;
  });
}

test("exports the approved default policy floor and compatibility identity", () => {
  assert.deepEqual(DEFAULT_GUARDIAN_POLICY, {
    schemaVersion: 1,
    policyVersion: 1,
    cadence: {
      activeTargetMs: hours(3),
      activeReviewMs: hours(4),
      activeHardSealMs: hours(6),
      wallWarningMs: hours(12),
      wallHardSealMs: hours(24),
    },
    scopeLedger: { maxUnplannedMs: minutes(30), maxMicroItems: 5 },
    humanApprovalRequiredRiskClasses: [
      "security",
      "auth",
      "infrastructure",
      "deployment",
      "data_migration",
      "production_activation",
      "policy_change",
    ],
  });
  assert.equal(GUARDIAN_SCHEMA_VERSION, 1);
  assert.equal(GUARDIAN_POLICY_VERSION, 1);
  assert.match(packageVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(GUARDIAN_SCHEMA_HASH, "b6b722fca016c611d35247acb202a11631787cb52e85c74c0ebb2e89cde16569");
  assert.ok(Object.isFrozen(DEFAULT_GUARDIAN_POLICY));
  assert.ok(Object.isFrozen(DEFAULT_GUARDIAN_POLICY.cadence));
  assert.ok(Object.isFrozen(DEFAULT_GUARDIAN_POLICY.humanApprovalRequiredRiskClasses));
});

test("strict policy decoding rejects unsupported versions, unknown fields, and invalid ordering", () => {
  expectContractError(() => decodeGuardianPolicy(null), "invalid_record");
  expectContractError(() => decodeGuardianPolicy({}), "invalid_record");
  expectContractError(
    () => decodeGuardianPolicy({ ...DEFAULT_GUARDIAN_POLICY, schemaVersion: 2 }),
    "unsupported_schema_version",
  );
  expectContractError(
    () => decodeGuardianPolicy({ ...DEFAULT_GUARDIAN_POLICY, policyVersion: 2 }),
    "unsupported_policy_version",
  );
  expectContractError(
    () => decodeGuardianPolicy({ ...DEFAULT_GUARDIAN_POLICY, unexpected: true }),
    "invalid_record",
  );
  expectContractError(
    () => decodeGuardianPolicy({
      ...DEFAULT_GUARDIAN_POLICY,
      cadence: { ...DEFAULT_GUARDIAN_POLICY.cadence, activeReviewMs: hours(7) },
    }),
    "invalid_policy_ordering",
  );
  expectContractError(
    () => decodeGuardianPolicy({
      ...DEFAULT_GUARDIAN_POLICY,
      cadence: { ...DEFAULT_GUARDIAN_POLICY.cadence, wallWarningMs: hours(25) },
    }),
    "invalid_policy_ordering",
  );
  assert.doesNotThrow(() => decodeGuardianPolicy({
    ...DEFAULT_GUARDIAN_POLICY,
    cadence: {
      ...DEFAULT_GUARDIAN_POLICY.cadence,
      activeReviewMs: hours(3),
      activeHardSealMs: hours(3),
      wallHardSealMs: hours(12),
    },
  }));
});

test("invalid records return bounded actionable details", () => {
  assert.throws(
    () => decodePolicyOverride({ schemaVersion: 1, policyVersion: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof GuardianContractError);
      assert.equal(error.details.length, 5);
      assert.ok(error.details.every((detail) => detail.startsWith("/") && detail.includes(":")));
      return true;
    },
  );
});

test("repository policy decoding rejects version skew and unknown nested fields", () => {
  expectContractError(
    () => decodeRepositoryPolicy({ schemaVersion: 1, policyVersion: 2 }),
    "unsupported_policy_version",
  );
  expectContractError(
    () => decodeRepositoryPolicy({
      schemaVersion: 1,
      policyVersion: 1,
      cadence: { activeHardSealMs: hours(5), adjacentCleanup: true },
    }),
    "invalid_record",
  );
});

test("repository policy merges only exact tightenings without mutating inputs", () => {
  const repository = decodeRepositoryPolicy({
    schemaVersion: 1,
    policyVersion: 1,
    cadence: { activeHardSealMs: hours(5) },
    scopeLedger: { maxMicroItems: 3 },
    humanApprovalRequiredRiskClasses: [...DEFAULT_GUARDIAN_POLICY.humanApprovalRequiredRiskClasses],
  });
  const merged = mergeGuardianPolicy(DEFAULT_GUARDIAN_POLICY, repository);
  assert.equal(merged.cadence.activeHardSealMs, hours(5));
  assert.equal(merged.scopeLedger.maxMicroItems, 3);
  assert.equal(merged.cadence.activeTargetMs, hours(3));
  assert.deepEqual(merged.humanApprovalRequiredRiskClasses, DEFAULT_GUARDIAN_POLICY.humanApprovalRequiredRiskClasses);
  assert.deepEqual(repository.cadence, { activeHardSealMs: hours(5) });
  assert.equal(DEFAULT_GUARDIAN_POLICY.cadence.activeHardSealMs, hours(6));

  const equalPolicy = mergeGuardianPolicy(DEFAULT_GUARDIAN_POLICY, {
    schemaVersion: 1,
    policyVersion: 1,
    cadence: { activeTargetMs: hours(3) },
  });
  assert.equal(equalPolicy.cadence.activeTargetMs, hours(3));
  assert.deepEqual(equalPolicy.humanApprovalRequiredRiskClasses, DEFAULT_GUARDIAN_POLICY.humanApprovalRequiredRiskClasses);

  expectContractError(
    () => mergeGuardianPolicy(DEFAULT_GUARDIAN_POLICY, decodeRepositoryPolicy({
      schemaVersion: 1,
      policyVersion: 1,
      cadence: { activeHardSealMs: hours(8) },
    })),
    "policy_weakening",
  );
  expectContractError(
    () => mergeGuardianPolicy(DEFAULT_GUARDIAN_POLICY, decodeRepositoryPolicy({
      schemaVersion: 1,
      policyVersion: 1,
      humanApprovalRequiredRiskClasses: ["security"],
    })),
    "policy_weakening",
  );
});

test("repository tightening cannot create an invalid effective cadence", () => {
  const repository = decodeRepositoryPolicy({
    schemaVersion: 1,
    policyVersion: 1,
    cadence: { activeReviewMs: hours(2) },
  });
  expectContractError(
    () => mergeGuardianPolicy(DEFAULT_GUARDIAN_POLICY, repository),
    "invalid_policy_ordering",
  );
});

test("override decoder accepts exact actor-bound wire data without authorizing it", () => {
  const override = decodePolicyOverride({
    schemaVersion: 1,
    policyVersion: 1,
    proposalId: "proposal-1",
    decisionId: "decision-1",
    interactionEventId: "interaction-1",
    exactItem: "Add one schema fixture",
    domains: ["guardian-contracts"],
    paths: ["incremental-delivery-guardian/fixtures/v1.json"],
    addedBudgetMs: minutes(20),
    currentPullRequest: {
      provider: "github",
      repositoryId: "juicetin/pi-extensions",
      pullRequestId: "42",
      headSha: "abc123",
      baseRef: "main",
    },
    issuedAt: "2026-07-15T04:00:00Z",
    expiresAt: "2026-07-15T05:00:00+00:00",
    binding: {
      actorId: "local-operator",
      ownerSessionId: "opaque-session",
      channel: "pi_tui",
    },
  });
  assert.equal(override.decisionId, "decision-1");
  assert.equal(
    decodePolicyOverride({ ...override, expiresAt: "2028-02-29T00:00:00Z" }).expiresAt,
    "2028-02-29T00:00:00Z",
  );

  expectContractError(
    () => decodePolicyOverride({ ...override, policyVersion: 2 }),
    "unsupported_policy_version",
  );
  expectContractError(
    () => decodePolicyOverride({ ...override, domains: ["guardian-contracts", "guardian-contracts"] }),
    "invalid_record",
  );
  expectContractError(
    () => decodePolicyOverride({
      ...override,
      binding: { ...override.binding, adjacentAuthority: true },
    }),
    "invalid_record",
  );
  expectContractError(
    () => decodePolicyOverride({ ...override, issuedAt: "tomorrow" }),
    "invalid_record",
  );
  expectContractError(
    () => decodePolicyOverride({ ...override, issuedAt: "2026-02-31T04:00:00Z" }),
    "invalid_record",
  );
  expectContractError(
    () => decodePolicyOverride({ ...override, issuedAt: "2026-02-00T04:00:00Z" }),
    "invalid_record",
  );
  expectContractError(
    () => decodePolicyOverride({ ...override, authorization: true }),
    "invalid_record",
  );
});

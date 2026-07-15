import { Type, type Static } from "@sinclair/typebox";

export const GUARDIAN_SCHEMA_VERSION = 1 as const;
export const GUARDIAN_POLICY_VERSION = 1 as const;

export const RiskClassSchema = Type.Union([
  Type.Literal("security"),
  Type.Literal("auth"),
  Type.Literal("infrastructure"),
  Type.Literal("deployment"),
  Type.Literal("data_migration"),
  Type.Literal("production_activation"),
  Type.Literal("policy_change"),
]);
export type RiskClass = Static<typeof RiskClassSchema>;

const PositiveInteger = () => Type.Integer({ minimum: 1 });
const VersionFields = {
  schemaVersion: Type.Literal(GUARDIAN_SCHEMA_VERSION),
  policyVersion: Type.Literal(GUARDIAN_POLICY_VERSION),
};
const Strict = { additionalProperties: false } as const;

export const GuardianPolicyConfigSchema = Type.Object({
  ...VersionFields,
  cadence: Type.Object({
    activeTargetMs: PositiveInteger(),
    activeReviewMs: PositiveInteger(),
    activeHardSealMs: PositiveInteger(),
    wallWarningMs: PositiveInteger(),
    wallHardSealMs: PositiveInteger(),
  }, Strict),
  scopeLedger: Type.Object({
    maxUnplannedMs: PositiveInteger(),
    maxMicroItems: PositiveInteger(),
  }, Strict),
  humanApprovalRequiredRiskClasses: Type.Array(RiskClassSchema, { uniqueItems: true }),
}, Strict);
export type GuardianPolicyConfig = Static<typeof GuardianPolicyConfigSchema>;

export const RepositoryPolicyConfigSchema = Type.Object({
  ...VersionFields,
  cadence: Type.Optional(Type.Object({
    activeTargetMs: Type.Optional(PositiveInteger()),
    activeReviewMs: Type.Optional(PositiveInteger()),
    activeHardSealMs: Type.Optional(PositiveInteger()),
    wallWarningMs: Type.Optional(PositiveInteger()),
    wallHardSealMs: Type.Optional(PositiveInteger()),
  }, Strict)),
  scopeLedger: Type.Optional(Type.Object({
    maxUnplannedMs: Type.Optional(PositiveInteger()),
    maxMicroItems: Type.Optional(PositiveInteger()),
  }, Strict)),
  humanApprovalRequiredRiskClasses: Type.Optional(Type.Array(RiskClassSchema, { uniqueItems: true })),
}, Strict);
export type RepositoryPolicyConfig = Static<typeof RepositoryPolicyConfigSchema>;

const NonEmptyString = () => Type.String({ minLength: 1 });
const Rfc3339String = () => Type.String({
  pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|[+-]([01]\\d|2[0-3]):[0-5]\\d)$",
});

export const PolicyOverrideContractSchema = Type.Object({
  ...VersionFields,
  proposalId: NonEmptyString(),
  decisionId: NonEmptyString(),
  interactionEventId: NonEmptyString(),
  exactItem: NonEmptyString(),
  domains: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
  paths: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
  addedBudgetMs: PositiveInteger(),
  currentPullRequest: Type.Object({
    provider: Type.Union([Type.Literal("github"), Type.Literal("bitbucket")]),
    repositoryId: NonEmptyString(),
    pullRequestId: NonEmptyString(),
    headSha: NonEmptyString(),
    baseRef: NonEmptyString(),
  }, Strict),
  issuedAt: Rfc3339String(),
  expiresAt: Rfc3339String(),
  binding: Type.Object({
    actorId: NonEmptyString(),
    ownerSessionId: NonEmptyString(),
    channel: Type.Union([
      Type.Literal("pi_tui"),
      Type.Literal("harness_web"),
      Type.Literal("harness_rpc"),
    ]),
    authenticatedPrincipalId: Type.Optional(NonEmptyString()),
  }, Strict),
}, Strict);
export type PolicyOverrideContract = Static<typeof PolicyOverrideContractSchema>;

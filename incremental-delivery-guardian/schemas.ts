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
    activeEscalationMs: PositiveInteger(),
    wallWarningMs: PositiveInteger(),
    wallEscalationMs: PositiveInteger(),
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
    activeEscalationMs: Type.Optional(PositiveInteger()),
    wallWarningMs: Type.Optional(PositiveInteger()),
    wallEscalationMs: Type.Optional(PositiveInteger()),
  }, Strict)),
  scopeLedger: Type.Optional(Type.Object({
    maxUnplannedMs: Type.Optional(PositiveInteger()),
    maxMicroItems: Type.Optional(PositiveInteger()),
  }, Strict)),
  humanApprovalRequiredRiskClasses: Type.Optional(Type.Array(RiskClassSchema, { uniqueItems: true })),
}, Strict);
export type RepositoryPolicyConfig = Static<typeof RepositoryPolicyConfigSchema>;

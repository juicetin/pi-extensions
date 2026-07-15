import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  GUARDIAN_POLICY_VERSION,
  GUARDIAN_SCHEMA_VERSION,
  GuardianPolicyConfigSchema,
  PolicyOverrideContractSchema,
  RepositoryPolicyConfigSchema,
  type GuardianPolicyConfig,
  type PolicyOverrideContract,
  type RepositoryPolicyConfig,
} from "./schemas.ts";

export type GuardianContractErrorCode =
  | "unsupported_schema_version"
  | "unsupported_policy_version"
  | "invalid_record"
  | "invalid_policy_ordering"
  | "policy_weakening";

export class GuardianContractError extends Error {
  readonly code: GuardianContractErrorCode;
  readonly details: readonly string[];

  constructor(code: GuardianContractErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "GuardianContractError";
    this.code = code;
    this.details = details;
  }
}

function assertSupportedVersions(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== undefined && record.schemaVersion !== GUARDIAN_SCHEMA_VERSION) {
    throw new GuardianContractError("unsupported_schema_version", `Unsupported guardian schema version: ${String(record.schemaVersion)}.`);
  }
  if (record.policyVersion !== undefined && record.policyVersion !== GUARDIAN_POLICY_VERSION) {
    throw new GuardianContractError("unsupported_policy_version", `Unsupported guardian policy version: ${String(record.policyVersion)}.`);
  }
}

function decode<T extends TSchema>(schema: T, input: unknown, label: string): Static<T> {
  assertSupportedVersions(input);
  if (!Value.Check(schema, input)) {
    const details = [...Value.Errors(schema, input)].slice(0, 5).map((error) => `${error.path || "/"}: ${error.message}`);
    throw new GuardianContractError("invalid_record", `Invalid ${label}: ${details.join("; ")}`, details);
  }
  return structuredClone(input) as Static<T>;
}

function assertPolicyOrdering(policy: GuardianPolicyConfig): void {
  const { cadence } = policy;
  const activeOrdered = cadence.activeTargetMs <= cadence.activeReviewMs
    && cadence.activeReviewMs <= cadence.activeHardSealMs;
  const wallOrdered = cadence.wallWarningMs <= cadence.wallHardSealMs;
  if (!activeOrdered || !wallOrdered) {
    throw new GuardianContractError(
      "invalid_policy_ordering",
      "Invalid guardian policy ordering: require activeTargetMs <= activeReviewMs <= activeHardSealMs and wallWarningMs <= wallHardSealMs.",
    );
  }
}

export function decodeGuardianPolicy(input: unknown): GuardianPolicyConfig {
  const policy = decode(GuardianPolicyConfigSchema, input, "guardian policy");
  assertPolicyOrdering(policy);
  return policy;
}

export function decodeRepositoryPolicy(input: unknown): RepositoryPolicyConfig {
  return decode(RepositoryPolicyConfigSchema, input, "repository policy");
}

function hasValidRfc3339CalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function decodePolicyOverride(input: unknown): PolicyOverrideContract {
  const override = decode(PolicyOverrideContractSchema, input, "policy override contract");
  const invalidTimestamps = ["issuedAt", "expiresAt"].filter((field) => (
    !hasValidRfc3339CalendarDate(override[field as "issuedAt" | "expiresAt"])
  ));
  if (invalidTimestamps.length > 0) {
    throw new GuardianContractError(
      "invalid_record",
      `Invalid policy override contract timestamps: ${invalidTimestamps.join(", ")}.`,
      invalidTimestamps,
    );
  }
  return override;
}

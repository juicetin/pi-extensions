import {
  GuardianContractError,
  decodeGuardianPolicy,
  decodeRepositoryPolicy,
} from "./contracts.ts";
import {
  GUARDIAN_POLICY_VERSION,
  GUARDIAN_SCHEMA_VERSION,
  type GuardianPolicyConfig,
  type RiskClass,
} from "./schemas.ts";

const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;

export const DEFAULT_GUARDIAN_POLICY = Object.freeze({
  schemaVersion: GUARDIAN_SCHEMA_VERSION,
  policyVersion: GUARDIAN_POLICY_VERSION,
  cadence: Object.freeze({
    activeTargetMs: 3 * HOUR_MS,
    activeReviewMs: 4 * HOUR_MS,
    activeHardSealMs: 6 * HOUR_MS,
    wallWarningMs: 12 * HOUR_MS,
    wallHardSealMs: 24 * HOUR_MS,
  }),
  scopeLedger: Object.freeze({ maxUnplannedMs: 30 * MINUTE_MS, maxMicroItems: 5 }),
  humanApprovalRequiredRiskClasses: Object.freeze([
    "security",
    "auth",
    "infrastructure",
    "deployment",
    "data_migration",
    "production_activation",
    "policy_change",
  ] satisfies RiskClass[]),
});

function mergeValues<T extends Record<string, number>>(floor: T, tightening: Partial<T> | undefined, area: string): T {
  const merged = { ...floor };
  for (const [key, value] of Object.entries(tightening ?? {})) {
    const floorValue = floor[key as keyof T];
    if (value > floorValue) {
      throw new GuardianContractError(
        "policy_weakening",
        `Repository policy weakens ${area}.${key}: ${value} exceeds global floor ${floorValue}.`,
      );
    }
    merged[key as keyof T] = value as T[keyof T];
  }
  return merged;
}

function mergeRiskClasses(floor: readonly RiskClass[], tightening: readonly RiskClass[] | undefined): RiskClass[] {
  if (tightening === undefined) return [...floor];
  const supplied = new Set(tightening);
  const missing = floor.filter((risk) => !supplied.has(risk));
  if (missing.length > 0) {
    throw new GuardianContractError(
      "policy_weakening",
      `Repository policy removes required human-approval risk classes: ${missing.join(", ")}.`,
      missing,
    );
  }
  return [...tightening];
}

export function mergeGuardianPolicy(
  globalFloorInput: unknown,
  repositoryInput: unknown,
): GuardianPolicyConfig {
  const globalFloor = decodeGuardianPolicy(globalFloorInput);
  const repository = decodeRepositoryPolicy(repositoryInput);

  return decodeGuardianPolicy({
    schemaVersion: globalFloor.schemaVersion,
    policyVersion: globalFloor.policyVersion,
    cadence: mergeValues(globalFloor.cadence, repository.cadence, "cadence"),
    scopeLedger: mergeValues(globalFloor.scopeLedger, repository.scopeLedger, "scopeLedger"),
    humanApprovalRequiredRiskClasses: mergeRiskClasses(
      globalFloor.humanApprovalRequiredRiskClasses,
      repository.humanApprovalRequiredRiskClasses,
    ),
  });
}

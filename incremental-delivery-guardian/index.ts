import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  GuardianPolicyConfigSchema,
  RepositoryPolicyConfigSchema,
} from "./schemas.ts";

export {
  GuardianContractError,
  decodeGuardianPolicy,
  decodeRepositoryPolicy,
  type GuardianContractErrorCode,
} from "./contracts.ts";
export {
  GUARDIAN_POLICY_VERSION,
  GUARDIAN_SCHEMA_VERSION,
  GuardianPolicyConfigSchema,
  RepositoryPolicyConfigSchema,
  RiskClassSchema,
  type GuardianPolicyConfig,
  type RepositoryPolicyConfig,
  type RiskClass,
} from "./schemas.ts";
export { DEFAULT_GUARDIAN_POLICY, mergeGuardianPolicy } from "./config.ts";

const require = createRequire(import.meta.url);
const rootPackage = require("../package.json") as { version: string };
export const packageVersion = rootPackage.version;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

const exportedSchemas = {
  GuardianPolicyConfigSchema,
  RepositoryPolicyConfigSchema,
};
const canonicalSchemas = JSON.stringify(canonicalize(exportedSchemas));
export const GUARDIAN_SCHEMA_HASH = createHash("sha256").update(canonicalSchemas).digest("hex");

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  GUARDIAN_POLICY_VERSION,
  GUARDIAN_SCHEMA_VERSION,
  RiskClassSchema,
} from "./schemas.ts";

const Strict = { additionalProperties: false } as const;
const NonEmptyString = () => Type.String({ minLength: 1 });
const UniqueNonEmptyStrings = () => Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true });
const VersionFields = {
  schemaVersion: Type.Literal(GUARDIAN_SCHEMA_VERSION),
  policyVersion: Type.Literal(GUARDIAN_POLICY_VERSION),
};
const Rfc3339String = () => Type.String({
  pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|[+-]([01]\\d|2[0-3]):[0-5]\\d)$",
});

const ReviewerSchema = Type.Object({
  sessionId: NonEmptyString(),
  fresh: Type.Literal(true),
  readOnly: Type.Literal(true),
}, Strict);
const ReviewBase = {
  ...VersionFields,
  reviewId: NonEmptyString(),
  proposalId: NonEmptyString(),
  reasonCodes: UniqueNonEmptyStrings(),
  reviewer: ReviewerSchema,
  createdAt: Rfc3339String(),
};
export const AdvisoryReviewRecordSchema = Type.Union([
  Type.Object({
    ...ReviewBase,
    status: Type.Literal("completed"),
    recommendation: Type.Union([
      Type.Literal("continue"),
      Type.Literal("split_slice"),
      Type.Literal("defer"),
      Type.Literal("replan"),
    ]),
  }, Strict),
  Type.Object({ ...ReviewBase, status: Type.Literal("unavailable") }, Strict),
]);
export type AdvisoryReviewRecord = Static<typeof AdvisoryReviewRecordSchema>;

export const DormantFlagLifecycleSchema = Type.Object({
  ...VersionFields,
  flagId: NonEmptyString(),
  owner: NonEmptyString(),
  defaultState: Type.Literal("off"),
  activationCriteria: UniqueNonEmptyStrings(),
  rollbackPlan: NonEmptyString(),
  dependencyIds: UniqueNonEmptyStrings(),
  removalCondition: NonEmptyString(),
  verificationPlan: NonEmptyString(),
}, Strict);
export type DormantFlagLifecycle = Static<typeof DormantFlagLifecycleSchema>;

export const SensitiveActionResourceSchema = Type.Object({
  type: Type.Union([Type.Literal("pull_request"), Type.Literal("feature_flag")]),
  repositoryId: NonEmptyString(),
  resourceId: NonEmptyString(),
  immutableTarget: NonEmptyString(),
}, Strict);
export type SensitiveActionResource = Static<typeof SensitiveActionResourceSchema>;

export const SensitiveActionAuthorizationSchema = Type.Object({
  ...VersionFields,
  authorizationId: NonEmptyString(),
  actor: Type.Object({
    actorId: NonEmptyString(),
    authenticatedPrincipalId: NonEmptyString(),
    channel: Type.Union([
      Type.Literal("pi_tui"),
      Type.Literal("harness_web"),
      Type.Literal("harness_rpc"),
    ]),
  }, Strict),
  resource: SensitiveActionResourceSchema,
  operation: Type.Union([Type.Literal("merge"), Type.Literal("activate")]),
  riskClass: RiskClassSchema,
  issuedAt: Rfc3339String(),
  expiresAt: Rfc3339String(),
  rationale: NonEmptyString(),
  auditEventId: NonEmptyString(),
  oneUseNonce: NonEmptyString(),
}, Strict);
export type SensitiveActionAuthorization = Static<typeof SensitiveActionAuthorizationSchema>;

const SensitiveActionRequestSchema = Type.Object({
  resource: SensitiveActionResourceSchema,
  operation: Type.Union([Type.Literal("merge"), Type.Literal("activate")]),
  riskClass: RiskClassSchema,
  now: Rfc3339String(),
  consumedAuthorizationIds: Type.Array(NonEmptyString(), { uniqueItems: true }),
  consumedNonces: Type.Array(NonEmptyString(), { uniqueItems: true }),
}, Strict);
export type SensitiveActionRequest = Static<typeof SensitiveActionRequestSchema>;

export type GuardianDecisionContractErrorCode = "unsupported_schema_version" | "unsupported_policy_version" | "invalid_record";
export class GuardianDecisionContractError extends Error {
  readonly code: GuardianDecisionContractErrorCode;
  readonly details: readonly string[];
  constructor(code: GuardianDecisionContractErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "GuardianDecisionContractError";
    this.code = code;
    this.details = details;
  }
}

export type SensitiveActionAuthorizationErrorCode = GuardianDecisionContractErrorCode | "invalid_request" | "target_mismatch" | "not_yet_valid" | "expired" | "replayed";
export class SensitiveActionAuthorizationError extends Error {
  readonly code: SensitiveActionAuthorizationErrorCode;
  readonly details: readonly string[];
  constructor(code: SensitiveActionAuthorizationErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "SensitiveActionAuthorizationError";
    this.code = code;
    this.details = details;
  }
}

export interface SensitiveActionConsumption {
  readonly authorizationId: string;
  readonly oneUseNonce: string;
  readonly actorId: string;
  readonly auditEventId: string;
  readonly resource: SensitiveActionResource;
  readonly operation: SensitiveActionAuthorization["operation"];
  readonly consumedAt: string;
}
export interface SensitiveActionAuthorizationResult {
  readonly validated: true;
  readonly effect: "requires_atomic_consumption_before_action";
  readonly consumption: SensitiveActionConsumption;
}

function versionError(input: unknown): GuardianDecisionContractError | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== undefined && record.schemaVersion !== GUARDIAN_SCHEMA_VERSION) {
    return new GuardianDecisionContractError("unsupported_schema_version", `Unsupported guardian schema version: ${String(record.schemaVersion)}.`);
  }
  if (record.policyVersion !== undefined && record.policyVersion !== GUARDIAN_POLICY_VERSION) {
    return new GuardianDecisionContractError("unsupported_policy_version", `Unsupported guardian policy version: ${String(record.policyVersion)}.`);
  }
  return undefined;
}

function decode<T extends TSchema>(schema: T, input: unknown, label: string): Static<T> {
  const unsupported = versionError(input);
  if (unsupported) throw unsupported;
  if (!Value.Check(schema, input)) {
    const details = [...Value.Errors(schema, input)].slice(0, 5).map((error) => `${error.path || "/"}: ${error.message}`);
    throw new GuardianDecisionContractError("invalid_record", `Invalid ${label}: ${details.join("; ")}`, details);
  }
  return structuredClone(input) as Static<T>;
}

function hasValidRfc3339CalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function assertValidTimestamp(value: string, label: string): void {
  if (!hasValidRfc3339CalendarDate(value) || Number.isNaN(Date.parse(value))) {
    throw new GuardianDecisionContractError("invalid_record", `Invalid ${label}.`, [label]);
  }
}

export function decodeAdvisoryReviewRecord(input: unknown): AdvisoryReviewRecord {
  const record = decode(AdvisoryReviewRecordSchema, input, "advisory review record");
  assertValidTimestamp(record.createdAt, "createdAt");
  return record;
}

export function decodeDormantFlagLifecycle(input: unknown): DormantFlagLifecycle {
  return decode(DormantFlagLifecycleSchema, input, "dormant flag lifecycle");
}

function decodeAuthorization(input: unknown): SensitiveActionAuthorization {
  const unsupported = versionError(input);
  if (unsupported) throw new SensitiveActionAuthorizationError(unsupported.code, unsupported.message, unsupported.details);
  if (!Value.Check(SensitiveActionAuthorizationSchema, input)) {
    const details = [...Value.Errors(SensitiveActionAuthorizationSchema, input)].slice(0, 5).map((error) => `${error.path || "/"}: ${error.message}`);
    throw new SensitiveActionAuthorizationError("invalid_record", `Invalid sensitive action authorization: ${details.join("; ")}`, details);
  }
  const authorization = structuredClone(input) as SensitiveActionAuthorization;
  if (!hasValidRfc3339CalendarDate(authorization.issuedAt) || !hasValidRfc3339CalendarDate(authorization.expiresAt)) {
    throw new SensitiveActionAuthorizationError("invalid_record", "Invalid sensitive action authorization timestamp.");
  }
  const compatible = authorization.operation === "merge"
    ? authorization.resource.type === "pull_request"
    : authorization.resource.type === "feature_flag";
  if (!compatible) throw new SensitiveActionAuthorizationError("invalid_record", "Sensitive action resource and operation are incompatible.");
  return authorization;
}

function decodeRequest(input: unknown): SensitiveActionRequest {
  if (!Value.Check(SensitiveActionRequestSchema, input)) {
    const details = [...Value.Errors(SensitiveActionRequestSchema, input)].slice(0, 5).map((error) => `${error.path || "/"}: ${error.message}`);
    throw new SensitiveActionAuthorizationError("invalid_request", `Invalid sensitive action request: ${details.join("; ")}`, details);
  }
  const request = structuredClone(input) as SensitiveActionRequest;
  if (!hasValidRfc3339CalendarDate(request.now) || Number.isNaN(Date.parse(request.now))) {
    throw new SensitiveActionAuthorizationError("invalid_request", "Invalid request time.", ["now"]);
  }
  return request;
}

function sameResource(left: SensitiveActionResource, right: SensitiveActionResource): boolean {
  return left.type === right.type
    && left.repositoryId === right.repositoryId
    && left.resourceId === right.resourceId
    && left.immutableTarget === right.immutableTarget;
}

export function validateSensitiveActionAuthorization(authorizationInput: unknown, requestInput: unknown): SensitiveActionAuthorizationResult {
  const authorization = decodeAuthorization(authorizationInput);
  const request = decodeRequest(requestInput);
  if (authorization.operation !== request.operation || authorization.riskClass !== request.riskClass || !sameResource(authorization.resource, request.resource)) {
    throw new SensitiveActionAuthorizationError("target_mismatch", "Authorization does not match the requested resource, operation, risk, or immutable target.");
  }
  const now = Date.parse(request.now);
  if (now < Date.parse(authorization.issuedAt)) throw new SensitiveActionAuthorizationError("not_yet_valid", "Authorization is not yet valid.");
  if (now >= Date.parse(authorization.expiresAt)) throw new SensitiveActionAuthorizationError("expired", "Authorization has expired.");
  if (request.consumedAuthorizationIds.includes(authorization.authorizationId) || request.consumedNonces.includes(authorization.oneUseNonce)) {
    throw new SensitiveActionAuthorizationError("replayed", "Authorization or nonce has already been consumed.");
  }
  return {
    validated: true,
    effect: "requires_atomic_consumption_before_action",
    consumption: {
      authorizationId: authorization.authorizationId,
      oneUseNonce: authorization.oneUseNonce,
      actorId: authorization.actor.actorId,
      auditEventId: authorization.auditEventId,
      resource: structuredClone(authorization.resource),
      operation: authorization.operation,
      consumedAt: request.now,
    },
  };
}

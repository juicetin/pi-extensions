import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { assessAdvisory, type AdvisoryAssessmentInput, type AdvisoryComponentIssue } from "./assessment.ts";
import {
  GuardianPolicyConfigSchema,
  RepositoryPolicyConfigSchema,
  RiskClassSchema,
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

export const GUARDIAN_REGISTRATION_EVENT = "incremental-delivery-guardian:register";
export const GUARDIAN_REGISTRATION_RESULT_EVENT = "incremental-delivery-guardian:registration-result";
export const GUARDIAN_OBSERVATION_EVENT = "incremental-delivery-guardian:observe";
export const GUARDIAN_TELEMETRY_EVENT = "incremental-delivery-guardian:telemetry";

const Strict = { additionalProperties: false } as const;
const Identifier = () => Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" });
const NonEmptyText = () => Type.String({ minLength: 1, maxLength: 2_048 });
const UniqueTextList = () => Type.Array(NonEmptyText(), { minItems: 1, maxItems: 128, uniqueItems: true });

export const DeliverySliceRegistrationSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  registrationId: Identifier(),
  repositoryId: Identifier(),
  repositoryRoot: Type.String({ minLength: 1, maxLength: 2_048, pattern: "^/" }),
  ownerId: Identifier(),
  outcome: NonEmptyText(),
  acceptanceCriteria: UniqueTextList(),
  beadId: Identifier(),
  branch: NonEmptyText(),
  baseRef: NonEmptyText(),
  domains: UniqueTextList(),
  pathGroups: Type.Array(Type.Object({
    name: Identifier(),
    roots: UniqueTextList(),
  }, Strict), { minItems: 1, maxItems: 64 }),
  exclusions: Type.Array(NonEmptyText(), { maxItems: 128, uniqueItems: true }),
  verificationPlan: UniqueTextList(),
  riskClass: RiskClassSchema,
  dependencies: Type.Array(Identifier(), { maxItems: 128, uniqueItems: true }),
}, Strict);
export type DeliverySliceRegistration = Static<typeof DeliverySliceRegistrationSchema>;
export const DELIVERY_SLICE_SCHEMA_HASH = createHash("sha256")
  .update(JSON.stringify(canonicalize(DeliverySliceRegistrationSchema)))
  .digest("hex");

export interface GuardianObservationRequest extends Omit<AdvisoryAssessmentInput<never>, "mutation"> {
  readonly registrationId: string;
  readonly observationId: string;
  readonly componentIssues?: readonly AdvisoryComponentIssue[];
}

const PROTECTED_ROOTS = [
  "/data/repos/corto-spike/.worktrees/bd-corto-4d2m-branch-mcp-infrastructure",
  "/data/repos/corto-spike/.worktrees/bd-corto-prod-lawconnect-downstream-enable",
].map((path) => resolve(path));

function normalized(path: string): string {
  return resolve(path);
}

function within(path: string, root: string): boolean {
  const candidate = normalized(path);
  const boundary = normalized(root);
  return candidate === boundary || candidate.startsWith(`${boundary}${sep}`);
}

function protectedPath(path: string): boolean {
  return PROTECTED_ROOTS.some((root) => within(path, root));
}

function decodeRegistration(input: unknown): DeliverySliceRegistration {
  if (!Value.Check(DeliverySliceRegistrationSchema, input)) {
    throw new Error("registration_contract_invalid");
  }
  return structuredClone(input) as DeliverySliceRegistration;
}

function emitVisible(pi: ExtensionAPI, channel: string, data: unknown, ctx?: ExtensionContext): void {
  try {
    pi.events.emit(channel, data);
  } catch {
    console.error("[incremental-delivery-guardian] telemetry publication unavailable");
    if (ctx?.hasUI) ctx.ui.notify("Guardian telemetry publication unavailable.", "warning");
  }
}

function queueVisible(task: () => void, ctx: ExtensionContext): void {
  queueMicrotask(() => {
    try {
      task();
    } catch {
      console.error("[incremental-delivery-guardian] telemetry task unavailable");
      if (ctx.hasUI) ctx.ui.notify("Guardian telemetry unavailable.", "warning");
    }
  });
}

export function createPassiveGuardianExtension() {
  return function passiveGuardian(pi: ExtensionAPI): void {
    const registrations = new Map<string, DeliverySliceRegistration>();
    let sessionCwd: string | undefined;
    let sessionExcluded = true;
    let userBashSequence = 0;

    const unregisterRegistration = pi.events.on(GUARDIAN_REGISTRATION_EVENT, (input) => {
      if (!sessionCwd) {
        emitVisible(pi, GUARDIAN_REGISTRATION_RESULT_EVENT, {
          status: "invalid", code: "session_unavailable",
          componentIssue: { component: "harness_adapter", code: "session_unavailable" },
        });
        return;
      }
      let registration: DeliverySliceRegistration;
      try {
        registration = decodeRegistration(input);
      } catch {
        emitVisible(pi, GUARDIAN_REGISTRATION_RESULT_EVENT, {
          status: "invalid", code: "registration_contract_invalid",
          componentIssue: { component: "harness_adapter", code: "registration_contract_invalid" },
        });
        return;
      }
      if (sessionExcluded || protectedPath(registration.repositoryRoot)) {
        emitVisible(pi, GUARDIAN_REGISTRATION_RESULT_EVENT, {
          status: "excluded", registrationId: registration.registrationId, repositoryId: registration.repositoryId,
        });
        return;
      }
      if (!within(sessionCwd, registration.repositoryRoot)) {
        emitVisible(pi, GUARDIAN_REGISTRATION_RESULT_EVENT, {
          status: "invalid", code: "repository_mismatch", registrationId: registration.registrationId,
          componentIssue: { component: "harness_adapter", code: "repository_mismatch" },
        });
        return;
      }
      if (registrations.has(registration.registrationId)) {
        emitVisible(pi, GUARDIAN_REGISTRATION_RESULT_EVENT, {
          status: "invalid", code: "duplicate_registration", registrationId: registration.registrationId,
          componentIssue: { component: "harness_adapter", code: "duplicate_registration" },
        });
        return;
      }
      registrations.set(registration.registrationId, registration);
      emitVisible(pi, GUARDIAN_REGISTRATION_RESULT_EVENT, {
        status: "registered", registrationId: registration.registrationId, repositoryId: registration.repositoryId,
      });
    });

    const unregisterObservation = pi.events.on(GUARDIAN_OBSERVATION_EVENT, (input) => {
      if (sessionExcluded) return;
      queueVisible(() => {
        const observation = input as Partial<GuardianObservationRequest>;
        if (typeof observation.observationId !== "string" || observation.observationId.length === 0 || !registrations.has(observation.registrationId as string)) {
          emitVisible(pi, GUARDIAN_TELEMETRY_EVENT, {
            status: "telemetry_unavailable", code: "registration_unavailable",
            componentIssue: { component: "harness_adapter", code: "registration_unavailable" },
            mutationEffect: "unchanged",
          });
          return;
        }
        try {
          const assessment = assessAdvisory({
            cadence: observation.cadence!,
            scope: observation.scope!,
            ledger: observation.ledger!,
            componentIssues: observation.componentIssues,
            mutation: null,
          });
          emitVisible(pi, GUARDIAN_TELEMETRY_EVENT, {
            status: "assessed",
            registrationId: observation.registrationId,
            observationId: observation.observationId,
            outcome: assessment.outcome,
            reasonCodes: assessment.reasonCodes,
            facts: assessment.facts,
            reviewIntent: assessment.reviewIntent,
            auditIntents: assessment.auditIntents,
            mutationEffect: "unchanged",
          });
        } catch {
          emitVisible(pi, GUARDIAN_TELEMETRY_EVENT, {
            status: "telemetry_unavailable", code: "observation_invalid",
            registrationId: observation.registrationId,
            observationId: observation.observationId,
            componentIssue: { component: "harness_adapter", code: "observation_invalid" },
            mutationEffect: "unchanged",
          });
        }
      }, ctxForNotification ?? ({ hasUI: false } as ExtensionContext));
    });

    let ctxForNotification: ExtensionContext | undefined;
    pi.on("session_start", (_event, ctx) => {
      registrations.clear();
      sessionCwd = ctx.cwd;
      sessionExcluded = protectedPath(ctx.cwd);
      userBashSequence = 0;
      ctxForNotification = ctx;
    });

    pi.on("tool_call", (event, ctx) => {
      if (sessionExcluded) return;
      const registrationIds = [...registrations.values()].filter((registration) => within(ctx.cwd, registration.repositoryRoot)).map((registration) => registration.registrationId).sort();
      queueVisible(() => emitVisible(pi, GUARDIAN_TELEMETRY_EVENT, {
        status: "operation_observed", source: "tool_call", operationId: event.toolCallId,
        operationName: event.toolName, registrationIds, mutationEffect: "unchanged",
      }, ctx), ctx);
    });

    pi.on("user_bash", (_event, ctx) => {
      if (sessionExcluded) return;
      const registrationIds = [...registrations.values()].filter((registration) => within(ctx.cwd, registration.repositoryRoot)).map((registration) => registration.registrationId).sort();
      userBashSequence += 1;
      const operationId = `user_bash:${userBashSequence}`;
      queueVisible(() => emitVisible(pi, GUARDIAN_TELEMETRY_EVENT, {
        status: "operation_observed", source: "user_bash", operationId,
        operationName: "bash", registrationIds, mutationEffect: "unchanged",
      }, ctx), ctx);
    });

    pi.on("session_shutdown", () => {
      registrations.clear();
      sessionCwd = undefined;
      sessionExcluded = true;
      userBashSequence = 0;
      ctxForNotification = undefined;
      unregisterRegistration();
      unregisterObservation();
    });
  };
}

export default createPassiveGuardianExtension();

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AdvisoryReviewRecord } from "./decisions.ts";
import { GUARDIAN_POLICY_VERSION, GUARDIAN_SCHEMA_VERSION } from "./schemas.ts";

const Strict = { additionalProperties: false } as const;
const RequestSchema = Type.Object({
  reviewId: Type.String({ minLength: 1 }),
  proposalId: Type.String({ minLength: 1 }),
  reasonCodes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  summary: Type.String({ minLength: 1, maxLength: 8_192 }),
  timeoutMs: Type.Integer({ minimum: 1, maximum: 120_000 }),
  maxTurns: Type.Integer({ minimum: 1, maximum: 8 }),
  now: Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|[+-]([01]\\d|2[0-3]):[0-5]\\d)$" }),
}, Strict);
export type FreshReviewRequest = Static<typeof RequestSchema>;

const LauncherResultSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  recommendation: Type.Union([Type.Literal("continue"), Type.Literal("split_slice"), Type.Literal("defer"), Type.Literal("replan")]),
}, Strict);
type LauncherResult = Static<typeof LauncherResultSchema>;

type LaunchInput = Pick<FreshReviewRequest, "proposalId" | "reasonCodes" | "summary" | "maxTurns"> & { readOnly: true; fresh: true };
export type FreshReviewLauncher = (input: LaunchInput) => Promise<unknown>;
export type FreshReviewUnavailableReason = "launcher_absent" | "timeout" | "no_answer" | "malformed_output" | "launcher_failed" | "notification_failed";

export type FreshReviewResult<TMutation> =
  | { status: "review_completed"; record: AdvisoryReviewRecord; mutation: TMutation; mutationEffect: "unchanged" }
  | { status: "review_unavailable"; reason: FreshReviewUnavailableReason; mutation: TMutation; mutationEffect: "unchanged" };

export async function requestFreshAdvisoryReview<TMutation>(input: {
  request: FreshReviewRequest;
  mutation: TMutation;
  launch?: FreshReviewLauncher;
  notify(record: AdvisoryReviewRecord): Promise<void>;
}): Promise<FreshReviewResult<TMutation>> {
  if (!Value.Check(RequestSchema, input.request)) throw new Error("fresh_review_request_invalid");
  if (!input.launch) return unavailable("launcher_absent", input.mutation);

  const launchInput: LaunchInput = {
    proposalId: input.request.proposalId,
    reasonCodes: [...input.request.reasonCodes],
    summary: input.request.summary,
    readOnly: true,
    fresh: true,
    maxTurns: input.request.maxTurns,
  };
  const timeout = Symbol("timeout");
  let timer!: NodeJS.Timeout;
  let raw: unknown;
  try {
    raw = await Promise.race([
      input.launch(launchInput),
      new Promise<typeof timeout>((resolve) => { timer = setTimeout(() => resolve(timeout), input.request.timeoutMs); }),
    ]);
  } catch {
    return unavailable("launcher_failed", input.mutation);
  } finally {
    clearTimeout(timer);
  }
  if (raw === timeout) return unavailable("timeout", input.mutation);
  if (raw === null || raw === undefined) return unavailable("no_answer", input.mutation);
  if (!Value.Check(LauncherResultSchema, raw)) return unavailable("malformed_output", input.mutation);

  const answer = structuredClone(raw) as LauncherResult;
  const record: AdvisoryReviewRecord = {
    schemaVersion: GUARDIAN_SCHEMA_VERSION,
    policyVersion: GUARDIAN_POLICY_VERSION,
    reviewId: input.request.reviewId,
    proposalId: input.request.proposalId,
    reasonCodes: [...input.request.reasonCodes],
    reviewer: { sessionId: answer.sessionId, fresh: true, readOnly: true },
    createdAt: input.request.now,
    status: "completed",
    recommendation: answer.recommendation,
  };
  try {
    await input.notify(record);
  } catch {
    return unavailable("notification_failed", input.mutation);
  }
  return { status: "review_completed", record, mutation: input.mutation, mutationEffect: "unchanged" };
}

function unavailable<TMutation>(reason: FreshReviewUnavailableReason, mutation: TMutation): FreshReviewResult<TMutation> {
  return { status: "review_unavailable", reason, mutation, mutationEffect: "unchanged" };
}

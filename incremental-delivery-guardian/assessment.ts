import type { CadenceMeasurement, ClockAnomaly, ThresholdFact } from "./clock.ts";
import type { ScopeLedgerFacts, ScopeLedgerThresholdFact } from "./ledger.ts";
import type { ScopeFact } from "./scope.ts";

export type AdvisoryOutcome = "normal" | "nudge" | "review_requested" | "telemetry_unavailable";
export type AdvisoryComponent = "clock" | "scope_classifier" | "scope_ledger" | "audit" | "reviewer" | "provider" | "harness_adapter" | "ralph_adapter";
export type CadenceFactName = "active_target" | "active_review" | "active_escalation" | "wall_warning" | "wall_escalation";

export interface AdvisoryComponentIssue {
  readonly component: AdvisoryComponent;
  readonly code: string;
}

export type AdvisoryFact =
  | { readonly kind: "cadence"; readonly name: CadenceFactName; readonly fact: ThresholdFact }
  | { readonly kind: "clock_anomaly"; readonly anomaly: ClockAnomaly }
  | { readonly kind: "scope"; readonly fact: ScopeFact }
  | { readonly kind: "scope_ledger"; readonly metric: "support_minutes" | "micro_items"; readonly fact: ScopeLedgerThresholdFact }
  | { readonly kind: "component_issue"; readonly issue: AdvisoryComponentIssue };

export interface AdvisoryReviewIntent {
  readonly kind: "request_review";
  readonly reasonCodes: readonly string[];
}

export interface AdvisoryAuditIntent {
  readonly kind: "record_advisory_assessment";
  readonly outcome: AdvisoryOutcome;
  readonly reasonCodes: readonly string[];
}

export interface AdvisoryAssessmentInput<TMutation> {
  readonly cadence: CadenceMeasurement;
  readonly scope: ScopeFact;
  readonly ledger: ScopeLedgerFacts;
  readonly componentIssues?: readonly AdvisoryComponentIssue[];
  readonly mutation: TMutation;
}

export interface AdvisoryAssessment<TMutation> {
  readonly outcome: AdvisoryOutcome;
  readonly reasonCodes: readonly string[];
  readonly facts: readonly AdvisoryFact[];
  readonly reviewIntent?: AdvisoryReviewIntent;
  readonly auditIntents: readonly AdvisoryAuditIntent[];
  readonly mutationEffect: "unchanged";
  readonly mutation: TMutation;
}

const CADENCE_FACTS = [
  ["activeTarget", "active_target"],
  ["activeReview", "active_review"],
  ["activeEscalation", "active_escalation"],
  ["wallWarning", "wall_warning"],
  ["wallEscalation", "wall_escalation"],
] as const;

function cadenceFacts(cadence: CadenceMeasurement): AdvisoryFact[] {
  if (!cadence.available) return cadence.anomalies.map((anomaly) => ({ kind: "clock_anomaly", anomaly }));
  return CADENCE_FACTS.map(([field, name]) => ({ kind: "cadence", name, fact: cadence[field] }));
}

function ledgerFacts(ledger: ScopeLedgerFacts): AdvisoryFact[] {
  return [
    { kind: "scope_ledger", metric: "support_minutes", fact: ledger.supportMinutes },
    { kind: "scope_ledger", metric: "micro_items", fact: ledger.microItems },
  ];
}

function cadenceReasons(cadence: CadenceMeasurement): string[] {
  if (!cadence.available) return [];
  return CADENCE_FACTS.flatMap(([field, name]) => cadence[field].reached ? [`cadence_${name}_reached`] : []);
}

function reviewReasons(scope: ScopeFact, ledger: ScopeLedgerFacts): string[] {
  const reasons: string[] = [];
  if (scope.classification === "immediate_expansion") reasons.push(`scope_${scope.reasonCode}`);
  if (ledger.supportMinutes.reached) reasons.push("scope_ledger_support_minutes_reached");
  if (ledger.microItems.reached) reasons.push("scope_ledger_micro_items_reached");
  return reasons;
}

function nudgeReasons(scope: ScopeFact): string[] {
  if (scope.classification === "ambiguous" || scope.classification === "unplanned_support") {
    return [`scope_${scope.reasonCode}`];
  }
  return [];
}

function unavailableReasons(input: AdvisoryAssessmentInput<unknown>): string[] {
  const reasons = input.componentIssues?.map((issue) => `${issue.component}_${issue.code}`) ?? [];
  if (!input.cadence.available) {
    reasons.unshift(...input.cadence.anomalies.map((anomaly) => `clock_${anomaly.code}`));
  }
  return reasons;
}

function outcome(unavailable: readonly string[], review: readonly string[], nudge: readonly string[]): AdvisoryOutcome {
  if (unavailable.length > 0) return "telemetry_unavailable";
  if (review.length > 0) return "review_requested";
  if (nudge.length > 0) return "nudge";
  return "normal";
}

export function assessAdvisory<TMutation>(input: AdvisoryAssessmentInput<TMutation>): AdvisoryAssessment<TMutation> {
  const unavailable = unavailableReasons(input);
  const review = reviewReasons(input.scope, input.ledger);
  const nudge = [...cadenceReasons(input.cadence), ...nudgeReasons(input.scope)];
  const reasonCodes = [...unavailable, ...review, ...nudge];
  const assessmentOutcome = outcome(unavailable, review, nudge);
  const facts: AdvisoryFact[] = [
    ...cadenceFacts(input.cadence),
    { kind: "scope", fact: input.scope },
    ...ledgerFacts(input.ledger),
    ...(input.componentIssues ?? []).map((issue) => ({ kind: "component_issue" as const, issue })),
  ];
  const reviewIntent = review.length > 0 ? { kind: "request_review" as const, reasonCodes: review } : undefined;
  return {
    outcome: assessmentOutcome,
    reasonCodes,
    facts,
    reviewIntent,
    auditIntents: [{ kind: "record_advisory_assessment", outcome: assessmentOutcome, reasonCodes }],
    mutationEffect: "unchanged",
    mutation: input.mutation,
  };
}

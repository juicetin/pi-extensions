import assert from "node:assert/strict";
import test from "node:test";

import { assessAdvisory, type AdvisoryAssessmentInput } from "./assessment.ts";
import type { CadenceMeasurement } from "./clock.ts";
import type { ScopeLedgerFacts } from "./ledger.ts";
import type { ScopeFact } from "./scope.ts";

const below = (thresholdMs: number) => ({ elapsedMs: thresholdMs - 1, thresholdMs, reached: false });
const at = (thresholdMs: number) => ({ elapsedMs: thresholdMs, thresholdMs, reached: true });

const normalCadence: CadenceMeasurement = {
  available: true,
  activeTarget: below(3),
  activeReview: below(4),
  activeEscalation: below(6),
  wallWarning: below(12),
  wallEscalation: below(24),
};
const normalScope: ScopeFact = {
  classification: "in_scope",
  reasonCode: "declared_scope",
  evidence: {
    kind: "path",
    repositoryId: "repo",
    domain: "guardian",
    pathGroup: "core",
    requestedPaths: ["/repo/incremental-delivery-guardian/assessment.ts"],
    canonicalPaths: ["/repo/incremental-delivery-guardian/assessment.ts"],
  },
};
const normalLedger: ScopeLedgerFacts = {
  supportMinutes: { value: 0, threshold: 30, reached: false },
  microItems: { value: 0, threshold: 5, reached: false },
};

function input(overrides: Partial<AdvisoryAssessmentInput<Readonly<{ operation: string; count: number; result: string; exitCode: number }>>> = {}) {
  return {
    cadence: normalCadence,
    scope: normalScope,
    ledger: normalLedger,
    componentIssues: [],
    mutation: Object.freeze({ operation: "edit", count: 1, result: "pending", exitCode: 0 }),
    ...overrides,
  };
}

test("returns normal while preserving the complete mutation envelope", () => {
  const request = input();
  const result = assessAdvisory(request);

  assert.equal(result.outcome, "normal");
  assert.equal(result.mutationEffect, "unchanged");
  assert.equal(result.mutation, request.mutation);
  assert.deepEqual(result.mutation, { operation: "edit", count: 1, result: "pending", exitCode: 0 });
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.reviewIntent, undefined);
  assert.deepEqual(result.facts, [
    { kind: "cadence", name: "active_target", fact: normalCadence.activeTarget },
    { kind: "cadence", name: "active_review", fact: normalCadence.activeReview },
    { kind: "cadence", name: "active_escalation", fact: normalCadence.activeEscalation },
    { kind: "cadence", name: "wall_warning", fact: normalCadence.wallWarning },
    { kind: "cadence", name: "wall_escalation", fact: normalCadence.wallEscalation },
    { kind: "scope", fact: normalScope },
    { kind: "scope_ledger", metric: "support_minutes", fact: normalLedger.supportMinutes },
    { kind: "scope_ledger", metric: "micro_items", fact: normalLedger.microItems },
  ]);
  assert.deepEqual(result.auditIntents, [{
    kind: "record_advisory_assessment",
    outcome: "normal",
    reasonCodes: [],
  }]);
});

test("every cadence threshold is an advisory nudge and never a mutation decision", () => {
  const cases = [
    ["activeTarget", "cadence_active_target_reached"],
    ["activeReview", "cadence_active_review_reached"],
    ["activeEscalation", "cadence_active_escalation_reached"],
    ["wallWarning", "cadence_wall_warning_reached"],
    ["wallEscalation", "cadence_wall_escalation_reached"],
  ] as const;

  for (const [name, reason] of cases) {
    const cadence = { ...normalCadence, [name]: at(normalCadence[name].thresholdMs) } as CadenceMeasurement;
    const request = input({ cadence });
    const result = assessAdvisory(request);
    assert.equal(result.outcome, "nudge", name);
    assert.deepEqual(result.reasonCodes, [reason], name);
    assert.equal(result.mutation, request.mutation, name);
    assert.equal(result.mutationEffect, "unchanged", name);
    assert.ok(!(["allow", "seal", "block"] as string[]).includes(result.outcome), name);
  }
});

test("immediate and cumulative expansion request review without authorizing mutation", () => {
  const expansion: ScopeFact = {
    ...normalScope,
    classification: "immediate_expansion",
    reasonCode: "architecture_change",
  };
  const atLimit: ScopeLedgerFacts = {
    supportMinutes: { value: 30, threshold: 30, reached: true },
    microItems: { value: 5, threshold: 5, reached: true },
  };

  const expansionRequest = input({ scope: expansion });
  const expansionResult = assessAdvisory(expansionRequest);
  assert.equal(expansionResult.outcome, "review_requested");
  assert.equal(expansionResult.mutation, expansionRequest.mutation);
  assert.deepEqual(expansionResult.reasonCodes, ["scope_architecture_change"]);
  assert.deepEqual(expansionResult.reviewIntent, {
    kind: "request_review",
    reasonCodes: ["scope_architecture_change"],
  });

  const ledgerRequest = input({ ledger: atLimit });
  const ledgerResult = assessAdvisory(ledgerRequest);
  assert.equal(ledgerResult.outcome, "review_requested");
  assert.equal(ledgerResult.mutation, ledgerRequest.mutation);
  assert.deepEqual(ledgerResult.reasonCodes, [
    "scope_ledger_support_minutes_reached",
    "scope_ledger_micro_items_reached",
  ]);
  assert.deepEqual(ledgerResult.reviewIntent?.reasonCodes, ledgerResult.reasonCodes);
  assert.equal(ledgerResult.mutationEffect, "unchanged");
});

test("ambiguity and bounded unplanned support nudge without requesting authority", () => {
  const ambiguous: ScopeFact = {
    ...normalScope,
    classification: "ambiguous",
    reasonCode: "missing_canonical_evidence",
    evidence: { ...normalScope.evidence, canonicalPaths: [] },
  };
  const support: ScopeFact = {
    ...normalScope,
    classification: "unplanned_support",
    reasonCode: "bounded_incidental_support",
    support: { microItemId: "m1", observedMinutes: 1 },
  };

  const ambiguousResult = assessAdvisory(input({ scope: ambiguous }));
  assert.equal(ambiguousResult.outcome, "nudge");
  assert.deepEqual(ambiguousResult.reasonCodes, ["scope_missing_canonical_evidence"]);
  assert.equal(ambiguousResult.reviewIntent, undefined);
  assert.equal(ambiguousResult.mutationEffect, "unchanged");

  const supportResult = assessAdvisory(input({ scope: support }));
  assert.equal(supportResult.outcome, "nudge");
  assert.deepEqual(supportResult.reasonCodes, ["scope_bounded_incidental_support"]);
  assert.equal(supportResult.reviewIntent, undefined);
});

test("clock and component failures are visible while valid review intent is retained", () => {
  const cadence: CadenceMeasurement = {
    available: false,
    anomalies: [{ code: "backward_wall", eventIndex: 2, previousMs: 10, observedMs: 9 }],
  };
  const expansion: ScopeFact = {
    ...normalScope,
    classification: "immediate_expansion",
    reasonCode: "security_change",
  };
  const request = input({
    cadence,
    scope: expansion,
    componentIssues: [
      { component: "reviewer", code: "review_unavailable" },
      { component: "audit", code: "non_persisted" },
    ],
  });

  const result = assessAdvisory(request);
  assert.equal(result.outcome, "telemetry_unavailable");
  assert.equal(result.mutation, request.mutation);
  assert.equal(result.mutationEffect, "unchanged");
  assert.ok(result.reasonCodes.includes("clock_backward_wall"));
  assert.ok(result.reasonCodes.includes("reviewer_review_unavailable"));
  assert.ok(result.reasonCodes.includes("audit_non_persisted"));
  assert.equal(new Set(result.reasonCodes).size, result.reasonCodes.length);
  assert.deepEqual(result.reviewIntent?.reasonCodes, ["scope_security_change"]);
  assert.deepEqual(result.facts.filter((fact) => fact.kind === "clock_anomaly"), [
    { kind: "clock_anomaly", anomaly: cadence.anomalies[0] },
  ]);
  assert.deepEqual(result.facts.filter((fact) => fact.kind === "component_issue"), [
    { kind: "component_issue", issue: { component: "reviewer", code: "review_unavailable" } },
    { kind: "component_issue", issue: { component: "audit", code: "non_persisted" } },
  ]);
  assert.deepEqual(result.auditIntents, [{
    kind: "record_advisory_assessment",
    outcome: "telemetry_unavailable",
    reasonCodes: result.reasonCodes,
  }]);
});

test("every advisory component failure is visible and mutation-invariant", () => {
  const issues = [
    { component: "clock", code: "measurement_failed" },
    { component: "scope_classifier", code: "invalid_record" },
    { component: "scope_ledger", code: "invalid_snapshot" },
    { component: "audit", code: "non_persisted" },
    { component: "reviewer", code: "review_unavailable" },
    { component: "provider", code: "provider_unavailable" },
    { component: "harness_adapter", code: "projection_failed" },
    { component: "ralph_adapter", code: "projection_failed" },
  ] as const;

  for (const issue of issues) {
    const request = input({ componentIssues: [issue] });
    const result = assessAdvisory(request);
    assert.equal(result.outcome, "telemetry_unavailable", issue.component);
    assert.deepEqual(result.reasonCodes, [`${issue.component}_${issue.code}`], issue.component);
    assert.deepEqual(result.facts.at(-1), { kind: "component_issue", issue }, issue.component);
    assert.equal(result.mutation, request.mutation, issue.component);
    assert.equal(result.mutationEffect, "unchanged", issue.component);
  }
});

test("omitted component issues are an explicit empty telemetry set", () => {
  const request = input({ componentIssues: undefined });
  const result = assessAdvisory(request);
  assert.equal(result.outcome, "normal");
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.facts.some((fact) => fact.kind === "component_issue"), false);
  assert.equal(result.mutation, request.mutation);
});

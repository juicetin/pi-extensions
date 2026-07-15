import assert from "node:assert/strict";
import test from "node:test";

import { LedgerFoldError, foldScopeLedger, type ScopeLedgerSnapshot } from "./ledger.ts";
import type { ScopeFact } from "./scope.ts";

const thresholds = { supportMinutes: 30, microItems: 5 } as const;
const empty: ScopeLedgerSnapshot = { totalSupportMinutes: 0, microItemIds: [], entries: [], resets: [] };
const fact = (classification: ScopeFact["classification"], id = "m1", minutes = 1): ScopeFact => {
  const evidence = { kind: "path" as const, repositoryId: "repo", domain: "domain", pathGroup: "group", requestedPaths: ["/repo/x"], canonicalPaths: ["/repo/x"] };
  if (classification === "unplanned_support") {
    return { classification, reasonCode: "bounded_incidental_support", evidence, support: { microItemId: id, observedMinutes: minutes } };
  }
  const reasonCode = classification === "in_scope"
    ? "declared_scope"
    : classification === "immediate_expansion"
      ? "security_change"
      : "repository_unproven";
  return { classification, reasonCode, evidence };
};

function expectLedgerError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LedgerFoldError);
    assert.equal(error.code, code);
    return true;
  });
}

test("only unplanned support accumulates while every classification is recorded", () => {
  let result = foldScopeLedger(empty, fact("in_scope"), thresholds);
  result = foldScopeLedger(result.snapshot, fact("immediate_expansion"), thresholds);
  result = foldScopeLedger(result.snapshot, fact("ambiguous"), thresholds);
  result = foldScopeLedger(result.snapshot, fact("unplanned_support", "m1", 3), thresholds);
  assert.equal(result.snapshot.totalSupportMinutes, 3);
  assert.deepEqual(result.snapshot.microItemIds, ["m1"]);
  assert.equal(result.snapshot.entries.length, 4);
});

test("reports exact minute and item boundaries", () => {
  const at29 = foldScopeLedger(empty, fact("unplanned_support", "m1", 29), thresholds);
  assert.equal(at29.facts.supportMinutes.reached, false);
  const at30 = foldScopeLedger(empty, fact("unplanned_support", "m1", 30), thresholds);
  assert.equal(at30.facts.supportMinutes.reached, true);
  let result = foldScopeLedger(empty, fact("unplanned_support", "m1"), thresholds);
  for (let index = 2; index <= 4; index += 1) result = foldScopeLedger(result.snapshot, fact("unplanned_support", `m${index}`), thresholds);
  assert.equal(result.facts.microItems.reached, false);
  result = foldScopeLedger(result.snapshot, fact("unplanned_support", "m5"), thresholds);
  assert.equal(result.facts.microItems.reached, true);
});

test("rejects duplicate micro-items instead of deduplicating, including after reset", () => {
  const first = foldScopeLedger(empty, fact("unplanned_support", "same"), thresholds);
  expectLedgerError(() => foldScopeLedger(first.snapshot, fact("unplanned_support", "same"), thresholds), "duplicate_micro_item");
  const reset = foldScopeLedger(first.snapshot, { kind: "pr_opened", verifiedDeliveryReceiptId: "receipt-1" }, thresholds);
  expectLedgerError(() => foldScopeLedger(reset.snapshot, fact("unplanned_support", "same"), thresholds), "duplicate_micro_item");
});

test("copies previous state and events without mutating either", () => {
  const previous: ScopeLedgerSnapshot = { totalSupportMinutes: 2, microItemIds: ["old"], entries: [fact("unplanned_support", "old", 2)], resets: [] };
  const event = fact("unplanned_support", "new", 1);
  const result = foldScopeLedger(previous, event, thresholds);
  assert.deepEqual(previous, { totalSupportMinutes: 2, microItemIds: ["old"], entries: [fact("unplanned_support", "old", 2)], resets: [] });
  if (event.classification !== "unplanned_support") throw new Error("Expected support fact");
  event.support.observedMinutes = 99;
  assert.equal((result.snapshot.entries[1] as ScopeFact).support?.observedMinutes, 1);
});

test("rejects inconsistent counters and forged reset projections", () => {
  const support = fact("unplanned_support", "m1", 29);
  const active = foldScopeLedger(empty, support, thresholds).snapshot;
  for (const tampered of [
    { ...active, totalSupportMinutes: 0 },
    { ...active, microItemIds: [] },
    { ...active, microItemIds: ["wrong"] },
    { ...active, microItemIds: ["m1", "extra"] },
  ]) {
    expectLedgerError(() => foldScopeLedger(tampered, fact("unplanned_support", "m2", 1), thresholds), "invalid_snapshot");
  }
  const validReset = foldScopeLedger(
    active,
    { kind: "pr_opened", verifiedDeliveryReceiptId: "receipt-1" },
    thresholds,
  ).snapshot;
  const reset = validReset.resets[0];
  for (const resetList of [
    [],
    [null],
    [42],
    [{ ...reset, priorMicroItemIds: 1 }],
  ]) {
    expectLedgerError(() => foldScopeLedger({
      ...validReset, resets: resetList,
    } as unknown as ScopeLedgerSnapshot, fact("in_scope"), thresholds), "invalid_snapshot");
  }
  for (const forged of [
    { ...reset, entryIndex: 0 },
    { ...reset, verifiedDeliveryReceiptId: "forged" },
    { ...reset, priorSupportMinutes: 0 },
    { ...reset, priorMicroItemIds: [] },
    { ...reset, priorMicroItemIds: ["wrong"] },
    { ...reset, priorMicroItemIds: ["m1", "extra"] },
  ]) {
    expectLedgerError(() => foldScopeLedger({
      ...validReset, resets: [forged],
    }, fact("in_scope"), thresholds), "invalid_snapshot");
  }
});

test("resets only for an explicit unique PR-opened event with verified receipt", () => {
  const active = foldScopeLedger(empty, fact("unplanned_support", "m1", 12), thresholds).snapshot;
  const result = foldScopeLedger(active, { kind: "pr_opened", verifiedDeliveryReceiptId: "receipt-1" }, thresholds);
  assert.equal(result.snapshot.totalSupportMinutes, 0);
  assert.deepEqual(result.snapshot.microItemIds, []);
  assert.equal(result.snapshot.entries.length, 2);
  assert.deepEqual(result.snapshot.resets, [{ entryIndex: 1, verifiedDeliveryReceiptId: "receipt-1", priorSupportMinutes: 12, priorMicroItemIds: ["m1"] }]);
  expectLedgerError(() => foldScopeLedger(active, { kind: "pr_opened", verifiedDeliveryReceiptId: " " }, thresholds), "invalid_receipt");
  const afterNewSupport = foldScopeLedger(result.snapshot, fact("unplanned_support", "m2", 2), thresholds).snapshot;
  expectLedgerError(() => foldScopeLedger(afterNewSupport, {
    kind: "pr_opened", verifiedDeliveryReceiptId: "receipt-1",
  }, thresholds), "duplicate_receipt");
});

test("rejects contradictory facts and malformed evidence", () => {
  expectLedgerError(() => foldScopeLedger(empty, {
    ...fact("in_scope"), reasonCode: "security_change",
  } as ScopeFact, thresholds), "malformed_event");
  expectLedgerError(() => foldScopeLedger(empty, {
    ...fact("immediate_expansion"), reasonCode: "declared_scope",
  } as ScopeFact, thresholds), "malformed_event");
  expectLedgerError(() => foldScopeLedger(empty, {
    ...fact("immediate_expansion"), evidence: { ...fact("immediate_expansion").evidence, repositoryId: " " },
  } as ScopeFact, thresholds), "malformed_event");
  expectLedgerError(() => foldScopeLedger(empty, {
    ...fact("ambiguous"), evidence: {},
  } as ScopeFact, thresholds), "malformed_event");
  const base = fact("in_scope");
  for (const evidence of [
    { ...base.evidence, kind: "unknown" },
    { ...base.evidence, domain: " " },
    { ...base.evidence, repositoryId: " " },
    { ...base.evidence, pathGroup: undefined },
    { ...base.evidence, childSliceId: " " },
    { ...base.evidence, requestedPaths: "bad" },
    { ...base.evidence, requestedPaths: ["relative"] },
    { ...base.evidence, requestedPaths: ["/repo/x", "relative"] },
    { ...base.evidence, canonicalPaths: ["relative"] },
  ]) {
    expectLedgerError(() => foldScopeLedger(empty, {
      ...base, evidence,
    } as unknown as ScopeFact, thresholds), "malformed_event");
  }
  const support = fact("unplanned_support", "m1", 1);
  for (const contradictory of [
    { ...support, evidence: { ...support.evidence, canonicalPaths: [] } },
    {
      ...fact("in_scope"),
      evidence: { ...fact("in_scope").evidence, kind: "shell", pathGroup: undefined, requestedPaths: [], canonicalPaths: [] },
    },
    {
      ...fact("ambiguous"),
      reasonCode: "missing_canonical_evidence",
      evidence: { ...fact("ambiguous").evidence, canonicalPaths: ["/repo/x"] },
    },
  ]) {
    expectLedgerError(() => foldScopeLedger(empty, contradictory as ScopeFact, thresholds), "malformed_event");
  }
  for (const malformed of [
    { ...support, support: undefined },
    { ...support, support: 1 },
    { ...support, support: { microItemId: " ", observedMinutes: 1 } },
    { ...support, support: { microItemId: "m1", observedMinutes: 0 } },
    { ...support, support: { microItemId: "m1", observedMinutes: 1.5 } },
    { ...fact("in_scope"), support: { microItemId: "m1", observedMinutes: 1 } },
    { ...fact("in_scope"), classification: "unknown" },
  ]) {
    expectLedgerError(() => foldScopeLedger(empty, malformed as unknown as ScopeFact, thresholds), "malformed_event");
  }
  expectLedgerError(() => foldScopeLedger(empty, null as unknown as ScopeFact, thresholds), "malformed_event");
});

test("enforces reason-specific evidence invariants", () => {
  const pathEvidence = fact("in_scope").evidence;
  const validFacts = [
    { ...fact("immediate_expansion"), evidence: { ...pathEvidence, requestedPaths: [], canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "missing_canonical_evidence", evidence: { ...pathEvidence, canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "shell_write_roots_unproven", evidence: { ...pathEvidence, kind: "shell", pathGroup: undefined, requestedPaths: [], canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "child_slice_unregistered", evidence: { ...pathEvidence, kind: "child", pathGroup: undefined, childSliceId: undefined, requestedPaths: [], canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "child_paths_unbounded", evidence: { ...pathEvidence, kind: "child", pathGroup: undefined, childSliceId: "child", requestedPaths: [], canonicalPaths: [] } },
  ] as unknown as ScopeFact[];
  for (const valid of validFacts) assert.doesNotThrow(() => foldScopeLedger(empty, valid, thresholds));

  const invalidFacts = [
    { ...fact("in_scope"), evidence: { ...pathEvidence, repositoryId: undefined } },
    { ...fact("in_scope"), evidence: { ...pathEvidence, requestedPaths: [], canonicalPaths: [] } },
    { ...fact("in_scope"), evidence: { ...pathEvidence, canonicalPaths: [] } },
    { ...fact("in_scope"), evidence: { ...pathEvidence, kind: "child", pathGroup: undefined, childSliceId: undefined } },
    { ...fact("ambiguous"), reasonCode: "missing_canonical_evidence", evidence: { ...pathEvidence, requestedPaths: [], canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "shell_write_roots_unproven", evidence: { ...pathEvidence, kind: "path", requestedPaths: [], canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "shell_write_roots_unproven", evidence: { ...pathEvidence, kind: "shell", pathGroup: undefined, requestedPaths: ["/repo/x"], canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "shell_write_roots_unproven", evidence: { ...pathEvidence, kind: "shell", pathGroup: undefined, requestedPaths: [], canonicalPaths: ["/repo/x"] } },
    { ...fact("ambiguous"), reasonCode: "child_slice_unregistered", evidence: { ...pathEvidence, kind: "path" } },
    { ...fact("ambiguous"), reasonCode: "child_paths_unbounded", evidence: { ...pathEvidence, kind: "path", requestedPaths: [], canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "child_paths_unbounded", evidence: { ...pathEvidence, kind: "child", pathGroup: undefined, childSliceId: undefined, requestedPaths: [], canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "child_paths_unbounded", evidence: { ...pathEvidence, kind: "child", pathGroup: undefined, childSliceId: "child", requestedPaths: ["/repo/x"], canonicalPaths: [] } },
    { ...fact("ambiguous"), reasonCode: "child_paths_unbounded", evidence: { ...pathEvidence, kind: "child", pathGroup: undefined, childSliceId: "child", requestedPaths: [], canonicalPaths: ["/repo/x"] } },
  ] as unknown as ScopeFact[];
  for (const invalid of invalidFacts) {
    expectLedgerError(() => foldScopeLedger(empty, invalid, thresholds), "malformed_event");
  }
});

test("maps uncloneable persisted or event data to typed errors", () => {
  expectLedgerError(() => foldScopeLedger({
    ...empty, extra: () => "bad",
  } as unknown as ScopeLedgerSnapshot, fact("in_scope"), thresholds), "invalid_snapshot");
  expectLedgerError(() => foldScopeLedger(empty, {
    ...fact("in_scope"), extra: () => "bad",
  } as unknown as ScopeFact, thresholds), "malformed_event");
});

test("rejects malformed persisted snapshot shapes", () => {
  for (const previous of [
    null,
    { ...empty, totalSupportMinutes: -1 },
    { ...empty, totalSupportMinutes: 1.5 },
    { ...empty, microItemIds: 1 },
    { ...empty, entries: 1 },
    { ...empty, entries: [null] },
    { ...empty, entries: [{ ...fact("in_scope"), reasonCode: "security_change" }] },
    { ...empty, resets: 1 },
    { ...empty, resets: [null] },
  ]) {
    expectLedgerError(() => foldScopeLedger(previous as unknown as ScopeLedgerSnapshot, fact("in_scope"), thresholds), "invalid_snapshot");
  }
});

test("rejects unsupported reset aliases and invalid thresholds", () => {
  for (const kind of ["commit", "push", "resume", "text"] as const) {
    expectLedgerError(() => foldScopeLedger(empty, { kind } as never, thresholds), "unsupported_event_kind");
  }
  expectLedgerError(() => foldScopeLedger(empty, fact("in_scope"), null as unknown as typeof thresholds), "invalid_threshold");
  expectLedgerError(() => foldScopeLedger(empty, fact("in_scope"), { supportMinutes: 0, microItems: 5 }), "invalid_threshold");
  expectLedgerError(() => foldScopeLedger(empty, fact("in_scope"), { supportMinutes: "30", microItems: 5 } as unknown as typeof thresholds), "invalid_threshold");
  expectLedgerError(() => foldScopeLedger(empty, fact("in_scope"), { supportMinutes: 30, microItems: 1.5 }), "invalid_threshold");
});

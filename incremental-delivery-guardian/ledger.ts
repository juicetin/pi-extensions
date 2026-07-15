import path from "node:path";

import type {
  ScopeClassification,
  ScopeEvidence,
  ScopeFact,
  ScopeReasonCode,
} from "./scope.ts";

export interface PrOpenedLedgerEvent { readonly kind: "pr_opened"; readonly verifiedDeliveryReceiptId: string }
export type ScopeLedgerEvent = ScopeFact | PrOpenedLedgerEvent;
export interface ScopeLedgerReset {
  readonly entryIndex: number;
  readonly verifiedDeliveryReceiptId: string;
  readonly priorSupportMinutes: number;
  readonly priorMicroItemIds: readonly string[];
}
export interface ScopeLedgerSnapshot {
  readonly totalSupportMinutes: number;
  readonly microItemIds: readonly string[];
  readonly entries: readonly ScopeLedgerEvent[];
  readonly resets: readonly ScopeLedgerReset[];
}
export interface ScopeLedgerThresholds { readonly supportMinutes: number; readonly microItems: number }
export interface ScopeLedgerThresholdFact { readonly value: number; readonly threshold: number; readonly reached: boolean }
export interface ScopeLedgerFacts { readonly supportMinutes: ScopeLedgerThresholdFact; readonly microItems: ScopeLedgerThresholdFact }
export interface ScopeLedgerFoldResult { readonly snapshot: ScopeLedgerSnapshot; readonly facts: ScopeLedgerFacts }

export type LedgerFoldErrorCode =
  | "duplicate_micro_item"
  | "duplicate_receipt"
  | "invalid_receipt"
  | "invalid_snapshot"
  | "invalid_threshold"
  | "malformed_event"
  | "unsupported_event_kind";
export class LedgerFoldError extends Error {
  readonly code: LedgerFoldErrorCode;
  constructor(code: LedgerFoldErrorCode, message: string) {
    super(message);
    this.name = "LedgerFoldError";
    this.code = code;
  }
}

const REASONS: Record<ScopeClassification, ReadonlySet<ScopeReasonCode>> = {
  in_scope: new Set(["declared_scope"]),
  unplanned_support: new Set(["bounded_incidental_support"]),
  ambiguous: new Set([
    "repository_unproven",
    "missing_canonical_evidence",
    "shell_write_roots_unproven",
    "child_slice_unregistered",
    "child_paths_unbounded",
  ]),
  immediate_expansion: new Set([
    "different_repository",
    "lexical_escape",
    "path_group_escape",
    "canonical_escape",
    "excluded_path",
    "undeclared_domain",
    "architecture_change",
    "trust_boundary_change",
    "infra_change",
    "deploy_change",
    "auth_change",
    "security_change",
    "schema_change",
    "external_dependency_change",
    "acceptance_criteria_change",
  ]),
};
const CLASSIFICATIONS = new Set<ScopeClassification>(Object.keys(REASONS) as ScopeClassification[]);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cloneLedgerInput<T>(value: T, code: "invalid_snapshot" | "malformed_event"): T {
  try {
    return structuredClone(value);
  } catch {
    throw new LedgerFoldError(code, "Ledger input must contain cloneable data values.");
  }
}
function assertThreshold(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LedgerFoldError("invalid_threshold", `${field} must be a positive integer.`);
  }
}
function validatePaths(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => !nonEmpty(entry) || !path.isAbsolute(entry))) {
    throw new LedgerFoldError("malformed_event", `${field} must contain absolute paths.`);
  }
}
function validateEvidence(evidence: ScopeEvidence): void {
  if (!isRecord(evidence) || !new Set(["path", "shell", "child"]).has(evidence.kind)
    || !nonEmpty(evidence.domain)) {
    throw new LedgerFoldError("malformed_event", "Scope evidence identity is malformed.");
  }
  if (evidence.repositoryId !== undefined && !nonEmpty(evidence.repositoryId)) {
    throw new LedgerFoldError("malformed_event", "Scope evidence repositoryId is malformed.");
  }
  if (evidence.kind === "path" && !nonEmpty(evidence.pathGroup)) {
    throw new LedgerFoldError("malformed_event", "Path evidence requires a path group.");
  }
  if (evidence.childSliceId !== undefined && !nonEmpty(evidence.childSliceId)) {
    throw new LedgerFoldError("malformed_event", "Child evidence has an invalid slice ID.");
  }
  validatePaths(evidence.requestedPaths, "evidence.requestedPaths");
  validatePaths(evidence.canonicalPaths, "evidence.canonicalPaths");
  if (evidence.canonicalPaths.length > evidence.requestedPaths.length) {
    throw new LedgerFoldError("malformed_event", "Canonical path evidence cannot outnumber requested paths.");
  }
}
function validateReasonEvidence(fact: ScopeFact): void {
  const { evidence, reasonCode } = fact;
  const hasBoundedPaths = nonEmpty(evidence.repositoryId)
    && evidence.requestedPaths.length > 0
    && evidence.canonicalPaths.length === evidence.requestedPaths.length
    && (evidence.kind !== "child" || nonEmpty(evidence.childSliceId));
  if ((fact.classification === "in_scope" || fact.classification === "unplanned_support") && !hasBoundedPaths) {
    throw new LedgerFoldError("malformed_event", "Bounded scope facts require complete repository, path, and canonical evidence.");
  }
  if (reasonCode === "missing_canonical_evidence"
    && (evidence.requestedPaths.length === 0 || evidence.canonicalPaths.length >= evidence.requestedPaths.length)) {
    throw new LedgerFoldError("malformed_event", "Missing-canonical facts must identify unresolved requested paths.");
  }
  if (reasonCode === "shell_write_roots_unproven"
    && (evidence.kind !== "shell" || evidence.requestedPaths.length !== 0 || evidence.canonicalPaths.length !== 0)) {
    throw new LedgerFoldError("malformed_event", "Unproven shell facts cannot claim bounded write paths.");
  }
  if (reasonCode === "child_slice_unregistered" && evidence.kind !== "child") {
    throw new LedgerFoldError("malformed_event", "Unregistered-child facts require child evidence.");
  }
  if (reasonCode === "child_paths_unbounded"
    && (evidence.kind !== "child" || !nonEmpty(evidence.childSliceId) || evidence.requestedPaths.length !== 0)) {
    throw new LedgerFoldError("malformed_event", "Unbounded-child facts require a registered child without paths.");
  }
}

function validateFact(fact: ScopeFact): void {
  if (!isRecord(fact) || !CLASSIFICATIONS.has(fact.classification)
    || !REASONS[fact.classification]?.has(fact.reasonCode)) {
    throw new LedgerFoldError("malformed_event", "Scope fact classification and reason are inconsistent.");
  }
  validateEvidence(fact.evidence);
  validateReasonEvidence(fact);
  if (fact.classification === "unplanned_support") {
    if (!isRecord(fact.support) || !nonEmpty(fact.support.microItemId)
      || !Number.isInteger(fact.support.observedMinutes) || fact.support.observedMinutes <= 0) {
      throw new LedgerFoldError("malformed_event", "Unplanned support requires a positive integer duration and micro-item ID.");
    }
  } else if (fact.support !== undefined) {
    throw new LedgerFoldError("malformed_event", "Only unplanned support facts may include support evidence.");
  }
}
function validateResetEvent(event: PrOpenedLedgerEvent): void {
  if (event.kind !== "pr_opened") {
    throw new LedgerFoldError("unsupported_event_kind", `Unsupported ledger event kind: ${String(event.kind)}.`);
  }
  if (!nonEmpty(event.verifiedDeliveryReceiptId)) {
    throw new LedgerFoldError("invalid_receipt", "PR-opened reset requires a non-empty verified delivery receipt ID.");
  }
}

interface DerivedLedger {
  totalSupportMinutes: number;
  microItemIds: string[];
  resets: ScopeLedgerReset[];
  historicalMicroItemIds: Set<string>;
  receiptIds: Set<string>;
}
function deriveEntries(entries: readonly ScopeLedgerEvent[], snapshotMode: boolean): DerivedLedger {
  let totalSupportMinutes = 0;
  let microItemIds: string[] = [];
  const resets: ScopeLedgerReset[] = [];
  const historicalMicroItemIds = new Set<string>();
  const receiptIds = new Set<string>();
  entries.forEach((entry, entryIndex) => {
    if (!isRecord(entry)) throw new LedgerFoldError(snapshotMode ? "invalid_snapshot" : "malformed_event", "Ledger entry must be an object.");
    if ("classification" in entry) {
      try { validateFact(entry as ScopeFact); } catch (error) {
        if (snapshotMode) throw new LedgerFoldError("invalid_snapshot", "Previous snapshot contains a malformed scope fact.");
        throw error;
      }
      const fact = entry as ScopeFact;
      if (fact.classification !== "unplanned_support") return;
      if (historicalMicroItemIds.has(fact.support.microItemId)) {
        throw new LedgerFoldError(snapshotMode ? "invalid_snapshot" : "duplicate_micro_item", `Duplicate micro-item ID: ${fact.support.microItemId}.`);
      }
      historicalMicroItemIds.add(fact.support.microItemId);
      totalSupportMinutes += fact.support.observedMinutes;
      microItemIds.push(fact.support.microItemId);
      return;
    }
    const reset = entry as PrOpenedLedgerEvent;
    try { validateResetEvent(reset); } catch (error) {
      if (snapshotMode) throw new LedgerFoldError("invalid_snapshot", "Previous snapshot contains an invalid reset event.");
      throw error;
    }
    if (receiptIds.has(reset.verifiedDeliveryReceiptId)) {
      throw new LedgerFoldError(snapshotMode ? "invalid_snapshot" : "duplicate_receipt", `Duplicate receipt ID: ${reset.verifiedDeliveryReceiptId}.`);
    }
    receiptIds.add(reset.verifiedDeliveryReceiptId);
    resets.push({
      entryIndex,
      verifiedDeliveryReceiptId: reset.verifiedDeliveryReceiptId,
      priorSupportMinutes: totalSupportMinutes,
      priorMicroItemIds: [...microItemIds],
    });
    totalSupportMinutes = 0;
    microItemIds = [];
  });
  return { totalSupportMinutes, microItemIds, resets, historicalMicroItemIds, receiptIds };
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function equalResets(left: readonly ScopeLedgerReset[], right: readonly ScopeLedgerReset[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const candidate = right[index];
    if (!isRecord(value) || !isRecord(candidate)
      || !Array.isArray(value.priorMicroItemIds) || !Array.isArray(candidate.priorMicroItemIds)) return false;
    return value.entryIndex === candidate.entryIndex
      && value.verifiedDeliveryReceiptId === candidate.verifiedDeliveryReceiptId
      && value.priorSupportMinutes === candidate.priorSupportMinutes
      && equalStrings(value.priorMicroItemIds, candidate.priorMicroItemIds);
  });
}
function validatePrevious(previous: ScopeLedgerSnapshot): DerivedLedger {
  if (!isRecord(previous) || !Array.isArray(previous.microItemIds)
    || !Array.isArray(previous.entries) || !Array.isArray(previous.resets)) {
    throw new LedgerFoldError("invalid_snapshot", "Previous scope ledger snapshot is malformed.");
  }
  const derived = deriveEntries(previous.entries, true);
  if (previous.totalSupportMinutes !== derived.totalSupportMinutes
    || !equalStrings(previous.microItemIds, derived.microItemIds)
    || !equalResets(previous.resets, derived.resets)) {
    throw new LedgerFoldError("invalid_snapshot", "Previous snapshot derived state does not match its append-only entries.");
  }
  return derived;
}

function threshold(value: number, limit: number): ScopeLedgerThresholdFact {
  return { value, threshold: limit, reached: value >= limit };
}
function facts(snapshot: ScopeLedgerSnapshot, thresholds: ScopeLedgerThresholds): ScopeLedgerFacts {
  return {
    supportMinutes: threshold(snapshot.totalSupportMinutes, thresholds.supportMinutes),
    microItems: threshold(snapshot.microItemIds.length, thresholds.microItems),
  };
}

export function foldScopeLedger(
  previousInput: ScopeLedgerSnapshot,
  eventInput: ScopeLedgerEvent,
  thresholdsInput: ScopeLedgerThresholds,
): ScopeLedgerFoldResult {
  validatePrevious(previousInput);
  if (!isRecord(thresholdsInput)) throw new LedgerFoldError("invalid_threshold", "Thresholds must be an object.");
  assertThreshold(thresholdsInput.supportMinutes, "thresholds.supportMinutes");
  assertThreshold(thresholdsInput.microItems, "thresholds.microItems");
  const previous = cloneLedgerInput(previousInput, "invalid_snapshot");
  const event = cloneLedgerInput(eventInput, "malformed_event");
  const entries = [...previous.entries, event];
  const derived = deriveEntries(entries, false);
  const snapshot: ScopeLedgerSnapshot = {
    totalSupportMinutes: derived.totalSupportMinutes,
    microItemIds: derived.microItemIds,
    entries,
    resets: derived.resets,
  };
  return { snapshot, facts: facts(snapshot, thresholdsInput) };
}

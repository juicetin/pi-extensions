import path from "node:path";

export type ScopeClassification = "in_scope" | "immediate_expansion" | "unplanned_support" | "ambiguous";
export type ExpansionTrigger = "architecture" | "trust_boundary" | "infra" | "deploy" | "auth" | "security" | "schema" | "external_dependency" | "acceptance_criteria";

export interface ScopePathGroup { readonly name: string; readonly canonicalRoot: string }
export interface ScopeChildSlice { readonly id: string; readonly pathGroups: readonly string[] }
export interface ScopeContract {
  readonly repositoryId: string;
  readonly repositoryIdentityProven: boolean;
  readonly canonicalRoot: string;
  readonly domains: readonly string[];
  readonly pathGroups: readonly ScopePathGroup[];
  readonly exclusions: readonly string[];
  readonly childSlices?: readonly ScopeChildSlice[];
}
export interface ScopePathEvidence { readonly pathGroup: string; readonly requestedPath: string; readonly canonicalPath?: string }
export interface IncidentalSupport { microItemId: string; observedMinutes: number }
interface TargetBase {
  readonly repositoryId?: string;
  readonly repositoryIdentityProven: boolean;
  readonly domain: string;
  readonly expansionTriggers?: readonly ExpansionTrigger[];
  readonly incidentalSupport?: IncidentalSupport;
}
export interface StructuredPathTarget extends TargetBase, ScopePathEvidence { readonly kind: "path" }
export interface ShellTarget extends TargetBase { readonly kind: "shell"; readonly command: string; readonly writeRoots?: readonly ScopePathEvidence[] }
export interface ChildTarget extends TargetBase { readonly kind: "child"; readonly childSliceId?: string; readonly paths?: readonly ScopePathEvidence[] }
export type ScopeTarget = StructuredPathTarget | ShellTarget | ChildTarget;

export type ScopeReasonCode =
  | "declared_scope" | "bounded_incidental_support"
  | "repository_unproven" | "missing_canonical_evidence" | "shell_write_roots_unproven" | "child_slice_unregistered" | "child_paths_unbounded"
  | "different_repository" | "lexical_escape" | "path_group_escape" | "canonical_escape" | "excluded_path" | "undeclared_domain"
  | "architecture_change" | "trust_boundary_change" | "infra_change" | "deploy_change" | "auth_change" | "security_change" | "schema_change" | "external_dependency_change" | "acceptance_criteria_change";

export interface ScopeEvidence {
  readonly kind: ScopeTarget["kind"];
  readonly repositoryId?: string;
  readonly domain: string;
  readonly pathGroup?: string;
  readonly childSliceId?: string;
  readonly requestedPaths: readonly string[];
  readonly canonicalPaths: readonly string[];
}
interface BasicScopeFact { readonly classification: Exclude<ScopeClassification, "unplanned_support">; readonly reasonCode: ScopeReasonCode; readonly evidence: ScopeEvidence; readonly support?: never }
export interface SupportScopeFact { readonly classification: "unplanned_support"; readonly reasonCode: "bounded_incidental_support"; readonly evidence: ScopeEvidence; readonly support: IncidentalSupport }
export type ScopeFact = BasicScopeFact | SupportScopeFact;

export type ScopeClassificationErrorCode = "invalid_identity" | "invalid_absolute_path" | "duplicate_domain" | "duplicate_path_group" | "invalid_path_group" | "invalid_exclusion" | "invalid_target_kind" | "invalid_trigger" | "invalid_support" | "contradictory_evidence";
export class ScopeClassificationError extends Error {
  readonly code: ScopeClassificationErrorCode;
  constructor(code: ScopeClassificationErrorCode, message: string) { super(message); this.name = "ScopeClassificationError"; this.code = code; }
}

const TRIGGERS = new Set<ExpansionTrigger>(["architecture", "trust_boundary", "infra", "deploy", "auth", "security", "schema", "external_dependency", "acceptance_criteria"]);
const triggerReason: Record<ExpansionTrigger, ScopeReasonCode> = {
  architecture: "architecture_change", trust_boundary: "trust_boundary_change", infra: "infra_change", deploy: "deploy_change", auth: "auth_change",
  security: "security_change", schema: "schema_change", external_dependency: "external_dependency_change", acceptance_criteria: "acceptance_criteria_change",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cloneScopeInput<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new ScopeClassificationError("contradictory_evidence", "Scope input must contain cloneable data values.");
  }
}
function identity(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new ScopeClassificationError("invalid_identity", `${field} must be a non-empty string.`);
}
function absolute(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new ScopeClassificationError("invalid_absolute_path", `${field} must be absolute.`);
}
function normalized(value: string): string { return path.normalize(value); }
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function validateUnique(values: readonly string[], duplicateCode: "duplicate_domain" | "duplicate_path_group", field: string): void {
  const seen = new Set<string>();
  for (const value of values) { identity(value, field); if (seen.has(value)) throw new ScopeClassificationError(duplicateCode, `Duplicate ${field}: ${value}.`); seen.add(value); }
}

function validateContract(contract: ScopeContract): ScopeContract {
  if (!isRecord(contract)) throw new ScopeClassificationError("contradictory_evidence", "Scope contract must be an object.");
  const copy = cloneScopeInput(contract);
  identity(copy.repositoryId, "contract.repositoryId");
  if (copy.repositoryIdentityProven !== true) throw new ScopeClassificationError("contradictory_evidence", "Scope contract repository identity must be proven.");
  absolute(copy.canonicalRoot, "contract.canonicalRoot");
  if (!Array.isArray(copy.domains) || !Array.isArray(copy.pathGroups) || !Array.isArray(copy.exclusions)) throw new ScopeClassificationError("contradictory_evidence", "Scope contract collections are required.");
  validateUnique(copy.domains, "duplicate_domain", "domain");
  for (const group of copy.pathGroups) {
    if (!isRecord(group)) throw new ScopeClassificationError("contradictory_evidence", "Path groups must be objects.");
  }
  validateUnique(copy.pathGroups.map((group) => group.name), "duplicate_path_group", "path group");
  for (const group of copy.pathGroups) {
    absolute(group.canonicalRoot, `pathGroups.${group.name}.canonicalRoot`);
    if (!within(normalized(copy.canonicalRoot), normalized(group.canonicalRoot))) throw new ScopeClassificationError("invalid_path_group", `Path group ${group.name} escapes the repository.`);
  }
  for (const exclusion of copy.exclusions) {
    absolute(exclusion, "contract.exclusion");
    if (!within(normalized(copy.canonicalRoot), normalized(exclusion))) throw new ScopeClassificationError("invalid_exclusion", "Exclusion escapes the repository.");
  }
  if (copy.childSlices !== undefined && !Array.isArray(copy.childSlices)) {
    throw new ScopeClassificationError("contradictory_evidence", "childSlices must be an array.");
  }
  const childIds = new Set<string>();
  for (const child of copy.childSlices ?? []) {
    if (!isRecord(child) || !Array.isArray(child.pathGroups)) {
      throw new ScopeClassificationError("contradictory_evidence", "Child slices require an ID and pathGroups array.");
    }
    identity(child.id, "childSlice.id");
    if (childIds.has(child.id)) throw new ScopeClassificationError("contradictory_evidence", `Duplicate child slice: ${child.id}.`);
    childIds.add(child.id);
    for (const group of child.pathGroups) if (!copy.pathGroups.some(({ name }) => name === group)) throw new ScopeClassificationError("invalid_path_group", `Child slice references unknown path group ${group}.`);
  }
  return copy;
}

function validatePathEvidenceShape(entry: ScopePathEvidence): void {
  if (!isRecord(entry)) throw new ScopeClassificationError("contradictory_evidence", "Path evidence must be an object.");
  identity(entry.pathGroup, "path.pathGroup");
  absolute(entry.requestedPath, "path.requestedPath");
  if (entry.canonicalPath !== undefined) absolute(entry.canonicalPath, "path.canonicalPath");
}

function validateTarget(target: ScopeTarget): ScopeTarget {
  if (!isRecord(target)) throw new ScopeClassificationError("contradictory_evidence", "Scope target must be an object.");
  const copy = cloneScopeInput(target);
  if (!(["path", "shell", "child"] as readonly unknown[]).includes(copy.kind)) throw new ScopeClassificationError("invalid_target_kind", `Unknown scope target kind: ${String(copy.kind)}.`);
  if (typeof copy.repositoryIdentityProven !== "boolean") throw new ScopeClassificationError("contradictory_evidence", "repositoryIdentityProven must be boolean.");
  if (copy.repositoryId !== undefined) identity(copy.repositoryId, "target.repositoryId");
  if (copy.repositoryIdentityProven && copy.repositoryId === undefined) throw new ScopeClassificationError("contradictory_evidence", "Proven repository evidence requires repositoryId.");
  identity(copy.domain, "target.domain");
  if (copy.expansionTriggers !== undefined && !Array.isArray(copy.expansionTriggers)) {
    throw new ScopeClassificationError("contradictory_evidence", "expansionTriggers must be an array.");
  }
  for (const trigger of copy.expansionTriggers ?? []) if (!TRIGGERS.has(trigger)) throw new ScopeClassificationError("invalid_trigger", `Unknown expansion trigger: ${String(trigger)}.`);
  if (copy.incidentalSupport !== undefined) {
    if (!isRecord(copy.incidentalSupport)) throw new ScopeClassificationError("contradictory_evidence", "incidentalSupport must be an object.");
    identity(copy.incidentalSupport.microItemId, "incidentalSupport.microItemId");
    if (!Number.isInteger(copy.incidentalSupport.observedMinutes) || copy.incidentalSupport.observedMinutes <= 0) throw new ScopeClassificationError("invalid_support", "observedMinutes must be a positive integer.");
    if ((copy.expansionTriggers?.length ?? 0) > 0) throw new ScopeClassificationError("contradictory_evidence", "Incidental support cannot also claim an expansion trigger.");
  }
  if (copy.kind === "path") validatePathEvidenceShape(copy);
  if (copy.kind === "shell") {
    identity(copy.command, "target.command");
    if (copy.writeRoots !== undefined && !Array.isArray(copy.writeRoots)) {
      throw new ScopeClassificationError("contradictory_evidence", "Shell writeRoots must be an array.");
    }
    copy.writeRoots?.forEach(validatePathEvidenceShape);
  }
  if (copy.kind === "child") {
    if (copy.childSliceId !== undefined) identity(copy.childSliceId, "target.childSliceId");
    if (copy.paths !== undefined && !Array.isArray(copy.paths)) {
      throw new ScopeClassificationError("contradictory_evidence", "Child paths must be an array.");
    }
    copy.paths?.forEach(validatePathEvidenceShape);
  }
  return copy;
}

function evidence(target: ScopeTarget, paths: readonly ScopePathEvidence[]): ScopeEvidence {
  const descriptors = target as ScopeTarget & { readonly pathGroup?: string; readonly childSliceId?: string };
  return {
    kind: target.kind,
    repositoryId: target.repositoryId,
    domain: target.domain,
    pathGroup: descriptors.pathGroup,
    childSliceId: descriptors.childSliceId,
    requestedPaths: paths.map((entry) => normalized(entry.requestedPath)),
    canonicalPaths: paths.flatMap((entry) => entry.canonicalPath === undefined ? [] : [normalized(entry.canonicalPath)]),
  };
}
function basic(classification: BasicScopeFact["classification"], reasonCode: ScopeReasonCode, target: ScopeTarget, paths: readonly ScopePathEvidence[]): ScopeFact {
  return { classification, reasonCode, evidence: evidence(target, paths) };
}

function inspectPaths(contract: ScopeContract, target: ScopeTarget, paths: readonly ScopePathEvidence[], exactRoots: boolean, allowedGroups?: ReadonlySet<string>): ScopeFact | undefined {
  const repoRoot = normalized(contract.canonicalRoot);
  for (const entry of paths) {
    validatePathEvidenceShape(entry);
    const group = contract.pathGroups.find(({ name }) => name === entry.pathGroup);
    if (group === undefined || (allowedGroups !== undefined && !allowedGroups.has(entry.pathGroup))) return basic("immediate_expansion", "path_group_escape", target, paths);
    const requested = normalized(entry.requestedPath);
    const groupRoot = normalized(group.canonicalRoot);
    if (!within(repoRoot, requested)) return basic("immediate_expansion", "lexical_escape", target, paths);
    if (!within(groupRoot, requested) || (exactRoots && requested !== groupRoot)) return basic("immediate_expansion", "path_group_escape", target, paths);
    if (entry.canonicalPath === undefined) return basic("ambiguous", "missing_canonical_evidence", target, paths);
    absolute(entry.canonicalPath, "path.canonicalPath");
    const canonical = normalized(entry.canonicalPath);
    if (!within(repoRoot, canonical) || !within(groupRoot, canonical) || (exactRoots && canonical !== groupRoot)) return basic("immediate_expansion", "canonical_escape", target, paths);
    if (contract.exclusions.some((excluded) => {
      const exclusion = normalized(excluded);
      return within(exclusion, requested)
        || within(exclusion, canonical)
        || (exactRoots && (within(requested, exclusion) || within(canonical, exclusion)));
    })) return basic("immediate_expansion", "excluded_path", target, paths);
  }
  return undefined;
}

export function classifyScopeDelta(contractInput: ScopeContract, targetInput: ScopeTarget): ScopeFact {
  const contract = validateContract(contractInput);
  const target = validateTarget(targetInput);
  const paths: readonly ScopePathEvidence[] = target.kind === "path" ? [target] : target.kind === "shell" ? (target.writeRoots ?? []) : (target.paths ?? []);
  if (!target.repositoryIdentityProven || target.repositoryId === undefined) return basic("ambiguous", "repository_unproven", target, paths);
  if (target.repositoryId !== contract.repositoryId) return basic("immediate_expansion", "different_repository", target, paths);
  if (!contract.domains.includes(target.domain)) return basic("immediate_expansion", "undeclared_domain", target, paths);
  const trigger = target.expansionTriggers?.[0];
  if (trigger !== undefined) return basic("immediate_expansion", triggerReason[trigger], target, paths);
  if (target.kind === "shell" && (target.writeRoots === undefined || target.writeRoots.length === 0)) return basic("ambiguous", "shell_write_roots_unproven", target, paths);
  let allowedGroups: ReadonlySet<string> | undefined;
  if (target.kind === "child") {
    if (target.childSliceId === undefined) return basic("ambiguous", "child_slice_unregistered", target, paths);
    const slice = contract.childSlices?.find(({ id }) => id === target.childSliceId);
    if (slice === undefined) return basic("ambiguous", "child_slice_unregistered", target, paths);
    if (target.paths === undefined || target.paths.length === 0) return basic("ambiguous", "child_paths_unbounded", target, paths);
    allowedGroups = new Set(slice.pathGroups);
  }
  const pathFact = inspectPaths(contract, target, paths, target.kind === "shell", allowedGroups);
  if (pathFact !== undefined) return pathFact;
  if (target.incidentalSupport !== undefined) return { classification: "unplanned_support", reasonCode: "bounded_incidental_support", evidence: evidence(target, paths), support: cloneScopeInput(target.incidentalSupport) };
  return basic("in_scope", "declared_scope", target, paths);
}

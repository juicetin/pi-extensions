import assert from "node:assert/strict";
import test from "node:test";

import {
  ScopeClassificationError,
  classifyScopeDelta,
  type ScopeContract,
  type ScopeTarget,
} from "./scope.ts";

const contract: ScopeContract = {
  repositoryId: "repo-1",
  repositoryIdentityProven: true,
  canonicalRoot: "/work/repo",
  domains: ["guardian"],
  pathGroups: [{ name: "auth", canonicalRoot: "/work/repo/src/auth" }],
  exclusions: ["/work/repo/src/auth/generated"],
  childSlices: [{ id: "child-1", pathGroups: ["auth"] }],
};

const pathTarget = (overrides: Partial<Extract<ScopeTarget, { kind: "path" }>> = {}): Extract<ScopeTarget, { kind: "path" }> => ({
  kind: "path",
  repositoryId: "repo-1",
  repositoryIdentityProven: true,
  domain: "guardian",
  pathGroup: "auth",
  requestedPath: "/work/repo/src/auth/file.ts",
  canonicalPath: "/work/repo/src/auth/file.ts",
  ...overrides,
});

function expectScopeError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ScopeClassificationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("classifies exact declared path evidence without making a decision", () => {
  assert.deepEqual(classifyScopeDelta(contract, pathTarget()), {
    classification: "in_scope",
    reasonCode: "declared_scope",
    evidence: {
      kind: "path", repositoryId: "repo-1", domain: "guardian", pathGroup: "auth", childSliceId: undefined,
      requestedPaths: ["/work/repo/src/auth/file.ts"], canonicalPaths: ["/work/repo/src/auth/file.ts"],
    },
  });
});

test("detects lexical, sibling-prefix, and canonical symlink escapes", () => {
  const cases: Array<[Partial<Extract<ScopeTarget, { kind: "path" }>>, string]> = [
    [{ requestedPath: "/work/repo/src/auth/../../../outside", canonicalPath: "/outside" }, "lexical_escape"],
    [{ requestedPath: "/work/repo/src/auth-old/file.ts", canonicalPath: "/work/repo/src/auth-old/file.ts" }, "path_group_escape"],
    [{ canonicalPath: "/work/other/file.ts" }, "canonical_escape"],
  ];
  for (const [overrides, reasonCode] of cases) {
    const fact = classifyScopeDelta(contract, pathTarget(overrides));
    assert.equal(fact.classification, "immediate_expansion");
    assert.equal(fact.reasonCode, reasonCode);
  }
  assert.equal(classifyScopeDelta(contract, pathTarget({
    canonicalPath: "/work/repo/src/auth/real-file.ts",
  })).classification, "in_scope");
  assert.equal(classifyScopeDelta(contract, pathTarget({
    requestedPath: "/work/repo/src/auth/generated/link.ts",
    canonicalPath: "/work/repo/src/auth/real-file.ts",
  })).reasonCode, "excluded_path");
});

test("returns ambiguity for missing proof and unbounded shell or child targets", () => {
  const missingCanonical = classifyScopeDelta(contract, pathTarget({ canonicalPath: undefined }));
  assert.equal(missingCanonical.reasonCode, "missing_canonical_evidence");
  assert.deepEqual(missingCanonical.evidence.canonicalPaths, []);
  assert.equal(classifyScopeDelta(contract, {
    kind: "shell", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", command: "npm test",
  }).reasonCode, "shell_write_roots_unproven");
  assert.equal(classifyScopeDelta(contract, {
    kind: "child", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", childSliceId: "unknown", paths: [],
  }).reasonCode, "child_slice_unregistered");
  assert.equal(classifyScopeDelta(contract, {
    kind: "child", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", paths: [],
  }).reasonCode, "child_slice_unregistered");
  assert.equal(classifyScopeDelta(contract, {
    kind: "child", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", childSliceId: "child-1",
  }).reasonCode, "child_paths_unbounded");
  assert.equal(classifyScopeDelta(contract, pathTarget({ repositoryIdentityProven: false })).reasonCode, "repository_unproven");
});

test("classifies exact shell write roots and registered bounded child paths", () => {
  const root = { pathGroup: "auth", requestedPath: "/work/repo/src/auth", canonicalPath: "/work/repo/src/auth" };
  const openContract = { ...contract, exclusions: [] };
  const shell = classifyScopeDelta(openContract, {
    kind: "shell", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", command: "formatter", writeRoots: [root],
  });
  const child = classifyScopeDelta(openContract, {
    kind: "child", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", childSliceId: "child-1", paths: [root],
  });
  assert.equal(shell.classification, "in_scope");
  assert.deepEqual(shell.evidence, {
    kind: "shell", repositoryId: "repo-1", domain: "guardian", pathGroup: undefined, childSliceId: undefined,
    requestedPaths: ["/work/repo/src/auth"], canonicalPaths: ["/work/repo/src/auth"],
  });
  assert.equal(child.classification, "in_scope");
  assert.equal(child.evidence.childSliceId, "child-1");
  assert.equal(classifyScopeDelta(contract, {
    kind: "shell", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", command: "formatter", writeRoots: [root],
  }).reasonCode, "excluded_path");
});

test("enforces selected path groups, child group bounds, exact shell roots, and both exclusion directions", () => {
  const multiContract: ScopeContract = {
    ...contract,
    pathGroups: [
      ...contract.pathGroups,
      { name: "billing", canonicalRoot: "/work/repo/src/billing" },
    ],
  };
  assert.equal(classifyScopeDelta(multiContract, pathTarget({
    pathGroup: "billing",
    requestedPath: "/work/repo/src/billing/file.ts",
    canonicalPath: "/work/repo/src/billing/file.ts",
  })).classification, "in_scope");
  assert.equal(classifyScopeDelta(contract, pathTarget({ pathGroup: "missing" })).reasonCode, "path_group_escape");
  assert.equal(classifyScopeDelta(multiContract, {
    kind: "child", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", childSliceId: "child-1",
    paths: [{ pathGroup: "billing", requestedPath: "/work/repo/src/billing", canonicalPath: "/work/repo/src/billing" }],
  }).reasonCode, "path_group_escape");
  assert.equal(classifyScopeDelta({ ...contract, exclusions: [] }, {
    kind: "shell", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", command: "x",
    writeRoots: [{ pathGroup: "auth", requestedPath: "/work/repo/src/auth/file.ts", canonicalPath: "/work/repo/src/auth/file.ts" }],
  }).reasonCode, "path_group_escape");
  assert.equal(classifyScopeDelta(contract, pathTarget({
    canonicalPath: "/work/repo/src/other/file.ts",
  })).reasonCode, "canonical_escape");
  assert.equal(classifyScopeDelta({ ...contract, exclusions: [] }, {
    kind: "shell", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", command: "x",
    writeRoots: [{ pathGroup: "auth", requestedPath: "/work/repo/src/auth", canonicalPath: "/work/repo/src/auth/real" }],
  }).reasonCode, "canonical_escape");
  assert.equal(classifyScopeDelta(contract, pathTarget({
    requestedPath: "/work/repo/src/auth/safe.ts",
    canonicalPath: "/work/repo/src/auth/generated/real.ts",
  })).reasonCode, "excluded_path");
});

test("maps every immediate trigger and repository/domain/exclusion violations", () => {
  const triggers = ["architecture", "trust_boundary", "infra", "deploy", "auth", "security", "schema", "external_dependency", "acceptance_criteria"] as const;
  for (const trigger of triggers) {
    const fact = classifyScopeDelta(contract, pathTarget({ expansionTriggers: [trigger] }));
    assert.equal(fact.classification, "immediate_expansion");
    assert.equal(fact.reasonCode, `${trigger}_change`);
  }
  assert.equal(classifyScopeDelta(contract, pathTarget({ repositoryId: "repo-2" })).reasonCode, "different_repository");
  assert.equal(classifyScopeDelta(contract, pathTarget({ domain: "billing" })).reasonCode, "undeclared_domain");
  assert.equal(classifyScopeDelta(contract, pathTarget({ requestedPath: "/work/repo/src/auth/generated/x.ts", canonicalPath: "/work/repo/src/auth/generated/x.ts" })).reasonCode, "excluded_path");
});

test("classifies bounded incidental support with copied normalized evidence", () => {
  const target = pathTarget({ incidentalSupport: { observedMinutes: 3, microItemId: "micro-1" } });
  const fact = classifyScopeDelta(contract, target);
  assert.equal(fact.classification, "unplanned_support");
  assert.equal(fact.reasonCode, "bounded_incidental_support");
  assert.deepEqual(fact.support, { observedMinutes: 3, microItemId: "micro-1" });
  if (target.incidentalSupport === undefined) throw new Error("Expected support evidence");
  target.incidentalSupport.observedMinutes = 99;
  assert.equal(fact.support?.observedMinutes, 3);
});

test("validates repository collections, path groups, exclusions, and child declarations", () => {
  assert.equal(classifyScopeDelta({ ...contract, childSlices: undefined }, pathTarget()).classification, "in_scope");
  expectScopeError(() => classifyScopeDelta({
    ...contract, repositoryIdentityProven: false,
  }, pathTarget()), "contradictory_evidence");
  for (const field of ["domains", "pathGroups", "exclusions"] as const) {
    expectScopeError(() => classifyScopeDelta({
      ...contract, [field]: 1,
    } as unknown as ScopeContract, pathTarget()), "contradictory_evidence");
  }
  expectScopeError(() => classifyScopeDelta({
    ...contract, pathGroups: [null],
  } as unknown as ScopeContract, pathTarget()), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta({
    ...contract, pathGroups: [{ name: "outside", canonicalRoot: "/work/other" }],
  }, pathTarget()), "invalid_path_group");
  expectScopeError(() => classifyScopeDelta({
    ...contract, exclusions: ["/work/other"],
  }, pathTarget()), "invalid_exclusion");
  expectScopeError(() => classifyScopeDelta({
    ...contract, childSlices: [null],
  } as unknown as ScopeContract, pathTarget()), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta({
    ...contract, childSlices: [{ id: "child", pathGroups: 1 }],
  } as unknown as ScopeContract, pathTarget()), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta({
    ...contract, childSlices: [{ id: "child-1", pathGroups: ["auth"] }, { id: "child-1", pathGroups: ["auth"] }],
  }, pathTarget()), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta({
    ...contract, childSlices: [{ id: "child", pathGroups: ["missing"] }],
  }, pathTarget()), "invalid_path_group");
  expectScopeError(() => classifyScopeDelta(contract, {
    kind: "shell", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", command: "x", writeRoots: [null],
  } as unknown as ScopeTarget), "contradictory_evidence");
});

test("rejects malformed and contradictory scope evidence with typed errors", () => {
  expectScopeError(() => classifyScopeDelta(null as unknown as ScopeContract, pathTarget()), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(contract, null as unknown as ScopeTarget), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(42 as unknown as ScopeContract, pathTarget()), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta({ ...contract, repositoryId: 42 } as unknown as ScopeContract, pathTarget()), "invalid_identity");
  expectScopeError(() => classifyScopeDelta({ ...contract, canonicalRoot: 42 } as unknown as ScopeContract, pathTarget()), "invalid_absolute_path");
  expectScopeError(() => classifyScopeDelta({ ...contract, repositoryId: " " }, pathTarget()), "invalid_identity");
  expectScopeError(() => classifyScopeDelta({ ...contract, canonicalRoot: "relative" }, pathTarget()), "invalid_absolute_path");
  expectScopeError(() => classifyScopeDelta({ ...contract, domains: ["guardian", "guardian"] }, pathTarget()), "duplicate_domain");
  expectScopeError(() => classifyScopeDelta({ ...contract, pathGroups: [...contract.pathGroups, contract.pathGroups[0]] }, pathTarget()), "duplicate_path_group");
  expectScopeError(() => classifyScopeDelta(contract, pathTarget({ incidentalSupport: { observedMinutes: 1.5, microItemId: "micro" } })), "invalid_support");
  expectScopeError(() => classifyScopeDelta(contract, pathTarget({ incidentalSupport: { observedMinutes: 0, microItemId: "micro" } })), "invalid_support");
  expectScopeError(() => classifyScopeDelta(contract, {
    ...pathTarget(), repositoryIdentityProven: "yes",
  } as unknown as ScopeTarget), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(contract, {
    ...pathTarget(), repositoryId: 42,
  } as unknown as ScopeTarget), "invalid_identity");
  expectScopeError(() => classifyScopeDelta(contract, {
    ...pathTarget(), repositoryId: undefined,
  }), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(contract, {
    ...pathTarget(), expansionTriggers: ["unknown"],
  } as unknown as ScopeTarget), "invalid_trigger");
  expectScopeError(() => classifyScopeDelta(contract, {
    ...pathTarget(), incidentalSupport: 1,
  } as unknown as ScopeTarget), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(contract, pathTarget({ requestedPath: "relative" })), "invalid_absolute_path");
  expectScopeError(() => classifyScopeDelta(contract, {
    kind: "shell", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", command: " ", writeRoots: [],
  }), "invalid_identity");
  expectScopeError(() => classifyScopeDelta(contract, {
    kind: "shell", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", command: "x", writeRoots: 1,
  } as unknown as ScopeTarget), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(contract, {
    kind: "child", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", childSliceId: 1, paths: [],
  } as unknown as ScopeTarget), "invalid_identity");
  expectScopeError(() => classifyScopeDelta(contract, pathTarget({ expansionTriggers: ["security"], incidentalSupport: { observedMinutes: 1, microItemId: "micro" } })), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(contract, {
    kind: "child", repositoryId: "repo-1", repositoryIdentityProven: true, domain: "guardian", childSliceId: "child-1", paths: 1,
  } as unknown as ScopeTarget), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(contract, {
    ...pathTarget(), expansionTriggers: "security",
  } as unknown as ScopeTarget), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta({
    ...contract, childSlices: 1,
  } as unknown as ScopeContract, pathTarget()), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta({
    ...contract, domains: [Symbol("bad")],
  } as unknown as ScopeContract, pathTarget()), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(contract, {
    ...pathTarget(), domain: (() => "guardian"),
  } as unknown as ScopeTarget), "contradictory_evidence");
  expectScopeError(() => classifyScopeDelta(contract, {
    ...pathTarget(), kind: "unknown",
  } as unknown as ScopeTarget), "invalid_target_kind");
  assert.equal(classifyScopeDelta(contract, pathTarget({
    requestedPath: "/work/repo/src",
    canonicalPath: "/work/repo/src",
  })).reasonCode, "path_group_escape");
});

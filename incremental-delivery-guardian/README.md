# Incremental Delivery Guardian

The guardian reports delivery cadence and scope growth without intercepting implementation tools.

## Behavior

A client registers a versioned delivery slice through `incremental-delivery-guardian:register`. The slice names its repository, owner, outcome, acceptance criteria, Beads task, branch and base, domains, path groups, exclusions, verification plan, risk class, and dependencies.

The guardian returns registration results on `incremental-delivery-guardian:registration-result`. Reviewer, provider, and audit integrations are not registration prerequisites.

Clients send normalized clock, scope, ledger, and component facts through `incremental-delivery-guardian:observe`. Results arrive on `incremental-delivery-guardian:telemetry` and contain:

- cadence and scope facts;
- `normal`, `nudge`, `review_requested`, or `telemetry_unavailable` outcomes;
- stable reason codes;
- optional review intent;
- compact audit intent;
- `mutationEffect: "unchanged"`.

Component failures stay visible in telemetry. They do not change tool input, replace `user_bash` operations, issue delivery receipts, or authorize provider actions.

## Pi hooks

The extension subscribes to `tool_call` and `user_bash` for metadata-only operation events. Both handlers return without an interception result. Tool arguments and shell operations continue through Pi's original execution path.

Observation work is queued after the hook returns. Telemetry contains operation identifiers, tool names, registration identifiers, and advisory facts. It does not contain raw tool input, shell command text, or a mutation envelope.

## Protected worktrees

The following worktrees and their descendants receive no registration or observation capability:

- `/data/repos/corto-spike/.worktrees/bd-corto-4d2m-branch-mcp-infrastructure`
- `/data/repos/corto-spike/.worktrees/bd-corto-prod-lawconnect-downstream-enable`

The check is lexical. The extension does not inspect, resolve through the filesystem, call a provider for, or write either path.

## Package loading

The root `package.json` registers `./incremental-delivery-guardian/index.ts` in `pi.extensions`. Pi loads the TypeScript source through its package loader. Runtime dependencies are declared in `dependencies`; Pi core packages remain peer dependencies.

Install or update the containing `pi-extensions` package through Pi's normal package commands. Registration of the source package does not install machine-wide rollout configuration. Rollout remains a separate approved task with read-back, canary, and rollback evidence.

## Event payload example

```ts
pi.events.emit("incremental-delivery-guardian:register", {
  schemaVersion: 1,
  registrationId: "guardian-task-1",
  repositoryId: "owner/repository",
  repositoryRoot: "/absolute/repository/root",
  ownerId: "agent-owner",
  outcome: "deliver one reviewable slice",
  acceptanceCriteria: ["focused tests pass"],
  beadId: "repo-123",
  branch: "bd-repo-123",
  baseRef: "main",
  domains: ["guardian"],
  pathGroups: [{ name: "source", roots: ["src/guardian"] }],
  exclusions: ["node_modules"],
  verificationPlan: ["npm test"],
  riskClass: "policy_change",
  dependencies: [],
});
```

Consumers should persist only privacy-filtered G7 audit records and compact evidence references. Raw transcripts, credentials, tool payloads, and shell commands do not belong in guardian evidence.

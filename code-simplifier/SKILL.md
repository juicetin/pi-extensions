---
name: code-simplifier
description: Simplify task-owned changed code without changing behavior. Use when asked to simplify, clean up, reduce complexity, or improve readability, and after meaningful implementation that changes logic, control flow, APIs, state, error handling, or several related files. Skip trivial and non-code changes.
---

# Code Simplifier

Make code easier to understand without changing what it does. Work in the current writer context. Do not launch a writer subagent.

## Activation

Use this skill when:

- the user asks to simplify, clean up, or reduce complexity;
- an active workflow requests a post-implementation simplification pass; or
- meaningful implementation changed logic, control flow, public or internal APIs, state transitions, error handling, or several related files.

Use only a lightweight self-check for documentation, formatting, generated files, simple configuration, and trivial one-line changes. Do not load a full cleanup workflow for those changes.

A no-op is a successful result when the code is already clear.

## Preconditions

1. Fix the scope to changes owned by the current task. Use explicitly named files, paths, or revisions when supplied. Never include unrelated or pre-existing worktree changes.
2. Stop without editing if task ownership is unclear. State which files or hunks are ambiguous.
3. Read the repository instructions and nearby code before judging local conventions.
4. Identify a meaningful deterministic validation command that currently passes. Existing fresh evidence from the implementation may serve as the baseline. Otherwise run the command before editing.
5. If no meaningful validation exists, review and report opportunities only. Do not mutate code unless the user explicitly accepts the stated validation risk.

## Preserve Exactly

Do not change:

- inputs, outputs, public contracts, or serialization;
- error types, messages relied on by callers, failure timing, or fallback behavior;
- side effects, ordering, concurrency, retries, timeouts, or transaction boundaries;
- authorization, privacy, security, logging, metrics, or operational guards;
- performance-sensitive characteristics without measured evidence and explicit scope;
- tests merely to make a simplification pass.

Do not add dependencies, speculative configuration, compatibility layers, or new abstractions. Do not optimize for fewer lines.

## Simplification Pass

1. Inspect only the fixed scope. When the opportunities are not obvious, read `references/simplification-signals.md` once.
2. Find concrete comprehension costs introduced or exposed by the task: avoidable nesting, misleading names, dense transforms, redundant wrappers, speculative abstractions, task-created dead code, or duplication whose removal reduces total complexity.
3. Apply only high-confidence local edits. Prefer explicit code and existing repository patterns.
4. Keep helpful abstractions that name a real concept, isolate a boundary, preserve testability, or reduce change amplification.
5. Report ambiguous architectural, API, performance, or cross-module opportunities. Do not apply them.
6. Rerun the same meaningful validation used for the baseline. Add broader checks only when the simplification touches a shared contract.
7. If validation fails, revert the simplification rather than changing behavior or weakening tests.
8. Compare before and after. Keep an edit only when the result is clearly easier to understand and the diff remains scoped.

## Stop Conditions

Stop and report instead of editing when:

- task-owned scope cannot be isolated;
- current behavior or the reason for an abstraction is not understood;
- behavior parity cannot be tested meaningfully;
- the change needs a public-contract decision, redesign, migration, or new dependency;
- simplification would widen the approved task; or
- the code is already clear.

## Report

Return:

- **Scope:** task-owned files or revision range reviewed;
- **Baseline:** command and passing result used before edits;
- **Simplifications:** applied edits, or `No changes needed`;
- **Deferred suggestions:** ambiguous or out-of-scope opportunities, if any;
- **Validation:** the repeated command and result;
- **Residual risk:** only concrete unverified behavior or assumptions.

Do not claim behavior preservation without the before-and-after validation evidence.

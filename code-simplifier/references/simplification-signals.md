# Simplification signals

Read this only when the scoped diff needs a deeper simplification pass. These are prompts for judgment, not automatic rewrite rules.

## Good candidates

- Replace avoidable nesting with clear guard clauses or direct branches.
- Name dense transformations or conditions when the name removes mental work.
- Remove wrappers that add no policy, validation, translation, lifecycle, or test seam.
- Remove speculative factories, strategies, configuration, and extension points with no current use.
- Remove dead code, imports, branches, and comments created by the current task.
- Consolidate task-created duplication when one local implementation reduces total complexity.
- Replace misleading, generic, or abbreviated names with names used by the surrounding domain.
- Remove comments that repeat the code. Keep comments that explain constraints, intent, external behavior, or a non-obvious reason.
- Prefer existing local helpers and patterns when reuse makes the change easier to follow.
- Keep related behavior close when indirection does not hide meaningful complexity.

## False simplifications

Do not treat these as improvements without concrete evidence:

- fewer lines;
- clever expressions, dense chains, or nested ternaries;
- merging functions with different responsibilities;
- extracting a one-use helper that does not name a useful concept;
- replacing readable duplication with a generic abstraction;
- removing validation, error handling, telemetry, or operational checks;
- changing sync and async behavior;
- changing data structures or algorithms on intuition alone;
- renaming across unrelated files for personal preference;
- converting code to a fashionable pattern that the repository does not use;
- broad cleanup around the task;
- modifying tests so changed behavior appears equivalent.

## Questions before an edit

1. What concrete mental step does this edit remove?
2. Why does the current code exist in this form?
3. Does the edit preserve outputs, failures, side effects, ordering, and contracts?
4. Does nearby code support the proposed pattern?
5. Can the same validation prove the behavior before and after?
6. Is the edit owned by the current task?
7. Would reverting the edit leave the task fully correct?

If the answers are unclear, report the opportunity instead of applying it.

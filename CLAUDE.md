# Claude project instructions

Follow `AGENTS.md` for repository workflow, Beads tracking, worktree isolation, delivery evidence, and session completion.

The project SessionStart hook runs `bd prime --hook-json` to load current Beads context. This is advisory context injection, not scope or delivery enforcement.

Before implementation:

```bash
bd where
bd context
bd ready --json
bd show <id>
```

Implement only in the bead's `bd-<id>` worktree. Cross-repository changes require a leaf bead, branch, `bd worktree create` worktree, and PR in the repository that owns the changed files. Do not edit `main`, create a root feature branch, use raw `git worktree add`, or disturb dirty root files.

A leaf is not complete until its tests pass, its branch is pushed, a correctly based PR exists, evidence is recorded on the bead, and Beads synchronization succeeds.

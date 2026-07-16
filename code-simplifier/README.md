# Code Simplifier

A Pi-compatible Agent Skill for simplifying task-owned changed code while preserving behavior.

The skill uses a short primary contract and loads its longer signal list only when needed. It can run after meaningful implementation or by explicit request. It does not launch a writer subagent.

## Scope and safety

- Scope is limited to changes owned by the current task.
- Ambiguous or pre-existing worktree changes are not edited.
- Automatic edits require meaningful passing validation before and after the pass.
- Public contracts, failures, side effects, ordering, security, telemetry, and operational behavior are preserved.
- A no-op is a valid result.

## Installation

Install the `pi-extensions` package with this skill enabled, then reload Pi.

## Pi usage

Invoke the skill explicitly when needed:

```text
/skill:code-simplifier
```

State the intended scope in the request, such as the current task diff, named files, or a revision range. Global and workflow instructions may also request the skill after meaningful code changes.

## Upstream review

`references/sources.md` records reviewed upstream files, pinned commits, content hashes, licenses, adopted ideas, and rejected ideas.

Run the checker explicitly from this directory:

```bash
python3 scripts/check-upstreams.py
```

List configured sources without network access:

```bash
python3 scripts/check-upstreams.py --list
```

Exit codes:

- `0`: every reviewed source is unchanged;
- `1`: at least one source changed and needs human review;
- `2`: the sources document or network check failed.

The checker only reads `references/sources.md` and upstream public files. It does not write, schedule itself, install anything, merge changes, or update the skill.

# Upstream sources

This skill is an owned synthesis. Upstream files are research inputs, not runtime dependencies. Review changes selectively. Do not replace the local skill with an upstream file or apply updates automatically.

The read-only checker parses the exact field names below and compares the reviewed content hash with the current file on the named branch.

## Anthropic Code Simplifier

- Repository: https://github.com/anthropics/claude-plugins-official
- Branch: main
- Path: plugins/code-simplifier/agents/code-simplifier.md
- Reviewed commit: b5eddebc6444d73108941ee698f25fa8759b8710
- Reviewed SHA-256: 2a51e8d210580d9f66ac2ed1226c41f9374565fc275da30d7bb95f65c2cc87bb
- License: Apache-2.0
- Adopted: recently modified scope, exact functionality preservation, project conventions, clarity over compactness, no-op-friendly balance.
- Not adopted: fixed JavaScript and React style preferences, mandatory proactive mutation after every change, model pinning.

## Addy Osmani Code Simplification

- Repository: https://github.com/addyosmani/agent-skills
- Branch: main
- Path: skills/code-simplification/SKILL.md
- Reviewed commit: c1974de476a39cb002a3b8e51e6a7e8e57b808c6
- Reviewed SHA-256: f0c5ed754057eb0c1e027e2587f59de816651feb5e837242296c43ea21cf621d
- License: MIT
- Adopted: understand before changing, explicit when-not-to-run rules, behavior and error preservation, incremental validation, anti-over-simplification checks.
- Not adopted: numeric size rules, language-specific rewrite recipes, mandatory separate refactor commits, large checklist in the primary skill.

## Sentry Code Simplifier

- Repository: https://github.com/getsentry/skills
- Branch: main
- Path: skills/code-simplifier/SKILL.md
- Reviewed commit: 412f2368ee3ec90ce042826b57533f080d531aaf
- Reviewed SHA-256: ad4ce00d2759e0773bee88f267f4ae0f52684979d7fbceb14dffd5efefbce141
- License: Apache-2.0
- Adopted: concise five-principle structure, readable explicit code, project-specific standards, recently touched scope.
- Not adopted: fixed Sentry or JavaScript conventions, examples that assume one language or framework.

## Paul R. Berg Code Polish

- Repository: https://github.com/PaulRBerg/agent-skills
- Branch: main
- Path: skills/code-polish/SKILL.md
- Reviewed commit: 60eb91d5cee7327f5f58996fa871164a7465b47b
- Reviewed SHA-256: 8d6ebb736569adbebb7ed616f17fffbccc20f92bc18915ec60a38c40e4394b85
- License: MIT
- Adopted: one fixed resolved scope, task-owned change boundary, public contract and operational guard preservation, high-confidence edits, no-op validity, explicit residual-risk reporting.
- Not adopted: combined broad review and autofix modes, profile matrix, fallback to all uncommitted files when session ownership is unavailable.

## Selective update procedure

1. Run `python3 scripts/check-upstreams.py` from the skill directory.
2. If a source reports `changed`, inspect its actual diff and release context.
3. Compare each upstream change against the local contracts in `SKILL.md`.
4. Adopt only changes that improve a confirmed local failure or remove unnecessary complexity.
5. Update the reviewed commit, content hash, and adopted or rejected notes in this file.
6. Run the skill validator and behavioral checks before merging.

A changed upstream hash is a review prompt. It is not evidence that the local skill should change.

## Context

The validator currently calls README validation for every skill directory, and the README validator treats a missing file as an error. The documented Agent Skill structure and Pi's own skill format require only `SKILL.md`. See `proposal.md` and `specs/skill-validation/spec.md` for the behavior contract.

The validator is a standalone Python script with a PEP 723 dependency declaration. The repository has no existing test framework for this script.

## Goals / Non-Goals

**Goals:**
- Keep README validation strict when the optional file exists.
- Exercise validator behavior through committed skill-directory fixtures.
- Use the Python standard library for tests and keep PyYAML provisioned through `uv`.

**Non-Goals:**
- Change frontmatter validation or Pi's Agent Skill loading behavior.
- Add a repository-wide Python test framework or dependency.
- Copy repository changes into installed global skills.

## Decisions

### Treat a missing README as the valid optional case

`validate_readme` will return no findings when its path does not exist. This keeps optional-file handling in the function that owns README checks and leaves the caller unchanged.

Alternative: guard the call in `validate_skill`. This would also work, but it would make `validate_readme` itself disagree with the optional-file contract.

### Preserve checks for every present README

Empty content, a missing Installation heading, and missing summary text keep their current error or warning levels. Making README optional does not weaken validation for authors who add the file.

Alternative: remove README validation. This would accept documented but unusable installation guidance and exceeds the bug's scope.

### Use standard-library unit tests with committed fixtures

A small `unittest` module will load the validator and validate fixture directories for absent, valid, and invalid README cases. The test file will carry a PEP 723 PyYAML dependency so `uv run` remains the single setup command.

Alternative: add pytest. The repository does not already depend on it, and this change does not need its extra features.

## Risks / Trade-offs

- [Direct callers may have relied on a missing README error] → The documented contract already marks README optional, and tests lock the corrected behavior.
- [Fixtures can drift from the published example] → The valid README fixture follows the summary plus Installation structure shown in `SKILL.md`.
- [The script and tests both need PyYAML] → Both use PEP 723 with the same minimum dependency and run through `uv`.

## Migration Plan

No data or installation migration is needed. Release the validator and guidance together. Revert the validator condition and tests if the optional behavior must be rolled back.

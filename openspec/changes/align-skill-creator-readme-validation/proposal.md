## Why

The skill-creator guidance documents `README.md` as optional, but its validator rejects every Agent Skill that omits the file. This makes a documented minimal skill fail deterministic validation.

## What Changes

- Accept an Agent Skill without `README.md` when its required `SKILL.md` is valid.
- Keep the current README content checks when `README.md` exists, including the required Installation section.
- Add deterministic fixtures and tests for the no-README case and the documented README case.
- Clarify the validator documentation, document recovery for present-README errors and the successful completion output, and record the behavior change.

## Capabilities

### New Capabilities

- `skill-validation`: Defines validator behavior for required Agent Skill files and optional README content.

### Modified Capabilities

None.

## Impact

- Affected code: `extending-pi/skill-creator/scripts/validate_skill.py`.
- Affected tests: new validator fixtures and standard-library unit tests under `extending-pi/skill-creator/tests/`.
- Affected documentation: skill-creator validation guidance and changelog.
- No runtime API, dependency, package installation, or global skill copy changes.

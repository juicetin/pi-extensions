## Purpose

Defines deterministic validation behavior for optional human-facing files in an Agent Skill directory.

## ADDED Requirements

### Requirement: README is optional and validated when present
The skill validator SHALL accept an otherwise valid Agent Skill directory when `README.md` is absent. When `README.md` exists, the validator SHALL require non-empty content and an Installation section. A present README without summary text before its Installation section SHALL remain valid and produce a warning.

#### Scenario: Valid skill without README
- **WHEN** a skill directory contains a valid `SKILL.md` and no `README.md`
- **THEN** validation succeeds without a README error or warning

#### Scenario: Valid documented skill
- **WHEN** a skill directory contains a valid `SKILL.md` and a non-empty `README.md` with summary text followed by an Installation heading
- **THEN** validation succeeds without a README error or warning

#### Scenario: Empty README
- **WHEN** a skill directory contains a valid `SKILL.md` and an empty `README.md`
- **THEN** validation fails with an error that the README is empty

#### Scenario: README without installation instructions
- **WHEN** a skill directory contains a valid `SKILL.md` and a non-empty `README.md` without an Installation heading
- **THEN** validation fails with an error that the README is missing an Installation section

#### Scenario: README without summary text
- **WHEN** a skill directory contains a valid `SKILL.md` and a `README.md` whose Installation heading has no earlier non-heading text
- **THEN** validation succeeds with a warning that the README has no summary text before Installation

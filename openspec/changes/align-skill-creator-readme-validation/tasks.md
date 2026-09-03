## 1. Validator contract tests

- [x] 1.1 Add committed Agent Skill fixtures with and without the optional README, then verify the fixture names match their `SKILL.md` frontmatter.
- [x] 1.2 Add standard-library unit tests for all README scenarios in `specs/skill-validation/spec.md`, then run them before implementation and confirm the no-README scenario fails for the reported reason.

## 2. Validator correction

- [x] 2.1 Change missing-README handling so it returns no findings, then verify the full validator unit test suite passes.
- [x] 2.2 Run the validator CLI against both valid fixtures and verify each exits successfully with `Skill is valid!`.

## 3. Documentation and validation

- [x] 3.1 Clarify the validator's optional README behavior in the skill guidance and package README, update the changelog, and verify the documents agree with the spec.
- [x] 3.2 Run strict OpenSpec validation and the relevant repository checks, then review the final task-owned diff for spec compliance and regressions.
- [x] 3.3 Verify no installed global skill copy changed; if a future sync is needed, leave it out of this repository change unless the global fresh-Pi startup gate can be completed.

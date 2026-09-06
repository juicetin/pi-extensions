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
- [x] 3.4 Document recovery for an empty README or a README without an Installation section, and verify the guidance names `Skill is valid!` as the completion output.

## 4. Branch review and delivery

- [x] 4.1 Review the task-owned diff against the Bead and OpenSpec requirements; verify no unrelated behavior or repository changes are included.
- [x] 4.2 Commit and push `bd-piext-4za`, open the user-owned repository pull request, attach verification evidence to Bead `piext-4za`, close it, and verify Beads synchronization succeeds.

## 5. Visual review evidence

- [x] 5.1 Create a light, self-contained HTML breakdown of the before state, optional-README correction, present-file recovery, validation flow, and evidence scope.
- [x] 5.2 Capture desktop and narrow screenshots plus a short chaptered video from the committed documentation revision.
- [x] 5.3 Validate the final HTML, screenshots, and video with browser diagnostics, OpenCV, OCR, and media metadata checks.
- [x] 5.4 Obtain a fresh independent review of the exact evidence files, fix confirmed defects, update PR #26 with commit-pinned links, then push and close Bead `piext-4za` again.

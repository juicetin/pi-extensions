#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml>=6"]
# ///

from __future__ import annotations

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).parent
SKILL_CREATOR_DIR = TESTS_DIR.parent
FIXTURES_DIR = TESTS_DIR / "fixtures"
VALIDATOR_PATH = SKILL_CREATOR_DIR / "scripts" / "validate_skill.py"

spec = importlib.util.spec_from_file_location("validate_skill", VALIDATOR_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load validator: {VALIDATOR_PATH}")
validate_skill_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validate_skill_module)


class ReadmeValidationTests(unittest.TestCase):
    def assert_validation(
        self,
        fixture_name: str,
        expected_errors: list[str],
        expected_warnings: list[str],
    ) -> None:
        result = validate_skill_module.validate_skill(FIXTURES_DIR / fixture_name)
        self.assertEqual((expected_errors, expected_warnings), result)

    def validate_modified_readme(self, content: str) -> tuple[list[str], list[str]]:
        with tempfile.TemporaryDirectory() as temporary_directory:
            skill_directory = Path(temporary_directory) / "with-readme"
            shutil.copytree(FIXTURES_DIR / "with-readme", skill_directory)
            (skill_directory / "README.md").write_text(content)
            return validate_skill_module.validate_skill(skill_directory)

    def test_valid_skill_without_readme(self) -> None:
        self.assert_validation("without-readme", [], [])

    def test_valid_skill_with_documented_readme(self) -> None:
        self.assert_validation("with-readme", [], [])

    def test_empty_readme_is_an_error(self) -> None:
        self.assertEqual(
            (["README.md is empty"], []),
            self.validate_modified_readme(""),
        )

    def test_readme_without_installation_is_an_error(self) -> None:
        self.assertEqual(
            (["README.md is missing an Installation section"], []),
            self.validate_modified_readme("# With README\n\nSummary.\n"),
        )

    def test_readme_without_summary_is_a_warning(self) -> None:
        self.assertEqual(
            ([], ["README.md has no summary text before Installation"]),
            self.validate_modified_readme(
                "# With README\n\n## Installation\n\n`pi install ./with-readme`\n"
            ),
        )


if __name__ == "__main__":
    unittest.main()

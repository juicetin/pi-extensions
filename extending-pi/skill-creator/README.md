# Agent Skill Creator

Guidelines and templates for creating Agent Skills that follow the Agent Skills format and can be loaded by Pi and other compatible agent clients.

## Installation
`pi install npm:@tmustier/pi-skill-creator`

## Validator script

`README.md` is optional. If a skill includes it, `scripts/validate_skill.py` requires non-empty content and an Installation section.

The script uses a [PEP 723](https://peps.python.org/pep-0723/) `uv run --script` shebang. `uv` provisions PyYAML without system-wide Python packages.

Prerequisite: install [`uv`](https://docs.astral.sh/uv/getting-started/installation/) (for example, `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`), then:

```bash
scripts/validate_skill.py /path/to/my-skill
# or, equivalently:
uv run scripts/validate_skill.py /path/to/my-skill
```

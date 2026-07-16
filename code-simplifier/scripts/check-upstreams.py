#!/usr/bin/env python3
"""Report whether reviewed upstream skill files changed. Never writes files."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import quote, urlparse


@dataclass(frozen=True)
class Source:
    name: str
    repository: str
    branch: str
    path: str
    reviewed_commit: str
    reviewed_sha256: str
    license: str


FIELDS = {
    "Repository": "repository",
    "Branch": "branch",
    "Path": "path",
    "Reviewed commit": "reviewed_commit",
    "Reviewed SHA-256": "reviewed_sha256",
    "License": "license",
}


def parse_sources(path: Path) -> list[Source]:
    sources: list[Source] = []
    name: str | None = None
    values: dict[str, str] = {}

    def finish() -> None:
        nonlocal name, values
        if name is None:
            return
        missing = [field for field in FIELDS.values() if field not in values]
        if missing:
            raise ValueError(f"{name}: missing fields: {', '.join(missing)}")
        source = Source(name=name, **values)
        validate_source(source)
        sources.append(source)
        name = None
        values = {}

    for line in path.read_text(encoding="utf-8").splitlines():
        heading = re.fullmatch(r"## (.+)", line)
        if heading:
            finish()
            candidate = heading.group(1)
            if candidate != "Selective update procedure":
                name = candidate
            continue
        if name is None:
            continue
        match = re.fullmatch(r"- ([^:]+): (.+)", line)
        if match and match.group(1) in FIELDS:
            values[FIELDS[match.group(1)]] = match.group(2).strip()

    finish()
    if not sources:
        raise ValueError(f"{path}: no upstream sources found")
    return sources


def validate_source(source: Source) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", source.reviewed_commit):
        raise ValueError(f"{source.name}: Reviewed commit must be a 40-character lowercase Git SHA")
    if not re.fullmatch(r"[0-9a-f]{64}", source.reviewed_sha256):
        raise ValueError(f"{source.name}: Reviewed SHA-256 must be 64 lowercase hexadecimal characters")
    if not source.branch or not source.path or source.path.startswith("/") or ".." in Path(source.path).parts:
        raise ValueError(f"{source.name}: invalid branch or repository-relative path")
    raw_url(source)


def raw_url(source: Source) -> str:
    parsed = urlparse(source.repository)
    parts = parsed.path.strip("/").split("/")
    if parsed.scheme != "https" or parsed.netloc != "github.com" or len(parts) != 2 or not all(parts):
        raise ValueError(f"{source.name}: unsupported GitHub repository URL")
    owner, repo = parts
    encoded_path = "/".join(quote(part, safe="") for part in source.path.split("/"))
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{quote(source.branch, safe='')}/{encoded_path}"


def fetch_content(source: Source, timeout: float) -> bytes:
    headers = {"User-Agent": "pi-extensions-code-simplifier-upstream-checker"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(raw_url(source), headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def check_source(source: Source, timeout: float) -> dict[str, str]:
    content = fetch_content(source, timeout)
    current_hash = hashlib.sha256(content).hexdigest()
    status = "unchanged" if current_hash == source.reviewed_sha256 else "changed"
    return {
        "name": source.name,
        "status": status,
        "reviewed_commit": source.reviewed_commit,
        "reviewed_sha256": source.reviewed_sha256,
        "current_sha256": current_hash,
        "url": raw_url(source),
    }


def main() -> int:
    default_sources = Path(__file__).resolve().parent.parent / "references" / "sources.md"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=default_sources)
    parser.add_argument("--list", action="store_true", help="list parsed sources without network access")
    parser.add_argument("--json", action="store_true", help="emit JSON")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    try:
        sources = parse_sources(args.sources)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if args.list:
        payload = [asdict(source) for source in sources]
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            for source in sources:
                print(f"{source.name}: {source.repository}/{source.path} @ {source.reviewed_commit}")
        return 0

    results: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    for source in sources:
        try:
            results.append(check_source(source, args.timeout))
        except (OSError, urllib.error.URLError) as error:
            errors.append({"name": source.name, "error": str(error), "url": source.repository})

    if args.json:
        print(json.dumps({"results": results, "errors": errors}, indent=2))
    else:
        for result in results:
            print(
                f"{result['status'].upper()}: {result['name']} "
                f"reviewed={result['reviewed_sha256'][:12]} current={result['current_sha256'][:12]}"
            )
        for error in errors:
            print(f"ERROR: {error['name']}: {error['error']} ({error['url']})", file=sys.stderr)

    if errors:
        return 2
    if any(result["status"] == "changed" for result in results):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Reconcile GitHub's PR file list with the authoritative base...head diff."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def git_diff_files(base: str, head: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "-z", f"{base}...{head}"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        print(f"scope-reconcile: git diff failed: {result.stderr.decode(errors='replace').strip()}", file=sys.stderr)
        raise SystemExit(2)
    return [part.decode("utf-8", errors="surrogateescape") for part in result.stdout.split(b"\0") if part]


def github_files(path: Path) -> list[str]:
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"scope-reconcile: cannot read GitHub file list: {exc}", file=sys.stderr)
        raise SystemExit(2)

    if not isinstance(payload, list):
        print("scope-reconcile: GitHub payload must be a JSON list", file=sys.stderr)
        raise SystemExit(2)
    pages = payload if payload and all(isinstance(page, list) for page in payload) else [payload]
    files: list[str] = []
    for page in pages:
        if not isinstance(page, list):
            print("scope-reconcile: GitHub payload must be a list or paginated list of lists", file=sys.stderr)
            raise SystemExit(2)
        for item in page:
            if not isinstance(item, dict) or not isinstance(item.get("filename"), str):
                print("scope-reconcile: GitHub file entry is missing filename", file=sys.stderr)
                raise SystemExit(2)
            files.append(item["filename"])
    return files


parser = argparse.ArgumentParser()
parser.add_argument("--base", required=True)
parser.add_argument("--head", required=True)
parser.add_argument("--github-files-json", required=True, type=Path)
args = parser.parse_args()

actual = git_diff_files(args.base, args.head)
expected = github_files(args.github_files_json)
actual_set = set(actual)
expected_set = set(expected)

print(f"scope-reconcile: authoritative base...head file count: {len(actual)}")
print(f"scope-reconcile: GitHub PR API file count: {len(expected)}")

if len(actual) != len(actual_set) or len(expected) != len(expected_set):
    print("scope-reconcile: FAIL, duplicate filenames detected", file=sys.stderr)
    raise SystemExit(1)

missing = sorted(actual_set - expected_set)
unexpected = sorted(expected_set - actual_set)
if missing or unexpected:
    print("scope-reconcile: FAIL, PR file list does not match full base...head diff", file=sys.stderr)
    for path in missing:
        print(f"::error file={path}::missing from GitHub PR file list", file=sys.stderr)
    for path in unexpected:
        print(f"::error file={path}::not present in authoritative base...head diff", file=sys.stderr)
    raise SystemExit(1)

print("scope-reconcile: clean, file lists match exactly")

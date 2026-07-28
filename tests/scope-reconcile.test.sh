#!/usr/bin/env bash
# Prove scope reconciliation fails when a claimed file list omits real changes.
set -euo pipefail
cd "$(dirname "$0")/.."

CHECKER="$PWD/.github/scripts/scope-reconcile.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.email test@invalid
git -C "$TMP" config user.name "Scope Test"
printf 'base\n' > "$TMP/one.txt"
git -C "$TMP" add one.txt
git -C "$TMP" commit -qm base
base="$(git -C "$TMP" rev-parse HEAD)"

printf 'changed\n' >> "$TMP/one.txt"
printf 'added\n' > "$TMP/two.txt"
git -C "$TMP" add one.txt two.txt
git -C "$TMP" commit -qm head
head="$(git -C "$TMP" rev-parse HEAD)"

printf '[{"filename":"one.txt"}]\n' > "$TMP/mismatch.json"
if output="$(cd "$TMP" && python3 "$CHECKER" --base "$base" --head "$head" --github-files-json "$TMP/mismatch.json" 2>&1)"; then
  echo "FAIL: scope mismatch passed"
  exit 1
fi
grep -q "authoritative base...head file count: 2" <<<"$output"
grep -q "missing from GitHub PR file list" <<<"$output"
echo "BLOCKED: scope mismatch -> true file count 2, omitted file reported"

printf '[[{"filename":"one.txt"},{"filename":"two.txt"}]]\n' > "$TMP/match.json"
output="$(cd "$TMP" && python3 "$CHECKER" --base "$base" --head "$head" --github-files-json "$TMP/match.json")"
grep -q "authoritative base...head file count: 2" <<<"$output"
grep -q "file lists match exactly" <<<"$output"
echo "PASSED: matching scope -> true file count 2"

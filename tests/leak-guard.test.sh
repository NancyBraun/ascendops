#!/usr/bin/env bash
#
# Falsifiability test for the leak-guard scanner (.github/scripts/leak-guard.sh).
#
# A scanner nobody has watched FAIL on a real leak is unproven. This asserts:
#   (a) it FAILS on a planted leak carrying the exact shape that leaked on
#       2026-07-01 — agent roster + a cron-timing table + an operator abs-path
#       (ascendops operator identity);
#   (b) it PASSES on the current clean tree (no false positives on the
#       legitimate framework convention: agent-name placeholders, lifeos
#       test fixtures, obvious placeholder tokens);
#   (c) ascendops parameterization: an operator home path in a framework file
#       FAILS; same content in a PRIVATE orgs/ runtime path is exempt;
#   (d) ascendops fleet: agent+cron-schedule table in a non-test path FAILS,
#       in ANY letter case (roster matching is case-insensitive);
#   (e) a BARE operator home path (no trailing slash — EOL, quote, space) FAILS;
#   (f) NUL-safe plumbing: a leak in a filename containing a space is scanned
#       in --tree mode, not silently skipped;
#   (g) no self-skip wildcard: a leak planted at tests/leak-guard-exfil.md FAILS
#       (only the guard script + workflow are skipped, by exact path);
#   (h) PUBLIC orgs/ carve-outs are scanned: a leak in orgs/<org>/knowledge.md
#       or orgs/<org>/docs/durable/ FAILS; private orgs runtime paths stay exempt;
#   (i) the second operator identity is covered; the repo's known synthetic
#       fixtures pass ONLY via the exact-line allowlist.
#
# Operator usernames are split so THIS test file carries no operator-path literal.

set -uo pipefail
cd "$(dirname "$0")/.."
GUARD=".github/scripts/leak-guard.sh"
GUARD_ABS="$PWD/$GUARD"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
DH="david""hunter"
CT="cortex""tos"
ORG="ascend""ops"
AGENT="da""ne"
USERS_ROOT="/""Users"
fails=0

# expect_fail LABEL MARKER FILE... — guard must exit non-zero AND report MARKER.
expect_fail() {
  local label="$1" marker="$2" out; shift 2
  out=$(bash "$GUARD_ABS" "$@" 2>&1) \
    && { echo "FAIL: scanner PASSED $label (should have failed)"; fails=1; }
  printf '%s\n' "$out" | grep -q "$marker" \
    || { echo "FAIL: '$marker' not reported for $label"; fails=1; }
}
# expect_pass LABEL FILE... — guard must exit zero.
expect_pass() {
  local label="$1"; shift
  bash "$GUARD_ABS" "$@" > /dev/null 2>&1 \
    || { echo "FAIL: scanner flagged $label (should pass)"; fails=1; }
}

# (a) planted leak: operator path + roster+cron table.
cat > "$TMP/planted.md" <<EOF
# Phase Multi-Agent Report
| Agents simulated | 5 (boris, paul, sentinel, donna, nick) |
| paul | 6 | heartbeat(4h), morning-review(0 13 * * *), evening-review(0 1 * * *) |
Checked at $USERS_ROOT/$DH/cortextos/orgs/lifeos/agents/boris/AGENTS.md
EOF
expect_fail "planted leak (operator path)" 'operator home path' "$TMP/planted.md"
expect_fail "planted leak (roster table)" 'roster' "$TMP/planted.md"

# (c1) operator path in a framework file (simulating src/) MUST FAIL.
cat > "$TMP/src_planted.ts" <<EOF
// config reference: $USERS_ROOT/$DH/cortextos/src/daemon/index.ts
EOF
expect_fail "operator path in framework file" 'operator home path' "$TMP/src_planted.ts"

# (e) BARE operator home path — EOL and quote-delimited — MUST FAIL.
cat > "$TMP/bare_eol.md" <<EOF
workdir is $USERS_ROOT/$DH
EOF
expect_fail "bare operator path at EOL" 'operator home path' "$TMP/bare_eol.md"
cat > "$TMP/bare_quote.md" <<EOF
HOME="$USERS_ROOT/$DH" make build
EOF
expect_fail "bare operator path before quote" 'operator home path' "$TMP/bare_quote.md"

# (i) second operator identity MUST FAIL outside the exact-line allowlist;
# the repo's real fixture files PASS only via that allowlist.
cat > "$TMP/ct_planted.md" <<EOF
log at $USERS_ROOT/$CT/.$CT/default/logs/outbound-messages.jsonl
EOF
expect_fail "second operator identity" 'operator home path' "$TMP/ct_planted.md"
expect_pass "sprint7 fixture file (exact-line allowlist)" tests/sprint7-environment.test.ts
expect_pass "send-telegram fixture file (exact-line allowlist)" tests/unit/cli/send-telegram-normalize.test.ts

# (d) agent + cron-schedule table in a non-test doc MUST FAIL — both cases.
cat > "$TMP/docs_fleet.md" <<EOF
| dane | 4 | heartbeat(4h), morning-review(0 9 * * *), evening-review(0 1 * * *) |
EOF
expect_fail "lowercase roster+cron table" 'roster' "$TMP/docs_fleet.md"
cat > "$TMP/docs_fleet_uc.md" <<EOF
| Dane | 4 | heartbeat(4h), morning-review(0 9 * * *), evening-review(0 1 * * *) |
EOF
expect_fail "capitalized roster+cron table" 'roster' "$TMP/docs_fleet_uc.md"

# (g) tests/leak-guard-exfil.md is NOT self-skipped — MUST FAIL.
mkdir -p "$TMP/tests"
cat > "$TMP/tests/leak-guard-exfil.md" <<EOF
exfil: $USERS_ROOT/$DH/cortextos/orgs/$ORG/agents
EOF
pushd "$TMP" > /dev/null
out=$(bash "$GUARD_ABS" "tests/leak-guard-exfil.md" 2>&1) \
  && { echo "FAIL: scanner PASSED tests/leak-guard-exfil.md (self-skip too broad)"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  || { echo "FAIL: operator home path not detected in tests/leak-guard-exfil.md"; fails=1; }
popd > /dev/null

# (h) PUBLIC orgs carve-outs are scanned; private orgs runtime stays exempt.
mkdir -p "$TMP/orgs/$ORG/docs/durable" "$TMP/orgs/$ORG/agents/$AGENT"
cat > "$TMP/orgs/$ORG/knowledge.md" <<EOF
memory archive: $USERS_ROOT/$DH/Documents/AscendOps-Brain/01-Memory/daily/
EOF
cat > "$TMP/orgs/$ORG/docs/durable/planted-spec.md" <<EOF
worktree: $USERS_ROOT/$DH/cortextos-worktrees/example
EOF
cat > "$TMP/orgs/$ORG/agents/$AGENT/agent_state.md" <<EOF
$USERS_ROOT/$DH/cortextos/orgs/$ORG/agents/$AGENT/MEMORY.md
EOF
pushd "$TMP" > /dev/null
out=$(bash "$GUARD_ABS" "orgs/$ORG/knowledge.md" 2>&1) \
  && { echo "FAIL: scanner PASSED a leak in orgs knowledge.md (public carve-out)"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  || { echo "FAIL: operator home path not detected in orgs knowledge.md"; fails=1; }
out=$(bash "$GUARD_ABS" "orgs/$ORG/docs/durable/planted-spec.md" 2>&1) \
  && { echo "FAIL: scanner PASSED a leak in orgs docs/durable (public carve-out)"; fails=1; }
out=$(bash "$GUARD_ABS" "orgs/$ORG/agents/$AGENT/agent_state.md" 2>&1) \
  && { echo "FAIL: guard PASSED a tracked private-runtime path (must report it — tracked private paths ship publicly)"; fails=1; }
printf '%s\n' "$out" | grep -q 'private runtime path is tracked' \
  || { echo "FAIL: tracked private-runtime path not flagged with the expected marker"; fails=1; }
popd > /dev/null

# (f) filename WITH A SPACE carrying a leak is scanned in --tree mode.
mkdir -p "$TMP/spacerepo"
pushd "$TMP/spacerepo" > /dev/null
git init -q .
printf 'ref %s/%s/x\n' "$USERS_ROOT" "$DH" > "leak file.md"
git add -A
git -c user.email=leak@test -c user.name=leak commit -qm plant > /dev/null
out=$(bash "$GUARD_ABS" --tree HEAD 2>&1) \
  && { echo "FAIL: --tree skipped a leaky filename containing a space"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  || { echo "FAIL: operator home path not detected in spaced filename"; fails=1; }
popd > /dev/null

# (b) MUST PASS on the full tracked tree — the script's own exemption predicate
# is authoritative (no pre-filtering here), so this also proves the predicate.
# NOTE: if pre-existing leaks exist in the scanned surface, this test WILL flag
# them — that is the guard working correctly. Remediate the files; do NOT
# bypass the check.
tree_out=$(bash "$GUARD" --tree HEAD 2>&1)
tree_exit=$?
if [ "$tree_exit" -ne 0 ]; then
  echo "WARNING: scanner found pre-existing leak(s) in the tracked tree (remediation needed):"
  printf '%s\n' "$tree_out" | grep -v '^leak-guard: clean$' | head -20
  echo "FAIL: tracked tree is not clean — fix the flagged files before enabling as a required CI check"
  fails=1
fi

if [ "$fails" -eq 0 ]; then echo "leak-guard.test: PASS"; else echo "leak-guard.test: FAIL"; exit 1; fi

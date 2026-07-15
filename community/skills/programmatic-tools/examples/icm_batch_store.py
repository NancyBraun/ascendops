#!/usr/bin/env python3
"""Batch-store memory entries via mcp__icm__icm_memory_store without LLM routing.

Purpose: demonstrate the direct-call loop pattern that burns tokens when
LLM-routed but is cheap as a script. Replaces the heartbeat-cycle store
shape where an agent fires N icm_memory_store calls in sequence with the
model formatting JSON for each one.

Design doc: your org internal docs
research-dir-design-2026-05-24.md (icm = ~1.3M tokens/month reclaim,
top-ranked target per the high-value table).

Reference repo (inspiration only, no code copy): github.com/grandamenium/
programmatic-mcp-skill — MIT per README, license gap caveat in SKILL.md.

Run from worktree root:
    python3 community/skills/programmatic-tools/examples/icm_batch_store.py
    python3 community/skills/programmatic-tools/examples/icm_batch_store.py --dry-run
"""

import argparse
import os
import sys

# Worktree-relative import — Lane B delivers call_tool at lib/call_tool.py
HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.path.dirname(HERE)
sys.path.insert(0, SKILL_ROOT)

from lib.call_tool import call_tool  # noqa: E402

BATCH = [
    {
        "topic": "context-programmatic-tools",
        "content": "Lane C delivered SKILL.md + icm_batch_store.py example for the programmatic-tools skill on 2026-05-24.",
        "importance": "high",
        "keywords": "programmatic-tools,skill,lane-c,2026-05-24",
    },
    {
        "topic": "decisions-programmatic-tools",
        "content": "call_tool() routes mcp__* names via JSON-RPC and falls through to CLI binaries — single entry point keeps caller code transport-agnostic.",
        "importance": "high",
        "keywords": "call_tool,transport,decision",
    },
    {
        "topic": "preferences",
        "content": "Direct-call MCP scripts must support --dry-run for cron testability — cross-lane invariant 3 in API_CONTRACT.md.",
        "importance": "critical",
        "keywords": "dry-run,cron,testability,invariant",
    },
]

# Per-call LLM-routing overhead the design doc cites (~300-500 tokens).
# Use the conservative low end so the estimate doesn't oversell.
ESTIMATED_TOKENS_PER_LLM_CALL = 300


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch-store memory entries via direct MCP call.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log intended calls without executing — for cron testability.",
    )
    args = parser.parse_args()

    if args.dry_run:
        print("DRY RUN — intended calls:")
        for i, entry in enumerate(BATCH, 1):
            print(f"  [{i}] mcp__icm__icm_memory_store topic={entry['topic']!r} importance={entry['importance']!r}")
        print(f"Total intended: {len(BATCH)} calls.")
        print(f"Estimated tokens saved vs LLM-routed: ~{len(BATCH) * ESTIMATED_TOKENS_PER_LLM_CALL}")
        return 0

    stored = 0
    failed = 0
    for i, entry in enumerate(BATCH, 1):
        try:
            result = call_tool("mcp__icm__icm_memory_store", entry)
            print(f"  [{i}] OK topic={entry['topic']!r} result={result!r:.120s}")
            stored += 1
        except Exception as exc:  # noqa: BLE001 — surface every failure for the operator
            print(f"  [{i}] FAIL topic={entry['topic']!r} error={exc!r}")
            failed += 1

    print(f"\nStored {stored}/{len(BATCH)} entries ({failed} failed).")
    print(f"Estimated tokens saved vs LLM-routed: ~{stored * ESTIMATED_TOKENS_PER_LLM_CALL}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

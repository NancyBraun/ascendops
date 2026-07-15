---
name: programmatic-tools
description: "You have a batch operation, cron task, or scripted loop that calls an MCP tool or CLI in a mechanical shape — same call shape, different arguments, N times. You want to bypass the LLM-as-router for those calls to save tokens. The script writes/reads JSON-RPC directly to the MCP server (or shells out to the CLI) via call_tool() instead of routing every invocation through the model."
triggers: ["batch call MCP", "bypass LLM for tool call", "MCP from script", "cron MCP", "direct MCP call", "programmatic tool call", "call_tool", "JSON-RPC MCP", "skip LLM router", "batch icm store", "scripted tool loop", "direct call vs llm routed", "save tokens on tool calls", "tool from cron"]
external_calls: []
---

# Programmatic Tools

> Direct-call MCP tools and CLI binaries from Python scripts. Bypass the LLM-as-router for mechanical loops and cron tasks. Saves an estimated 2-5M tokens/month across the AscendOps fleet at current activity levels.

Use this skill when you have a tool call shape that repeats — same tool name, varying arguments, N times in a row — and the LLM adds zero routing value. The classic shape is a batch memory store, a cron-driven ingestion sweep, or a loop over search results. Keep LLM-routed calls for the cases where the model is actually choosing which tool to call, formatting tricky arguments, or interpreting ambiguous responses.

Design doc: `your org internal docs` carries the inventory, decision matrix, and token estimates this skill cites.

---

## Quick start

```python
import sys
sys.path.insert(0, "community/skills/programmatic-tools")
from lib.call_tool import call_tool

# Single MCP call — no LLM in the loop
result = call_tool(
    "mcp__icm__icm_memory_recall",
    {"query": "PM endpoint discovery 2026-05-16", "limit": 5},
)
print(result)
```

`call_tool()` auto-resolves the transport: `mcp__*` names route via JSON-RPC to the MCP server resolved from `.mcp.json`; anything else that resolves on PATH is treated as a CLI binary. See `lib/call_tool.py` for the full contract.

---

## When to use direct-call

| Call type | LLM-routed | Direct-call (this skill) |
|---|---|---|
| Batch loop (same tool, N args) | Wasteful — burns ~300-500 tokens per call on routing | Right shape — call_tool() in a for-loop |
| Cron / scheduled task | Wasteful — fires whether agent is paying attention or not | Right shape — script reads input, calls tool, writes output |
| Interactive choice (which tool?) | Right shape — model picks tool from context | Wrong shape — caller has to hard-code the name |
| One-off ad-hoc call | Either works — go with whatever is faster | Either works |
| Ambiguous response interpretation | Right shape — model parses prose / decides next step | Wrong shape — script needs structured output |
| Real-time / session-based (playwright, computer-use) | Right shape — interactive | Wrong shape — direct-call assumes stateless |

Rule of thumb: if a human looking at the call site would say "you don't need the model for this", direct-call.

---

## Token-reclaim estimate

Per the design doc, the fleet currently burns roughly **2-5M tokens/month** routing mechanical MCP calls through the LLM. Top three high-value targets:

1. **`icm` memory_store + memory_recall** — heartbeat-cycle calls across 6 agents × 6 cycles/day × ~30 days ≈ 3,240 calls/month at ~300-500 tokens each → **~1.3M tokens/month** routable to script.
2. **`claude-mem` ingestion + search** — cron-driven, similar volume and shape to icm. Identical pattern, identical reclaim profile.
3. **`semble` search** — bursty during code-review sessions (5-10 calls per session); same routing overhead per call.

Lower-volume but still worth direct-call: `agent-architects` lesson fetch (large payloads, format-overhead matters), `graphify` query (slated for code-nav workflows).

---

## Examples

- `examples/icm_batch_store.py` — batch-store 3 memory entries via `mcp__icm__icm_memory_store` using `call_tool()`. Supports `--dry-run` for cron testability per cross-lane invariant 3. This is the canonical pattern for replacing any heartbeat-cycle store loop.

If your dispatch needs a different example shape, the file is short enough to copy and adapt — change the `BATCH` list and the tool name, leave the loop and the dry-run plumbing.

---

## Limitations

Some tools should stay LLM-routed even in scripted contexts:

- **`playwright`** — session-based browser automation. Direct-call doesn't fit; the model needs to read page state between actions.
- **`computer-use`** — real-time UI control with screenshot feedback. Same shape as playwright — interactive.
- **`notion`** — mixed shape; doc authoring is judgment-driven, doc reading can be direct-call but the volume is low.
- **`semble find_related` during interactive review** — judgment-driven exploration, LLM-routed is right. Direct-call only applies to scripted batch use of `semble search`.

If a tool is interactive, real-time, or the model is genuinely choosing between options at each step, keep it LLM-routed.

---

## Attribution

Pattern inspired by github.com/grandamenium/programmatic-mcp-skill (MIT per README, no LICENSE file present — implementation here is our own against MCP protocol spec, no code copy).

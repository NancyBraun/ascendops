# Cron Source-of-Truth Contract

**Status:** load-bearing — load before editing any cron config or daemon scheduler code
**Authored:** 2026-05-11 (an agent, post root-cause investigation of cron-prompt-cache bug)
**Related code:** `src/daemon/cron-scheduler.ts`, `src/daemon/cron-migration.ts`, `src/bus/crons.ts`

## TL;DR

Two files hold cron data. They are **not symmetric**. Editing one without propagating to the other causes silent prompt-staleness — the daemon happily fires the old prompt while the operator believes the new prompt is live.

| File | Path | Role | Edited by |
|---|---|---|---|
| `config.json` | `orgs/<org>/agents/<agent>/config.json` (in git) | Operator-friendly editing surface | Humans + agents via Edit/Write |
| `crons.json` | `~/.cortextos/<instance>/.cortextOS/state/agents/<agent>/crons.json` | Daemon scheduler runtime authority | `bus add-cron` / `update-cron` / `remove-cron` / `migrate-crons` |

**Authoritative for the daemon scheduler:** `crons.json` (state file). `CronScheduler.loadCrons()` reads this and nothing else.

**Authoritative for git history + operator review:** `config.json:crons[]`.

**Bridge:** `cron-migration.ts` runs once on first agent start. Marker `state/agents/<agent>/.crons-migrated` prevents re-runs. After the marker is set, `config.json` edits never reach `crons.json` without an explicit operator action.

## The bug class this creates

Operator edits a cron prompt or schedule in `config.json` expecting next fire to use the new value. Daemon continues firing the old value from `crons.json`. No error surfaces — fires complete normally with stale text.

**Concrete examples observed in an agent's state on 2026-05-11 (pre-fix):**
- `skill-optimizer` prompt: `config.json` had morning-review dropped per operator feedback F1 (2026-05-10). `crons.json` still had the OLD prompt referencing morning-review. Cron fired 2026-05-11 13:33 UTC using the stale prompt.
- `skill-optimizer` schedule: `config.json` `33 9 * * 1` (weekly Monday per an agent F4). `crons.json` `33 9 * * 1-5` (daily weekdays). Daemon scheduled per the OLD weekday cadence.
- `pm-colocated-detect`: new cron added to `config.json` 2026-05-11. **NEVER added to `crons.json`.** Would have silently no-opped tomorrow's 07:15 EDT first-fire.

## Edit contract

### Adding a cron
1. Add entry to `config.json:crons[]` (git-committed source-of-truth).
2. Either:
   - `cortextos bus add-cron <agent> <name> <interval> <prompt...>` — writes directly to `crons.json` (operator can do this without editing config.json; recommend keeping config.json in sync afterwards for git audit).
   - OR run `cortextos bus migrate-crons --force <agent>` (DESTRUCTIVE — see warning below).
   - OR run `cortextos bus reload-crons <agent>` (RECOMMENDED — merge-aware, preserves runtime state — implemented in PR-TBD).

### Updating a cron prompt or schedule
1. Edit `config.json:crons[<name>].prompt` (or `cron`/`interval`).
2. Run `cortextos bus update-cron <agent> <name> --prompt "..."` (surgical) OR `reload-crons <agent>` (bulk re-sync).
3. After an agent's daemon-side cache-invalidation PR lands: next fire uses fresh data automatically. Without that PR: a process-level signal (SIGHUP-style) or daemon restart is required to invalidate the in-memory cache.

### Removing a cron
1. Remove entry from `config.json:crons[]`.
2. `cortextos bus remove-cron <agent> <name>` — writes to `crons.json`.

### NEVER do
- Edit `crons.json` by hand. It's atomic-write-only via `bus crons.ts` writers. Direct edits race with daemon writes.
- Assume `config.json` edits propagate. Without explicit operator action OR an automated reload mechanism, they don't.
- Use `migrate-crons --force` for routine edit propagation. **It wipes runtime fields** (see warning below).

## Warning — `migrate-crons --force` is destructive

`cortextos bus migrate-crons --force <agent>` clears the migration marker and re-runs migration as if first-boot. Side effect: runtime fields are reset to defaults.

**Fields wiped:** `last_fired_at`, `last_fire_attempted_at`, `fire_count`, `created_at` (replaced with current timestamp).

**Impact:**
- Dashboard fire history disappears for the affected agent.
- Scheduler may fire crons immediately on next tick if `last_fired_at=null` is treated as "never fired" rather than computing nextFireAt from migration time.
- Audit trails (e.g. heartbeat fire_count for SLA tracking) lost.

**Use only for:**
- First-time migration of a new agent.
- Recovery from a corrupted `crons.json`.

**Do NOT use for routine config.json edit propagation.** Use `reload-crons` (merge-aware) instead.

Observed 2026-05-11 during outage fix: an agent heartbeat went `fire_count=63 → 0`, `last_fired_at=2026-05-12T02:13:20Z → null` from a single `migrate-crons --force` call. Restored from backup manually.

## `reload-crons` design (PR-TBD)

**Goal:** propagate `config.json` edits to `crons.json` without destroying runtime fields.

**Algorithm:**
```
for each name in config.json:crons:
    if name in crons.json:
        # merge: take config-side definition fields, keep state-side runtime fields
        new_entry = { ...config_entry, ...{ runtime fields from state_entry } }
    else:
        # add: fresh entry with empty runtime fields
        new_entry = { ...config_entry, fire_count: 0, last_fired_at: null }
    write new_entry to staged crons.json

for each name in crons.json NOT in config.json:
    if --prune flag passed:
        drop from staged crons.json (operator opt-in destructive)
    else:
        keep as-is in staged crons.json (DEFAULT — orphan tolerated)

atomic write staged crons.json
emit reload event for daemon cache invalidation (consumed by an agent's PR)
```

**Runtime fields to preserve (from existing state entry):**
- `last_fired_at`
- `last_fire_attempted_at`
- `fire_count`
- `created_at`

**Config-side fields that authoritatively overwrite state:**
- `prompt`
- `schedule` (cron expression or interval)
- `enabled`
- `description`
- `metadata` (except `migrated_from_config` marker)

**Orphan-handling contract (DEFAULT = keep, opt-in to prune):**

Orphans = entries in `crons.json` that have NO matching name in `config.json:crons[]`. They get there via:
- `bus add-cron` (operator added directly to state, never reflected in config.json — legitimate use case for ephemeral or test crons)
- Stale state — config entry was removed but daemon never garbage-collected
- Concurrent edits between operators

**Default behavior: keep orphans.** Rationale: surprise-deletion of a cron the operator forgot to add to config.json is worse than letting it run. Operator can manually remove via `bus remove-cron` if intentional.

**Opt-in prune:** `cortextos bus reload-crons <agent> --prune` drops orphans from staged crons.json. Output prints the dropped names so operator sees what got pruned. Use for "I just deleted this cron from config.json on purpose, sync that deletion through."

**Output (both modes):** prints summary to stdout — `{added: N, updated: N, kept_orphan: N, pruned_orphan: N, total: N}` for operator confirmation.

**Destructive-op pattern (carryover from `migrate-crons --force` finding):** all destructive operations require explicit opt-in flag. Default behavior never destroys state.

## Two-stage pipeline (with an agent's daemon-side PR)

```
operator edits orgs/<org>/agents/<agent>/config.json
        ↓
operator runs `cortextos bus reload-crons <agent>` (this PR)
        ↓
reload-crons reads config.json + state crons.json
        ↓
reload-crons merges: config wins for definition fields, state wins for runtime fields
        ↓
reload-crons atomic-writes state crons.json + emits reload signal
        ↓
daemon CronScheduler.reload() (an agent's PR) detects signal → re-reads crons.json → invalidates in-memory cache
        ↓
next fire uses fresh prompt + schedule
```

**Hook-point for an agent's PR:** the reload signal. Options:
- Write a sentinel file `state/agents/<agent>/.reload-requested` (daemon polls).
- IPC message to daemon via existing `daemon.sock`.
- `process.kill(daemonPid, 'SIGUSR1')` — Unix signal.

Recommend IPC over the existing socket — clean integration with daemon's tick loop, no polling overhead.

## Open work items (post-PR)

1. `bus reload-crons` PR (an agent owns).
2. Daemon-side cache invalidation PR (an agent owns).
3. Per-agent `enabled-agents.json` interaction — currently `migrate-crons` skips disabled agents; verify `reload-crons` honors the same gate.
4. Atomic-write race testing: two concurrent `reload-crons` invocations against the same agent.

## Reference

- Bug discovery: an agent skill-optimizer cron audit 2026-05-11 — flagged that config.json edits didn't propagate.
- Dispatch: an agent msg 1778553788320 — split bug fix into an agent (source-of-truth + reload-crons) + an agent (daemon cache invalidation).
- Outage fix: an agent 2026-05-11 ~20:47 UTC — pre-empted tomorrow's 07:15 pm-colocated-detect silent-no-op via `migrate-crons --force` + manual runtime-field restore.

## Follow-up backlog (post-`reload-crons`-PR)

### `migrate-crons --force` destructive-op cleanup

Per the 2026-05-11 outage-fix finding, `bus migrate-crons --force` wipes runtime fields (last_fired_at, fire_count, etc.) for ALL crons in the agent, including unchanged ones. This breaks audit trails and may cause double-fires if the scheduler treats `last_fired_at=null` as "never fired" rather than computing nextFireAt from migration time.

**Two patch options:**

**(A) Make `migrate-crons --force` non-destructive by default** — re-runs migration but merges with existing runtime fields. Add a separate `--replace-state` flag for the genuinely-destructive case (corrupted crons.json recovery).

**(B) Add `bus replace-crons --force` as the destructive op + remove `--force` from `migrate-crons`** — clearer command boundary, no ambiguity about which one wipes runtime state.

Pattern: destructive ops require explicit operator opt-in flag, never default behavior. Surface this once `reload-crons` PR lands so the follow-up doesn't block the immediate fix.

Tracked separately — not part of the cron-prompt-cache fix.

# cortextOS Onboarding — Resume Note

**Status:** Paused mid-onboarding to move from native Windows to WSL (Linux).
**Date paused:** 2026-06-22

## Why we pivoted

Running the onboarding natively on Windows surfaced **89 of 2480 test failures**
across ~31 files. Root cause: **hardcoded forward-slash path separators** that
break on Windows (e.g. `src/bus/catalog.ts:364` uses
`resolvedStaging.startsWith(resolvedStagingBase + '/')`, but Windows
`path.resolve()` returns `\` separators, so the check always fails). These are
real cross-platform bugs, not test-only quirks. cortextOS also leans heavily on
bash / POSIX (`bus/*.sh`, `chmod 600`, `/tmp`, the PM2 daemon), so the robust
fix was to run the whole system under WSL.

## How to resume (inside WSL Ubuntu)

1. **Install WSL** (done on the Windows side, requires admin + reboot):
   ```
   wsl --install      # in an Administrator PowerShell, then reboot
   ```
2. **Bootstrap the toolchain** inside the Ubuntu shell:
   ```
   bash wsl-setup.sh
   ```
   Installs Node 20+, npm, jq, curl, git, build-essential, PM2, and Claude Code.
3. **Authenticate Claude Code** inside WSL:
   ```
   claude login
   ```
4. **Get the repo into the WSL filesystem** — keep it under `~/`, NOT `/mnt/c`
   (avoids slow I/O and reintroduced path/permission issues):
   ```
   git clone https://github.com/grandamenium/cortextos.git ~/cortextos
   cd ~/cortextos
   npm install && npm run build
   ```
5. **Re-run onboarding** from a Claude Code session started inside WSL:
   ```
   claude
   /onboarding
   ```

## What was already decided / collected

- **Dependencies (Windows side):** all verified present — Node v24.16.0, npm
  11.13.0, PM2 7.0.1, curl, jq (these do NOT carry into WSL; `wsl-setup.sh`
  reinstalls them in Linux).
- **Claude Code:** authenticated on Windows (v2.1.183). Must re-auth in WSL.
- **Telegram bot:** user does NOT have a token yet — will create one via
  @BotFather during Phase 6 (Orchestrator setup).
- **Build:** `dist/cli.js` was present on Windows; rebuild in WSL.

## Onboarding phases NOT yet started

Everything from **Phase 3 (Install) onward** still needs to run in WSL:
- Phase 3 — `npm test` (should be green on Linux), then `node dist/cli.js install`
- Phase 4 — Organization setup (name, north star, goals, daily focus, timezone,
  working hours, comms style, knowledge.md)
- Phase 5 — Agent planning (Orchestrator + Analyst names)
- Phase 6 — Orchestrator setup (create Telegram bot, capture chat ID, model)
- Phase 7 — Dashboard (`dashboard/.env.local`, credentials, `npm run dev`)
- Phase 8 — Knowledge Base (optional, needs Gemini API key)
- Phase 9 — Start the PM2 daemon
- Phase 10 — Handoff to Telegram

## Optional follow-up (not blocking)

The Windows path-separator bugs are still real for anyone running on native
Windows. If cross-platform support matters, file an issue / fix the hardcoded
`'/'` separators in `src/bus/` (start with `catalog.ts:364`) — but this is NOT
required for the WSL path.

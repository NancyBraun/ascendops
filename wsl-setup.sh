#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# cortextOS — WSL (Ubuntu) toolchain bootstrap
#
# Run this ONCE inside your WSL Ubuntu shell to install everything cortextOS
# needs. It is idempotent — safe to re-run; it skips whatever is already
# present.
#
#   bash wsl-setup.sh
#
# After it finishes:
#   1. Run `claude login` to authenticate Claude Code inside WSL.
#   2. cd into the repo (clone it into ~/ , NOT /mnt/c) and run:
#        npm install && npm run build
#   3. Launch Claude Code and run `/onboarding` again.
# ---------------------------------------------------------------------------
set -euo pipefail

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }

if ! grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  warn "This doesn't look like WSL. Continuing anyway — it targets Debian/Ubuntu (apt)."
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "ERROR: apt-get not found. This script targets Ubuntu/Debian WSL. Adapt for your distro." >&2
  exit 1
fi

# --- Base system packages ---------------------------------------------------
log "Updating apt and installing base packages (curl, jq, git, build-essential)…"
sudo apt-get update -y
sudo apt-get install -y curl jq git build-essential ca-certificates
ok "Base packages installed"

# --- Node.js 20+ ------------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "${major:-0}" -ge 20 ]; then
    ok "Node.js $(node --version) already installed (>= 20)"
    need_node=0
  else
    warn "Node.js $(node --version) is older than v20 — upgrading via NodeSource."
  fi
fi
if [ "$need_node" -eq 1 ]; then
  log "Installing Node.js 20 from NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "Node.js $(node --version) installed"
fi

# --- PM2 --------------------------------------------------------------------
if command -v pm2 >/dev/null 2>&1; then
  ok "PM2 $(pm2 --version) already installed"
else
  log "Installing PM2 globally…"
  sudo npm install -g pm2
  ok "PM2 $(pm2 --version) installed"
fi

# --- Claude Code CLI --------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code already installed ($(claude --version 2>/dev/null || echo 'version unknown'))"
else
  log "Installing Claude Code CLI…"
  if curl -fsSL https://claude.ai/install.sh | bash; then
    ok "Claude Code installed"
    warn "If 'claude' isn't on your PATH, restart the shell or 'source ~/.bashrc'."
  else
    warn "Native installer failed. Trying npm fallback…"
    sudo npm install -g @anthropic-ai/claude-code \
      && ok "Claude Code installed via npm" \
      || warn "Could not auto-install Claude Code. Install manually: https://docs.anthropic.com/en/docs/claude-code"
  fi
fi

# --- Summary ----------------------------------------------------------------
log "Toolchain check"
for tool in node npm jq curl git pm2 claude; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool — $(command -v "$tool")"
  else
    warn "$tool — MISSING"
  fi
done

cat <<'NEXT'

──────────────────────────────────────────────────────────────────────
Toolchain ready. Next steps:

  1. Authenticate Claude Code inside WSL:
         claude login

  2. Get the repo into the WSL filesystem (NOT /mnt/c — keep it native):
         git clone https://github.com/grandamenium/cortextos.git ~/cortextos
         cd ~/cortextos
     (or copy your existing repo: cp -r /mnt/c/Users/JasonLinch/ascendops ~/ascendops)

  3. Build:
         npm install && npm run build

  4. Launch Claude Code in the repo and re-run onboarding:
         claude
         /onboarding

  See ONBOARDING-RESUME.md for exactly where we left off.
──────────────────────────────────────────────────────────────────────
NEXT

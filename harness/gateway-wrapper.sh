#!/bin/bash
# Wrapper script to start OpenClaw gateway with .env loaded
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
export PATH="$NVM_DIR/versions/node/v22.22.2/bin:$PATH"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/openclaw-workspace}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
set -a
source "$REPO_DIR/.env"
set +a
export SESSION_TIMEOUT_MS=3600000
export TAB_INACTIVITY_MS=1800000
export BROWSER_IDLE_TIMEOUT_MS=600000
exec openclaw gateway --port 18789

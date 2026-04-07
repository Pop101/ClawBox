#!/usr/bin/env bash
set -euo pipefail

# ── rebuild-mac-native.sh ─────────────────────────────────────────────────────
# Sets up OpenClaw natively on macOS (no Docker).
# Uses symlinks back to this repo so edits to harness/, prompts/, skills/,
# models.json, and credentials/ are reflected immediately.
#
# Usage:  bash rebuild-mac-native.sh          # install + generate config
#         bash rebuild-mac-native.sh start    # install + generate + start all
#         bash rebuild-mac-native.sh stop     # stop all processes
#         bash rebuild-mac-native.sh status   # show running processes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$SCRIPT_DIR"

# ── Target directories (mirrors Docker layout) ───────────────────────────────
OPENCLAW_HOME="$HOME/.openclaw"
WORKSPACE="$HOME/openclaw-workspace"
CONFIG_DIR="$HOME/.openclaw"
HARNESS_LINK="$HOME/.openclaw/harness"
CREDENTIALS_LINK="$HOME/credentials"
HIMALAYA_CONFIG="$HOME/.config/himalaya/config.toml"
SKILLS_DIR="$WORKSPACE/skills"
PID_DIR="$HOME/.openclaw/pids"

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
fail()  { echo -e "${RED}[✗]${NC} $*"; exit 1; }

# ── Stop command ──────────────────────────────────────────────────────────────
stop_all() {
  echo "Stopping OpenClaw processes..."
  for pidfile in "$PID_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    name=$(basename "$pidfile" .pid)
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && echo "  Stopped $name (PID $pid)" || true
    fi
    rm -f "$pidfile"
  done
  info "All processes stopped."
  exit 0
}

# ── Status command ────────────────────────────────────────────────────────────
show_status() {
  echo "OpenClaw process status:"
  for pidfile in "$PID_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    name=$(basename "$pidfile" .pid)
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      echo -e "  ${GREEN}●${NC} $name (PID $pid)"
    else
      echo -e "  ${RED}●${NC} $name (PID $pid — dead)"
      rm -f "$pidfile"
    fi
  done
  exit 0
}

case "${1:-}" in
  stop)   stop_all ;;
  status) show_status ;;
esac

# ── 0. Pre-flight checks ─────────────────────────────────────────────────────
echo "=== OpenClaw Native macOS Setup ==="
echo ""

command -v node  >/dev/null || fail "Node.js not found. Install with: brew install node"
command -v npm   >/dev/null || fail "npm not found."

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VER" -ge 22 ] || fail "Node.js v22+ required (found v$NODE_VER). Run: brew install node@22"

# ── 1. Install global npm packages ───────────────────────────────────────────
echo "[1/7] Checking npm global packages..."

install_if_missing() {
  if ! npm list -g "$1" >/dev/null 2>&1; then
    echo "  Installing $1..."
    npm install -g "$1"
  else
    echo "  $1 ✓"
  fi
}

install_if_missing openclaw@latest
install_if_missing clawhub@latest
install_if_missing @anthropic-ai/claude-code

# ── 2. Install system tools ──────────────────────────────────────────────────
echo ""
echo "[2/7] Checking system tools..."

check_tool() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "  $1 ✓"
  else
    warn "$1 not found. Install with: $2"
  fi
}

check_tool cloudflared "brew install cloudflared"
check_tool gog        "brew install steipete/tap/gogcli"
check_tool himalaya   "brew install himalaya"
check_tool gh         "brew install gh"

# ── 3. Create directories & symlinks ─────────────────────────────────────────
echo ""
echo "[3/7] Setting up directories and symlinks..."

mkdir -p "$OPENCLAW_HOME" "$WORKSPACE" "$SKILLS_DIR" "$CONFIG_DIR" "$PID_DIR" \
         "$(dirname "$HIMALAYA_CONFIG")"

# Symlink harness/ so generate-config.js can find its siblings
ln -sfn "$REPO_DIR/harness" "$HARNESS_LINK"
info "harness → $HARNESS_LINK"

# Symlink credentials/
ln -sfn "$REPO_DIR/credentials" "$CREDENTIALS_LINK"
info "credentials → $CREDENTIALS_LINK"

# Symlink himalaya config
if [ -f "$REPO_DIR/credentials/himalaya.toml" ]; then
  ln -sf "$REPO_DIR/credentials/himalaya.toml" "$HIMALAYA_CONFIG"
  info "himalaya.toml → $HIMALAYA_CONFIG"
fi

# Symlink models.json into harness parent (generate-config.js reads ../models.json)
# The harness symlink points to repo/harness, so ../models.json = repo/models.json ✓
info "models.json accessible via harness symlink (../models.json)"

# ── 4. Seed workspace prompts & skills ────────────────────────────────────────
echo ""
echo "[4/7] Seeding workspace..."

# Load .env if present
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_DIR/.env"
  set +a
  info "Loaded .env"
fi

OWNER_NAME="${OWNER_NAME:-the user}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
QUIET_HOURS_START="${QUIET_HOURS_START:-23}"
QUIET_HOURS_END="${QUIET_HOURS_END:-7}"

# Seed prompt templates (copy + template, not symlink, because they get personalized)
for mdfile in SOUL.md AGENTS.md USER.md HEARTBEAT.md; do
  src="$REPO_DIR/prompts/$mdfile"
  dst="$WORKSPACE/$mdfile"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    sed -e "s|{{OWNER_NAME}}|${OWNER_NAME}|g" \
        -e "s|{{OWNER_EMAIL}}|${OWNER_EMAIL}|g" \
        -e "s|{{QUIET_HOURS_START}}|${QUIET_HOURS_START}|g" \
        -e "s|{{QUIET_HOURS_END}}|${QUIET_HOURS_END}|g" \
        "$src" > "$dst"
    echo "  Seeded $mdfile"
  fi
done

# Symlink bundled skills into workspace
for skill_dir in "$REPO_DIR"/skills/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  target="$SKILLS_DIR/$skill_name"
  if [ ! -e "$target" ]; then
    ln -sfn "$skill_dir" "$target"
    echo "  Linked skill: $skill_name"
  fi
done

# Also link clawhub-installed skills if they exist
CLAWHUB_SKILLS=""
for candidate in /opt/openclaw-skills/skills /opt/openclaw-skills \
                 "$HOME/.openclaw/skills" "$HOME/.clawhub/skills"; do
  if [ -d "$candidate" ]; then
    CLAWHUB_SKILLS="$candidate"
    break
  fi
done
if [ -n "$CLAWHUB_SKILLS" ]; then
  for skill_dir in "$CLAWHUB_SKILLS"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    target="$SKILLS_DIR/$skill_name"
    if [ ! -e "$target" ]; then
      ln -sfn "$skill_dir" "$target"
      echo "  Linked clawhub skill: $skill_name"
    fi
  done
fi

# ── 5. Generate openclaw.json ─────────────────────────────────────────────────
echo ""
echo "[5/7] Generating config..."

# Set env vars that generate-config.js expects — no stealth browser, use native system browser
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
export STEALTH_BROWSER_HEADLESS="${STEALTH_BROWSER_HEADLESS:-false}"
# Unset CDP URL so openclaw uses its built-in managed browser (system Chrome)
unset OPENCLAW_BROWSER_CDP_URL 2>/dev/null || true
unset STEALTH_BROWSER_PORT 2>/dev/null || true
unset STEALTH_BROWSER_HOST 2>/dev/null || true

node "$REPO_DIR/harness/generate-config.js"
info "Config written to $OPENCLAW_CONFIG_PATH"

# ── 6. GOG auth (Google Workspace) ───────────────────────────────────────────
echo ""
echo "[6/7] Setting up authentication..."

if command -v gog >/dev/null 2>&1; then
  if [ -n "${GOG_KEYRING_PASSWORD:-}" ]; then
    echo "  GOG keyring password set"
    gog auth keyring file 2>/dev/null || true
  fi
  if [ -f "$CREDENTIALS_LINK/credentials.json" ]; then
    gog auth credentials "$CREDENTIALS_LINK/credentials.json" 2>/dev/null || true
    echo "  GOG credentials loaded"
  fi
  for tokfile in "$CREDENTIALS_LINK"/gog-token*.json; do
    [ -f "$tokfile" ] || continue
    gog auth tokens import "$tokfile" 2>/dev/null || true
    echo "  GOG token imported: $(basename "$tokfile")"
  done
fi

if [ -n "${GITHUB_TOKEN:-}" ]; then
  info "GITHUB_TOKEN set — gh CLI will auto-detect"
fi

# ── 7. Create exec-approvals (auto-approve tools) ────────────────────────────
APPROVALS_FILE="$OPENCLAW_HOME/exec-approvals.json"
cat > "$APPROVALS_FILE" << 'APPROVALS_EOF'
{
  "version": 1,
  "socket": {
    "path": "$HOME/.openclaw/exec-approvals.sock",
    "token": "openclaw-auto-approve"
  },
  "defaults": {
    "security": "full",
    "ask": "off",
    "askFallback": "full",
    "autoAllowSkills": true
  },
  "agents": {
    "*": {
      "security": "full",
      "ask": "off",
      "askFallback": "full"
    },
    "main": {
      "security": "full",
      "ask": "off",
      "askFallback": "full"
    }
  }
}
APPROVALS_EOF
# Replace $HOME with actual path
sed -i '' "s|\$HOME|$HOME|g" "$APPROVALS_FILE" 2>/dev/null || \
  sed -i "s|\$HOME|$HOME|g" "$APPROVALS_FILE" 2>/dev/null || true
info "Exec approvals configured"

# ── Doctor ────────────────────────────────────────────────────────────────────
echo ""
openclaw doctor 2>/dev/null || true

echo ""
info "Setup complete!"
echo ""

# ── Start services (if requested) ────────────────────────────────────────────
if [ "${1:-}" = "start" ]; then
  echo "=== Starting OpenClaw Services ==="
  echo ""

  start_bg() {
    local name="$1"; shift
    local pidfile="$PID_DIR/$name.pid"

    # Kill old instance if running
    if [ -f "$pidfile" ]; then
      old_pid=$(cat "$pidfile")
      kill "$old_pid" 2>/dev/null || true
      rm -f "$pidfile"
    fi

    "$@" &
    local pid=$!
    echo "$pid" > "$pidfile"
    echo "  Started $name (PID $pid)"
  }

  # Cloudflare tunnel (exposes webhook port)
  if command -v cloudflared >/dev/null 2>&1; then
    start_bg tunnel cloudflared tunnel --no-autoupdate \
      --url http://localhost:18790 --metrics 127.0.0.1:45789
  else
    warn "cloudflared not installed — tunnel skipped"
  fi

  # Tunnel watcher
  if command -v cloudflared >/dev/null 2>&1; then
    start_bg tunnel-watcher bash "$REPO_DIR/harness/tunnel-watcher.sh"
  fi

  # Relay (email/SMS polling)
  start_bg relay node "$REPO_DIR/harness/relay.js"

  # Gateway
  start_bg gateway openclaw gateway --port 18789 --auth none

  echo ""
  info "All services started! Use '$0 status' to check or '$0 stop' to stop."
  echo ""
  echo "  Gateway:  http://127.0.0.1:18789"
  echo "  Webhook:  http://127.0.0.1:18790"
  echo "  Browser:  managed by openclaw (system Chrome)"
  echo ""
  echo "  Logs: tail the individual processes or check 'openclaw logs'"
fi

# If no start command, just print next steps
if [ "${1:-}" != "start" ]; then
  echo "Next steps:"
  echo "  bash $0 start    # Start all services"
  echo "  bash $0 stop     # Stop all services"
  echo "  bash $0 status   # Check process status"
  echo ""
  echo "Or start manually:"
  echo "  openclaw gateway --port 18789 --auth none"
fi

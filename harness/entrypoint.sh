#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="/home/clawuser/workspace"

# ── Skills: copy build-time skills into workspace ────────────────────────────
SKILLS_DST="$WORKSPACE/skills"
mkdir -p "$SKILLS_DST"

for SKILLS_SRC in \
  /opt/openclaw-skills/skills \
  /opt/openclaw-skills \
  /home/clawuser/.openclaw/skills \
  /home/clawuser/openclaw/skills; do
  if [ -d "$SKILLS_SRC" ]; then
    for skill_dir in "$SKILLS_SRC"/*/; do
      [ -d "$skill_dir" ] || continue
      skill_name="$(basename "$skill_dir")"
      [ "$skill_name" = "skills" ] && continue
      if [ ! -d "$SKILLS_DST/$skill_name" ]; then
        echo "[entrypoint] Copying skill: $skill_name"
        cp -r "$skill_dir" "$SKILLS_DST/$skill_name"
      fi
    done
  fi
done
rm -rf "$SKILLS_DST/himalaya-email" 2>/dev/null || true

# ── Workspace files: seed templates ──────────────────────────────────────────
OWNER="${OWNER_NAME:-the user}"
OWNER_MAIL="${OWNER_EMAIL:-}"
QH_START="${QUIET_HOURS_START:-23}"
QH_END="${QUIET_HOURS_END:-7}"

PROMPTS_SRC="/home/clawuser/openclaw/prompts"
for mdfile in SOUL.md AGENTS.md USER.md HEARTBEAT.md; do
  if [ -f "$PROMPTS_SRC/$mdfile" ] && [ ! -f "$WORKSPACE/$mdfile" ]; then
    sed -e "s|{{OWNER_NAME}}|$OWNER|g" \
        -e "s|{{OWNER_EMAIL}}|$OWNER_MAIL|g" \
        -e "s|{{QUIET_HOURS_START}}|$QH_START|g" \
        -e "s|{{QUIET_HOURS_END}}|$QH_END|g" \
      "$PROMPTS_SRC/$mdfile" > "$WORKSPACE/$mdfile"
    echo "[entrypoint] Seeded $mdfile"
  fi
done

# ── Xvfb (only if non-headless) ─────────────────────────────────────────────
export DISPLAY=:99
if [ "${STEALTH_BROWSER_HEADLESS:-true}" = "false" ]; then
  rm -f /tmp/.X99-lock || true
  rm -rf /tmp/.X11-unix/X99 || true
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac 2>/dev/null &
  sleep 1
fi

# ── Generate config ──────────────────────────────────────────────────────────
echo "[entrypoint] Generating openclaw.json..."
node "$HOME/openclaw/harness/generate-config.js"

# ── Doctor (read-only — do NOT use --fix, it overwrites our config) ───────────
echo "[entrypoint] Running openclaw doctor..."
openclaw doctor 2>&1 || true

# ── GitHub CLI ───────────────────────────────────────────────────────────────
if [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GH_TOKEN:-}" ]; then
  echo "[entrypoint] GitHub CLI authenticated via env var"
fi

# ── Google Workspace ─────────────────────────────────────────────────────────
CREDS_DIR="/home/clawuser/credentials"
GOG_OK=true

if [ -z "${GOG_KEYRING_PASSWORD:-}" ]; then
  echo "[entrypoint] WARNING: GOG_KEYRING_PASSWORD not set — skipping Google Workspace"
  GOG_OK=false
else
  if ! gog auth keyring file 2>&1; then
    echo "[entrypoint] WARNING: gog keyring init failed — skipping Google Workspace"
    GOG_OK=false
  fi
fi

if [ "$GOG_OK" = true ] && [ -f "$CREDS_DIR/credentials.json" ]; then
  gog auth credentials "$CREDS_DIR/credentials.json" 2>&1 || true
fi

if [ "$GOG_OK" = true ] && ls "$CREDS_DIR"/gog-token*.json 1> /dev/null 2>&1; then
  for tk in "$CREDS_DIR"/gog-token*.json; do
    gog auth tokens import "$tk" 2>&1 || true
  done
  echo "[entrypoint] Google Workspace ready"
fi

# ── Auto-approve all tool execution ───────────────────────────────────────────
# security: "full" = allow all exec without prompts (equivalent to elevated)
# Chat pairing is still enforced via channel allowlists (TELEGRAM_ALLOW_FROM etc).
echo "[entrypoint] Auto-approving all tools (security: full)..."
cat > "$HOME/.openclaw/exec-approvals.json" <<APPROVALS
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
      "askFallback": "full",
      "autoAllowSkills": true,
      "allowlist": [{ "pattern": "*" }]
    },
    "main": {
      "security": "full",
      "ask": "off",
      "askFallback": "full",
      "autoAllowSkills": true,
      "allowlist": [{ "pattern": "*" }]
    }
  }
}
APPROVALS

# ── Pre-seed device pairing to avoid "pairing required" in Docker ────────────
# The gateway's device pairing system blocks CLI/internal connections because
# Docker containers have no interactive pairing flow. Pre-seeding identity +
# paired devices with a synthetic device entry lets the gateway accept local
# connections without requiring a manual pairing approval step.
# See: https://github.com/openclaw/openclaw/issues/55067
IDENTITY_DIR="$HOME/.openclaw/identity"
PAIRING_DIR="$HOME/.openclaw/pairing/devices"
mkdir -p "$IDENTITY_DIR" "$PAIRING_DIR"

if [ ! -f "$IDENTITY_DIR/device.json" ]; then
  echo "[entrypoint] Generating device identity for Docker container..."
  # Generate a random keypair — stable across restarts because the file persists on the volume
  node -e "
    const crypto = require('crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const pubB64 = pubDer.toString('base64url');
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const privB64 = privDer.toString('base64url');
    const deviceId = crypto.createHash('sha256').update(pubDer).digest('hex');
    const identity = {
      deviceId,
      publicKey: pubB64,
      privateKey: privB64,
      createdAt: new Date().toISOString()
    };
    require('fs').writeFileSync('$IDENTITY_DIR/device.json', JSON.stringify(identity, null, 2));
    console.log('[entrypoint] Device identity created: ' + deviceId.slice(0, 12) + '...');
  "
fi

# Pre-approve the container's own device — ALWAYS overwrite (volume may have stale data)
if [ -f "$IDENTITY_DIR/device.json" ]; then
  DEVICE_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$IDENTITY_DIR/device.json','utf8')).deviceId)")
  PUB_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$IDENTITY_DIR/device.json','utf8')).publicKey)")
  NOW_MS=$(node -e "console.log(Date.now())")

  echo "[entrypoint] Pre-approving device $DEVICE_ID for local pairing..."
  cat > "$PAIRING_DIR/paired.json" <<PAIRED
{
  "$DEVICE_ID": {
    "deviceId": "$DEVICE_ID",
    "publicKey": "$PUB_KEY",
    "displayName": "docker-container",
    "platform": "linux",
    "deviceFamily": "server",
    "role": "operator",
    "roles": ["operator"],
    "scopes": ["operator.admin", "operator.write", "operator.read", "operator.pairing"],
    "approvedScopes": ["operator.admin", "operator.write", "operator.read", "operator.pairing"],
    "approvedAtMs": $NOW_MS,
    "clientId": "docker-self",
    "clientMode": "backend"
  }
}
PAIRED
  echo "[entrypoint] Device pre-approved with operator.admin scopes"
fi

# ── Hand off to supervisord ──────────────────────────────────────────────────
echo "[entrypoint] Starting services via supervisord..."
exec supervisord -c "$HOME/openclaw/harness/supervisord.conf"

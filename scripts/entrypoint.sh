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
    sed -e "s/{{OWNER_NAME}}/$OWNER/g" \
        -e "s/{{OWNER_EMAIL}}/$OWNER_MAIL/g" \
        -e "s/{{QUIET_HOURS_START}}/$QH_START/g" \
        -e "s/{{QUIET_HOURS_END}}/$QH_END/g" \
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
node "$HOME/openclaw/scripts/generate-config.js"

# ── Doctor ───────────────────────────────────────────────────────────────────
echo "[entrypoint] Running openclaw doctor..."
openclaw doctor --fix 2>&1 || true

# ── GitHub CLI ───────────────────────────────────────────────────────────────
if [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GH_TOKEN:-}" ]; then
  echo "[entrypoint] GitHub CLI authenticated via env var"
fi

# ── Google Workspace ─────────────────────────────────────────────────────────
CREDS_DIR="/home/clawuser/credentials"
GOG_OK=true

if [ -z "${GOG_KEYRING_PASSWORD:-}" ]; then
  GOG_OK=false
else
  gog auth keyring file 2>&1 || GOG_OK=false
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

# ── Hand off to supervisord ──────────────────────────────────────────────────
# Manages: tunnel, stealth-browser, relay, gateway (all auto-restart)
echo "[entrypoint] Starting services via supervisord..."
exec supervisord -c "$HOME/openclaw/scripts/supervisord.conf"

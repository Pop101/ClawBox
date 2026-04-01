#!/usr/bin/env bash
# Continuously monitors cloudflared tunnel and keeps /tmp/tunnel-url current.
# Re-checks every 30 seconds. If the URL changes (tunnel restart), updates the file.
# If the tunnel goes down, removes the file so consumers know it's unavailable.

TUNNEL_FILE="/tmp/tunnel-url"
CHECK_INTERVAL=30
LAST_URL=""

echo "[tunnel-watcher] Monitoring tunnel..."

while true; do
  URL=""
  # Try the quicktunnel endpoint
  RESP=$(curl -sf http://127.0.0.1:45789/quicktunnel 2>/dev/null)
  if [ -n "$RESP" ]; then
    HOSTNAME=$(echo "$RESP" | grep -o '"hostname":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$HOSTNAME" ]; then
      URL="https://$HOSTNAME"
    fi
  fi

  if [ -n "$URL" ]; then
    if [ "$URL" != "$LAST_URL" ]; then
      echo "$URL" > "$TUNNEL_FILE"
      echo "[tunnel-watcher] URL: $URL"
      LAST_URL="$URL"
    fi
  else
    if [ -f "$TUNNEL_FILE" ]; then
      rm -f "$TUNNEL_FILE"
      echo "[tunnel-watcher] Tunnel down — removed $TUNNEL_FILE"
      LAST_URL=""
    fi
  fi

  sleep "$CHECK_INTERVAL"
done

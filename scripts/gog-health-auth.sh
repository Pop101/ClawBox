#!/bin/bash
set -eu
# Re-authenticate gog with Google Health API scopes included.
# Run on your HOST machine (not inside Docker).
#
# This adds health scopes to your existing gog token so both Google Workspace
# and Google Health API use the same credentials.json + gog-token.json.
#
# Usage: bash scripts/gog-health-auth.sh you@company.com
#
# Prerequisites:
#   1. Enable the Google Health API in your Cloud project:
#      https://console.cloud.google.com/apis/api/health.googleapis.com
#   2. credentials/credentials.json must exist
#   3. gog must be installed on your host

EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then
  echo "Usage: bash scripts/gog-health-auth.sh you@company.com"
  exit 1
fi

HEALTH_SCOPES="https://www.googleapis.com/auth/googlehealth.activity_and_fitness,https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements,https://www.googleapis.com/auth/googlehealth.nutrition,https://www.googleapis.com/auth/googlehealth.sleep"

echo "Re-authenticating gog with health scopes..."
echo "This will open a browser for Google consent."
echo ""

gog auth credentials credentials/credentials.json
gog auth add "$EMAIL" --services user --extra-scopes "$HEALTH_SCOPES" --force-consent
gog auth tokens export "$EMAIL" --out credentials/gog-token.json --overwrite

echo ""
echo "Done! Token saved to credentials/gog-token.json"
echo "Health scopes included. Rebuild: sh rebuild.sh"

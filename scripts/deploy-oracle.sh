#!/bin/bash
set -euo pipefail

# ── Oracle Cloud Container Deployment ─────────────────────────────────────────
# Builds the Docker image, pushes to Oracle Container Registry (OCIR),
# and creates/updates a Container Instance.
#
# Prerequisites:
#   1. pip install oci-cli
#   2. oci setup config
#   3. Generate an Auth Token: OCI Console → User Settings → Auth Tokens
#   4. Set OCI_AUTH_TOKEN env var (or it uses the default below)

# ── CONFIG ────────────────────────────────────────────────────────────────────

fail() { echo "ERROR: $1"; exit 1; }
command -v oci &>/dev/null || fail "OCI CLI not installed. Run: pip install oci-cli && oci setup config"

# Suppress Windows file-permissions warnings from OCI CLI
export OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True

# Load OCI_AUTH_TOKEN from .env if not already set
if [ -z "${OCI_AUTH_TOKEN:-}" ] && [ -f .env ]; then
  OCI_AUTH_TOKEN=$(grep -m1 '^OCI_AUTH_TOKEN=' .env | cut -d= -f2-)
fi
[ -z "${OCI_AUTH_TOKEN:-}" ] && fail "OCI_AUTH_TOKEN is required. Add it to .env or export it. Generate at OCI Console → User Settings → Auth Tokens."

REPO_NAME="${REPO_NAME:-openclaw}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# ── Auto-detect from OCI CLI config ──────────────────────────────────────────

echo "=== Oracle Cloud Deploy ==="
echo "[0] Reading OCI CLI config..."

OCI_CONFIG="${HOME}/.oci/config"
[ -f "$OCI_CONFIG" ] || fail "OCI config not found at ${OCI_CONFIG}. Run: oci setup config"

# Read everything we can directly from the config file (no API calls needed)
cfg_val() { grep -m1 "^${1}=" "$OCI_CONFIG" | cut -d= -f2 | tr -d ' '; }

OCI_TENANCY=$(cfg_val tenancy)
OCI_USER_OCID=$(cfg_val user)
OCI_REGION=$(cfg_val region)
OCI_COMPARTMENT="${OCI_COMPARTMENT:-${OCI_TENANCY}}"

# These require API calls — run with explicit config path
OCI_NAMESPACE=$(oci os ns get --config-file "$OCI_CONFIG" --query 'data' --raw-output)
OCI_USER_NAME=$(oci iam user get --config-file "$OCI_CONFIG" --user-id "${OCI_USER_OCID}" --query 'data.name' --raw-output)
OCI_USERNAME="${OCI_NAMESPACE}/${OCI_USER_NAME}"

# Get first available AD
OCI_AD="${OCI_AD:-$(oci iam availability-domain list --config-file "$OCI_CONFIG" --compartment-id "${OCI_COMPARTMENT}" --query 'data[0].name' --raw-output)}"

# Get first subnet in compartment
OCI_SUBNET="${OCI_SUBNET:-$(oci network subnet list --config-file "$OCI_CONFIG" --compartment-id "${OCI_COMPARTMENT}" --query 'data[0].id' --raw-output 2>/dev/null || echo "")}"

# Derive registry URL from region
REGISTRY_REGION=$(echo "${OCI_REGION}" | awk -F'-' '{print tolower($NF)}')
# Map full region names to OCIR prefixes
case "${OCI_REGION}" in
  us-phoenix-1)   REGISTRY_REGION="phx" ;;
  us-ashburn-1)   REGISTRY_REGION="iad" ;;
  eu-frankfurt-1) REGISTRY_REGION="fra" ;;
  uk-london-1)    REGISTRY_REGION="lhr" ;;
  ap-tokyo-1)     REGISTRY_REGION="nrt" ;;
  *)              REGISTRY_REGION="${OCI_REGION}" ;;
esac
REGISTRY="${REGISTRY_REGION}.ocir.io"
FULL_IMAGE="${REGISTRY}/${OCI_NAMESPACE}/${REPO_NAME}:${IMAGE_TAG}"

echo "  Region:      ${OCI_REGION}"
echo "  Namespace:   ${OCI_NAMESPACE}"
echo "  Username:    ${OCI_USERNAME}"
echo "  Compartment: ${OCI_COMPARTMENT}"
echo "  AD:          ${OCI_AD}"
echo "  Subnet:      ${OCI_SUBNET:-<none>}"
echo "  Registry:    ${REGISTRY}"
echo "  Image:       ${FULL_IMAGE}"
echo ""

# ── Step 1: Build ─────────────────────────────────────────────────────────────

echo "[1/4] Building Docker image (linux/arm64)..."
docker buildx build --platform linux/arm64 -f Dockerfile.ARM -t "${REPO_NAME}:${IMAGE_TAG}" --load .

# ── Step 2: Tag ───────────────────────────────────────────────────────────────

echo "[2/4] Tagging for OCIR..."
docker tag "${REPO_NAME}:${IMAGE_TAG}" "${FULL_IMAGE}"

# ── Step 3: Push ──────────────────────────────────────────────────────────────

echo "[3/4] Logging into OCIR and pushing..."
echo "${OCI_AUTH_TOKEN}" | docker login "${REGISTRY}" -u "${OCI_USERNAME}" --password-stdin
docker push "${FULL_IMAGE}"
echo "  Pushed: ${FULL_IMAGE}"

# ── Step 4: Deploy ────────────────────────────────────────────────────────────

if [ -n "$OCI_COMPARTMENT" ] && [ -n "$OCI_SUBNET" ] && [ "$OCI_SUBNET" != "null" ] && [ -n "$OCI_AD" ]; then
  echo "[4/4] Creating Container Instance on Oracle Cloud..."

  # Load .env vars into a JSON object for container environment
  ENV_JSON="{}"
  if [ -f .env ]; then
    ENV_JSON=$(python -c "
import json, re, os
pairs = {}
with open('.env') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if m:
            key, val = m.group(1), m.group(2)
            # Strip optional surrounding quotes
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('\"', \"'\"):
                val = val[1:-1]
            # Skip OCI-only vars that shouldn't go into the container
            if key.startswith('OCI_'):
                continue
            pairs[key] = val
print(json.dumps(pairs))
" 2>/dev/null || echo "{}")
    echo "  Loaded $(echo "$ENV_JSON" | python -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo '?') env vars from .env"
  fi

  # Check if instance already exists (any state)
  EXISTING=$(oci container-instances container-instance list --config-file "$OCI_CONFIG" \
    --compartment-id "${OCI_COMPARTMENT}" \
    --display-name "openclaw-bot" \
    --query 'data.items[0].id' \
    --raw-output 2>/dev/null || echo "")

  if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ] && [ "$EXISTING" != "null" ]; then
    echo "  Existing instance found: ${EXISTING}"
    echo "  Deleting old instance (OCI doesn't support in-place image updates)..."
    oci container-instances container-instance delete --config-file "$OCI_CONFIG" \
      --container-instance-id "${EXISTING}" --force
    # Wait for deletion to complete
    echo "  Waiting for deletion..."
    for i in $(seq 1 30); do
      STATE=$(oci container-instances container-instance get --config-file "$OCI_CONFIG" \
        --container-instance-id "${EXISTING}" \
        --query 'data."lifecycle-state"' --raw-output 2>/dev/null || echo "DELETED")
      if [ "$STATE" = "DELETED" ] || [ "$STATE" = "null" ]; then
        echo "  Old instance deleted."
        break
      fi
      echo "  State: ${STATE} ... (${i}/30)"
      sleep 10
    done
  fi

  # Build JSON payload files (avoids shell double-quote mangling)
  CONTAINERS_FILE=".oci-containers-tmp.json"
  SECRETS_FILE=".oci-secrets-tmp.json"
  trap "rm -f '$CONTAINERS_FILE' '$SECRETS_FILE'" EXIT

  python -c "
import json, sys
env = json.loads(sys.argv[1])
payload = [{
    'imageUrl': sys.argv[2],
    'displayName': 'openclaw',
    'environmentVariables': env
}]
with open(sys.argv[3], 'w') as f:
    json.dump(payload, f)
" "$ENV_JSON" "$FULL_IMAGE" "$CONTAINERS_FILE"

  B64_USER=$(echo -n "${OCI_USERNAME}" | base64)
  B64_PASS=$(echo -n "${OCI_AUTH_TOKEN}" | base64)
  python -c "
import json, sys
payload = [{
    'registryEndpoint': sys.argv[1],
    'secretType': 'BASIC',
    'username': sys.argv[2],
    'password': sys.argv[3]
}]
with open(sys.argv[4], 'w') as f:
    json.dump(payload, f)
" "$REGISTRY" "$B64_USER" "$B64_PASS" "$SECRETS_FILE"

  echo "  Creating Container Instance with latest image..."
  oci container-instances container-instance create --config-file "$OCI_CONFIG" \
      --compartment-id "${OCI_COMPARTMENT}" \
      --availability-domain "${OCI_AD}" \
      --shape "CI.Standard.A1.Flex" \
      --shape-config '{"ocpus": 1, "memoryInGBs": 6}' \
      --display-name "openclaw-bot" \
      --containers "file://${CONTAINERS_FILE}" \
      --vnics "[{\"subnetId\": \"${OCI_SUBNET}\"}]" \
      --image-pull-secrets "file://${SECRETS_FILE}"
  echo "  Container Instance created."
else
  echo "[4/4] Skipping deploy — set OCI_COMPARTMENT, OCI_SUBNET, and OCI_AD to auto-deploy."
  echo ""
  echo "To deploy manually:"
  echo "  1. Go to OCI Console → Developer Services → Container Instances"
  echo "  2. Create Container Instance"
  echo "  3. Image: ${FULL_IMAGE}"
  echo "  4. Shape: CI.Standard.A1.Flex (1 OCPU, 6 GB RAM)"
  echo "  5. Add your .env vars as environment variables"
fi

echo ""
echo "=== Deploy Complete ==="

# ── Step 5: Stream Logs ──────────────────────────────────────────────────────

if [ -n "$OCI_COMPARTMENT" ]; then
  echo ""
  echo "[5/5] Streaming container logs (Ctrl+C to stop)..."
  echo ""

  # Wait for the instance to be running
  INSTANCE_ID=""
  for i in $(seq 1 30); do
    INSTANCE_ID=$(oci container-instances container-instance list --config-file "$OCI_CONFIG" \
      --compartment-id "${OCI_COMPARTMENT}" \
      --display-name "openclaw-bot" \
      --lifecycle-state ACTIVE \
      --query 'data.items[0].id' \
      --raw-output 2>/dev/null || echo "")
    if [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "None" ] && [ "$INSTANCE_ID" != "null" ]; then
      break
    fi
    echo "  Waiting for instance to become active... (${i}/30)"
    sleep 10
  done

  if [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "None" ] && [ "$INSTANCE_ID" != "null" ]; then
    # Get container ID from the instance
    CONTAINER_ID=$(oci container-instances container-instance get --config-file "$OCI_CONFIG" \
      --container-instance-id "${INSTANCE_ID}" \
      --query 'data.containers[0]."container-id"' \
      --raw-output 2>/dev/null || echo "")

    if [ -n "$CONTAINER_ID" ] && [ "$CONTAINER_ID" != "None" ] && [ "$CONTAINER_ID" != "null" ]; then
      echo "  Tailing logs for container: ${CONTAINER_ID}"
      echo "  -----------------------------------------"
      # Poll logs in a loop since OCI CLI doesn't support follow mode
      PREV_LEN=0
      while true; do
        LOGS=$(oci container-instances container retrieve-logs --config-file "$OCI_CONFIG" \
          --container-id "${CONTAINER_ID}" \
          --raw-output 2>/dev/null || echo "")
        CUR_LEN=${#LOGS}
        if [ "$CUR_LEN" -gt "$PREV_LEN" ] && [ -n "$LOGS" ]; then
          echo "$LOGS" | tail -c +$((PREV_LEN + 1))
          PREV_LEN=$CUR_LEN
        fi
        sleep 5
      done
    else
      echo "  Could not find container ID. Check logs in the OCI Console."
    fi
  else
    echo "  Instance not active after 5 minutes. Check status in the OCI Console."
  fi
fi

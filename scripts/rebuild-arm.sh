#!/bin/sh

set -eu

echo "Stopping existing containers..."
docker compose down --remove-orphans

echo "Enabling QEMU for ARM emulation (if needed)..."
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes 2>/dev/null || true

echo "Rebuilding ARM image..."
docker buildx build --platform linux/arm64 -f Dockerfile.ARM -t openclaw-local:latest --load .

echo "Starting OpenClaw (ARM)..."
docker compose up -d

echo "Done. Following logs..."
docker compose logs -f openclaw-bot

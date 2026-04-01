#!/bin/sh

set -eu

echo "Stopping existing containers..."
docker compose down --remove-orphans

echo "Rebuilding and starting OpenClaw..."
docker compose up --build -d

echo "Done. Following logs..."
docker compose logs -f openclaw-bot
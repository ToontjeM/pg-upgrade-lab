#!/bin/bash
# Build and start the PostgreSQL Upgrade Lab: an old/new pair of containers
# for each of the security, performance, and reliability pillars, plus the
# demo web app.
set -eo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker is not installed or not in PATH." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: Docker Compose (v2 or newer) is not installed or not in PATH." >&2
  exit 1
fi

echo "Building images and starting all 10 Postgres containers + the app..."
docker compose up -d --build

# Pre-pull for the Performance tab's disk-throughput control (server.js
# shells out to a throwaway `alpine` container to apply real cgroup I/O
# throttling) so the first click of that slider doesn't stall on an image
# pull.
docker pull -q alpine >/dev/null 2>&1 || true

echo "Waiting for the demo app to finish bootstrapping (creating the"
echo "replication topology and seeding the ~3.75GB benchmark table --"
echo "a minute or two on first boot) on http://localhost:3000 ..."
for _ in $(seq 1 180); do
  if curl -sf http://localhost:3000/api/health >/dev/null 2>&1; then
    echo "Ready: http://localhost:3000"
    exit 0
  fi
  sleep 2
done

echo "Demo app didn't become ready in time. Check logs with: docker compose logs -f demo-app" >&2
exit 1

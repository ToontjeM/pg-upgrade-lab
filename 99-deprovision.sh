#!/bin/bash
# Stop and remove all containers, networks, and volumes for this demo.
set -eo pipefail

cd "$(dirname "$0")"

docker compose down -v

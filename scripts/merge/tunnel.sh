#!/usr/bin/env bash
# Reach the Supabase database from a development machine.
#
#   scripts/merge/tunnel.sh            # localhost:55433 → Supabase Postgres, until Ctrl-C
#   scripts/merge/tunnel.sh 6543       # another local port
#
# The database container publishes no port. Its address on the Supabase Docker network is
# looked up each time (it can change when the container is recreated), and ssh forwards to it.
# Then use the application's SUPABASE_DATABASE_URL with the host and port replaced:
#
#   postgres://amc_app:<password>@localhost:55433/postgres?sslmode=disable
#
# The password is in the application's Coolify environment (SUPABASE_DATABASE_URL); it is
# not stored anywhere else.
set -euo pipefail
PORT="${1:-55433}"
IP=$(ssh tgbgaws "docker inspect -f '{{(index .NetworkSettings.Networks \"x123f7phha4w5nas4dtq2k50\").IPAddress}}' supabase-db-x123f7phha4w5nas4dtq2k50")
echo "localhost:$PORT → $IP:5432 (Ctrl-C to stop)"
exec ssh -N -o ServerAliveInterval=30 -L "$PORT:$IP:5432" tgbgaws

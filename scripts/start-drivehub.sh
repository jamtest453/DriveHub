#!/bin/sh
# Start the ORIGINAL Python scanning server on a private loopback port.
# Only DriveHub (port 8080) is exposed to the internet.
set -eu
export DATA_DIR="${CAR_SEARCH_DATA_DIR:-/data}"
export APP_PASSWORD="${CAR_SEARCH_PASSWORD:-${APP_PASSWORD:-}}"
export AUTH_SECRET="${CAR_SEARCH_SESSION_SECRET:-${AUTH_SECRET:-}}"
export ENVIRONMENT=production
# Opt-in: each person signs in with Google and keeps their own Car Search data
# in their Google Drive. Reuses DriveHub's Google OAuth client.
if [ "${CAR_SEARCH_GOOGLE_LOGIN:-}" = "on" ]; then
  export GOOGLE_LOGIN_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
fi
export ALLOWED_EMAILS="${CAR_SEARCH_ALLOWED_EMAILS:-}"
export LEGACY_DATA_OWNER="${CAR_SEARCH_OWNER_EMAIL:-}"
/opt/car-search-venv/bin/uvicorn server:app \
  --app-dir /app/tools/car-search/legacy \
  --host 127.0.0.1 --port 3213 --workers 1 &
carhub_pid=$!
node /app/server.js &
drivehub_pid=$!
cleanup(){
  kill "$drivehub_pid" "$carhub_pid" 2>/dev/null || true
  wait "$drivehub_pid" 2>/dev/null || true
  wait "$carhub_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
wait "$drivehub_pid"

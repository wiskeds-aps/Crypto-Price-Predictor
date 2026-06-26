#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

pip install -q -r requirements.txt

mkdir -p data /var/log/caddy

# Start Caddy in background
caddy start --config Caddyfile --adapter caddyfile

# Start FastAPI
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 2

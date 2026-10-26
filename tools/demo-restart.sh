#!/bin/sh
# Startet Demo und Caddy (für Screenshots/Pentest) neu. PIDs liegen in .data/.
cd "$(dirname "$0")/.."
mkdir -p .data
for f in .data/demo.pid .data/caddy.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
sleep 1
node tools/build-web.ts >/dev/null 2>&1
PUBLIC_URL=${PUBLIC_URL:-https://portal.localhost:8443} DEMO_ENV=${DEMO_ENV:-development} nohup node --disable-warning=ExperimentalWarning tools/demo.ts > "${LOGDIR:-/tmp}/demo.log" 2>&1 &
echo $! > .data/demo.pid
(cd tools/caddy && exec caddy run --config Caddyfile.demo --adapter caddyfile) > "${LOGDIR:-/tmp}/caddy.log" 2>&1 &
echo $! > .data/caddy.pid
sleep 4
tail -n 4 "${LOGDIR:-/tmp}/demo.log"

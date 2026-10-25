#!/bin/sh
# Puts the iPad canvas and its 3D preview on the web for a demo, with this laptop doing the CadQuery work.
#
#   1. Start the server:           python3 server.py
#   2. Then, in another terminal:  sh tools/web_demo.sh
#
# It opens a Cloudflare quick tunnel to the server (free, no account; a new address every run),
# deploys the canvas to Vercel built to use that tunnel, and keeps the tunnel open until Ctrl+C.
# The web demo works only while the laptop, the server and this script are running.
# Needs: brew install cloudflared, npm install -g vercel, and `vercel login` once,
# or a token from vercel.com/account/tokens in VERCEL_TOKEN (never commit it).
set -e
cd "$(dirname "$0")/.."

curl -sf http://localhost:8000/api/health >/dev/null || { echo "Start the server first: python3 server.py"; exit 1; }

LOG=$(mktemp)
cloudflared tunnel --no-autoupdate --url http://localhost:8000 >"$LOG" 2>&1 &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null; rm -f "$LOG"' EXIT INT TERM

# A new tunnel address can take a minute or two to be reachable
echo "Opening a tunnel to the laptop..."
URL=""
for i in $(seq 180); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [ -n "$URL" ] && curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  URL=""
  sleep 1
done
[ -n "$URL" ] || { echo "The tunnel did not come up:"; cat "$LOG"; exit 1; }
echo "Tunnel to the laptop: $URL"

SITE=$(vercel deploy --prod --yes ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} --build-env API_BASE="$URL" | tail -1)
echo
echo "Web demo:  $SITE"
echo "If the tunnel restarts, the same site works with:  $SITE/?api=<new tunnel address>"
echo "Keep this running. Ctrl+C closes the tunnel."
wait $TUNNEL

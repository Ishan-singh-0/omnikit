#!/usr/bin/env bash
# =====================================================================
#  tunnel.sh — public PLAIN-HTTP URL for the OMNIKIT relay
#
#  The SIM800L has no TLS, so https:// URLs are useless to it. Pinggy's
#  free SSH tunnel answers on port 80 without redirecting, which is what
#  this script uses.
#
#  Usage (Git Bash on Windows, or any Linux/macOS shell):
#      ./tunnel.sh              # tunnel to port 8080
#      PORT=8080 ./tunnel.sh
#
#  Leave it running. Every time the tunnel is (re)opened it prints the
#  exact line to paste into esp32_gateway.ino:
#      relay http://xxxxx-....a.free.pinggy.link     (typed in the ESP32 Serial Monitor, no reflash)
#
#  Free pinggy sessions end after 60 minutes; this script reopens one
#  automatically and prints the new URL. When the URL changes, type the new
#  "relay http://..." line in the Serial Monitor (115200, newline). No reflash.
#  Start the tunnel before the demo and do not stop it.
# =====================================================================
set -u

# A stray PORT=0 or non-numeric PORT in the environment must not win.
PORT="${PORT:-8080}"
case "$PORT" in ''|*[!0-9]*|0) PORT=8080 ;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/.tunnel.log"
SSH_PID=""

command -v ssh >/dev/null 2>&1 || { echo "ssh not found — install OpenSSH client."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl not found."; exit 1; }

# Make sure the relay is actually up before advertising a URL.
if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/"; then
  echo "WARNING: nothing is answering on http://127.0.0.1:$PORT"
  echo "         start the relay first:  PORT=$PORT node server.js"
  echo
fi

cleanup() {
  [ -n "$SSH_PID" ] && kill "$SSH_PID" 2>/dev/null
  echo
  echo "tunnel closed."
  exit 0
}
trap cleanup INT TERM

banner() {
  local url="$1"
  echo
  echo "======================================================================"
  echo " OMNIKIT relay is public on plain HTTP:"
  echo "   $url"
  echo
  echo " Type this into the ESP32 Serial Monitor (115200 baud, newline):"
  echo "   relay http://${url#http://}"
  echo
  echo " Quick check from this laptop:"
  echo "   curl -X POST -H 'Content-Type: application/json' \\"
  echo "     -d '{\"t\":27.4,\"h\":51,\"p\":1003,\"mq\":1.4}' \\"
  echo "     \"$url/ingest?key=YOUR_DEVICE_KEY\""
  echo "======================================================================"
  echo
}

while true; do
  : > "$LOG"
  ssh -p 443 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes \
      -R0:localhost:"$PORT" free@a.pinggy.io > "$LOG" 2>&1 &
  SSH_PID=$!

  URL=""
  for _ in $(seq 1 40); do
    sleep 1
    URL=$(tr -d '\r' < "$LOG" | grep -Eoi 'https?://[a-z0-9.-]+\.pinggy(-free)?\.link' | head -1)
    [ -n "$URL" ] && break
    kill -0 "$SSH_PID" 2>/dev/null || break
  done

  if [ -z "$URL" ]; then
    echo "could not open a tunnel; retrying in 10 s (log: $LOG)"
    sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' "$LOG" | tail -5
    kill "$SSH_PID" 2>/dev/null
    sleep 10
    continue
  fi

  # pinggy prints https:// but serves http:// on the same host too.
  PLAIN="http://${URL#https://}"
  banner "$PLAIN"

  # Prove it end to end before the user relies on it.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$PLAIN/ingest" 2>/dev/null)
  echo "port-80 reachability check: HTTP $CODE (401 = tunnel + relay both healthy, key required)"

  wait "$SSH_PID"
  SSH_PID=""
  echo
  echo "tunnel dropped (free pinggy sessions last 60 min) — reopening automatically..."
  sleep 3
done

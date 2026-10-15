#!/usr/bin/env bash
# Entry point for the systemd user units: api | worker | ngrok.
set -euo pipefail
cd "$(dirname "$0")/.."
# systemd does not read shell profiles. Prefer the nvm Node: the system one (/usr/bin/node)
# may be older than the project requires.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
case "${1:-}" in
  api) exec node dist/main.js ;;
  worker) exec node dist/worker.js ;;
  ngrok)
    domain=$(grep -E '^NGROK_DOMAIN=' .env | cut -d= -f2- || true)
    [ -n "$domain" ] || { echo 'Set NGROK_DOMAIN in .env' >&2; exit 1; }
    exec ngrok http --url="$domain" --log=stdout 3000
    ;;
  *) echo "usage: $0 api|worker|ngrok" >&2; exit 2 ;;
esac

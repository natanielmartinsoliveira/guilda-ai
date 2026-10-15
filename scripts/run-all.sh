#!/usr/bin/env bash
# Runs API and worker together in one terminal; Ctrl+C (or either one dying) stops both.
# Requires a prior "npm run build".
set -u
cd "$(dirname "$0")/.."
[ -f dist/main.js ] && [ -f dist/worker.js ] || { echo 'Run "npm run build" first' >&2; exit 1; }
node dist/main.js 2>&1 | sed -u 's/^/[api]    /' &
node dist/worker.js 2>&1 | sed -u 's/^/[worker] /' &
trap 'kill $(jobs -p) 2>/dev/null; pkill -P $$ 2>/dev/null' INT TERM EXIT
wait -n
echo 'API or worker stopped; stopping the other.' >&2

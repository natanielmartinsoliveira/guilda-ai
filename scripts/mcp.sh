#!/usr/bin/env bash
# Entry point for editors (e.g. from Windows: wsl.exe -d Ubuntu-24.04 -- bash ~/ai-dev-team/scripts/mcp.sh).
# stdout is the MCP protocol: every other output goes to stderr or nowhere.
set -euo pipefail
cd "$(dirname "$0")/.."
# Prefer the nvm Node: the system one (/usr/bin/node) may be older than the project requires.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
[ -f dist/mcp/server.js ] || { echo 'Run "npm run build" in ai-dev-team first' >&2; exit 1; }
exec node dist/mcp/server.js

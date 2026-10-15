#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --require dotenv/config scripts/test-webhook.cjs "$@"

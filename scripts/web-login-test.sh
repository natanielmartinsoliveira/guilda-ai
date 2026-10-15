#!/usr/bin/env bash
# Manual check of the front login (before the screens exist): password -> Telegram code ->
# session cookie -> /api with the cookie -> logout. The password is read without echo and
# never stored; the cookie lives in a temp file removed at the end.
set -euo pipefail
cd "$(dirname "$0")/.."
url=$(grep -E '^WEB_PUBLIC_URL=' .env | cut -d= -f2- || true)
url=${url:-http://localhost:3000}
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
post() { curl -s -b "$jar" -c "$jar" -H 'Content-Type: application/json' -H "Origin: $url" -X POST "$url$1" -d "$2"; }

read -rsp 'Senha do front: ' password; echo
body=$(node -e 'process.stdout.write(JSON.stringify({password: process.argv[1]}))' "$password")
unset password
answer=$(post /web-api/login "$body")
loginId=$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).loginId||"")}catch{}' "$answer")
if [ -z "$loginId" ]; then echo "Login recusado: $answer"; exit 1; fi
echo 'Senha ok: o código foi enviado no Telegram.'

read -rp 'Código de 6 dígitos: ' code
answer=$(post /web-api/verify "{\"loginId\":\"$loginId\",\"code\":\"$code\"}")
echo "verify: $answer"

echo "me:      $(curl -s -b "$jar" "$url/web-api/me")"
echo "tenants: $(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$url/api/tenants") (200 = sessão aceita na API)"
# Keep a copy: logout clears the jar, and the old cookie must be refused by the server too.
old=$(mktemp)
trap 'rm -f "$jar" "$old"' EXIT
cp "$jar" "$old"
echo "logout:  $(post /web-api/logout '{}')"
echo "me:      $(curl -s -b "$old" "$url/web-api/me") (cookie antigo depois do logout: deve ser false)"

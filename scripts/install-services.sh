#!/usr/bin/env bash
# Installs and starts the systemd *user* units (no sudo). Re-run after updating the units.
#   bash scripts/install-services.sh            # api + worker
#   bash scripts/install-services.sh --ngrok    # plus the webhook tunnel (NGROK_DOMAIN in .env)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/main.js ] || { echo 'Run "npm run build" first' >&2; exit 1; }
units=(ai-dev-team-api ai-dev-team-worker)
[ "${1:-}" = "--ngrok" ] && units+=(ai-dev-team-ngrok)
dest="$HOME/.config/systemd/user"
mkdir -p "$dest"
for u in "${units[@]}"; do cp "deploy/systemd/$u.service" "$dest/"; done
systemctl --user daemon-reload
systemctl --user enable --now "${units[@]}"
systemctl --user --no-pager --lines=0 status "${units[@]}" | grep -E '●|Active:' || true
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo
  echo 'Para os serviços continuarem sem um terminal aberto, rode uma vez:'
  echo "  sudo loginctl enable-linger $USER"
fi
echo
echo "Logs:      journalctl --user -u ai-dev-team-worker -f"
echo "Reiniciar: systemctl --user restart ${units[*]}"
echo "Parar:     systemctl --user stop ${units[*]}"

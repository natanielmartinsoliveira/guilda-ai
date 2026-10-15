#!/usr/bin/env bash
# Downloads the Kenney CC0 packs used by the office and copies the packed sprite sheets and
# their licenses to web/public/assets/office. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
out=web/public/assets/office
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"
fetch() {
  local name=$1 url=$2
  curl -fsSL -o "$tmp/$name.zip" "$url"
  unzip -q -o "$tmp/$name.zip" -d "$tmp/$name"
  grep -q 'Creative Commons Zero' "$tmp/$name/License.txt"
  cp "$tmp/$name/Tilemap/tilemap_packed.png" "$out/$3.png"
  cp "$tmp/$name/License.txt" "$out/LICENSE-$name.txt"
}
fetch tiny-dungeon https://kenney.nl/media/pages/assets/tiny-dungeon/f8422efb44-1674742415/kenney_tiny-dungeon.zip dungeon
fetch tiny-town https://kenney.nl/media/pages/assets/tiny-town/a415fbeb49-1735736916/kenney_tiny-town.zip town
ls -l "$out"

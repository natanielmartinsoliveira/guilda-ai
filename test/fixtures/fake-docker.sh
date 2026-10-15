#!/bin/bash
# Stands in for `docker run` in the remote checks test: writes canned reports into /out.
out=""; side=""; tool=""; prev=""
for a in "$@"; do
  case "$prev" in
    --mount)
      case "$a" in
        *target=/out) out=${a#type=bind,source=}; out=${out%,target=/out} ;;
        *target=/scan/cur*) side=cur ;;
        *target=/scan/base*) side=base ;;
      esac ;;
    --entrypoint) tool=$a ;;
  esac
  prev=$a
done
printf '%s %s\n' "$tool" "$side" >> "${FAKE_DOCKER_LOG:-/dev/null}"
case "$tool" in
  semgrep)
    if [ "$side" = cur ]; then
      printf '%s' '{"results":[{"check_id":"php.lang.security.eval-use","path":"/scan/cur/a b/ção.php","start":{"line":2},"end":{"line":2},"extra":{"message":"Evite   eval","severity":"ERROR"}}]}' > "$out/report.json"
    else
      printf '%s' '{"results":[]}' > "$out/report.json"
    fi ;;
  gitleaks)
    printf '%s' "[{\"RuleID\":\"generic-api-key\",\"File\":\"/scan/$side/a b/ção.php\",\"StartLine\":1,\"Description\":\"chave\",\"Match\":\"sk_****\"}]" > "$out/report.json" ;;
  /osv-scanner) echo "pull access denied" >&2; exit 2 ;;
esac
exit 0

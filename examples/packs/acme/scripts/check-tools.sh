#!/bin/bash
# Example baseline script: reports the tools the company's projects need; installs nothing.
status=0
for tool in git node docker; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "ok: $tool ($("$tool" --version 2>/dev/null | head -1))"
  else
    echo "missing: $tool"
    status=1
  fi
done
exit $status

# Review gate: the direct route runs only where the project allowed direct edits.
import json, sys

ctx = json.load(sys.stdin)
if (ctx.get('vars') or {}).get('direct_edits') is not True:
    sys.exit('Direct route: review-gate.json must set "direct_edits": true (a project decision)')
print('{}')

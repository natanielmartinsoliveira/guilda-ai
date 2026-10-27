# Review gate: after the phases. Sums the telemetry reports the delivery added since the task's
# base commit and prints them per agent (the AI Dev Team keeps that on the task).
import json, subprocess, sys

ctx = json.load(sys.stdin)
root = ctx['vars'].get('telemetry_root') or ''
if not root or not ctx.get('base'):
    print(json.dumps({'agents': {}}))
    sys.exit(0)
added = subprocess.run(
    ['git', 'diff', '--name-only', '--diff-filter=A', ctx['base'], 'HEAD', '--', root],
    capture_output=True, text=True, check=True,
).stdout.split()
agents = {}
for path in [p for p in added if p.endswith('.json')]:
    for name, t in json.load(open(path))['agents'].items():
        a = agents.setdefault(name, {'runs': 0, 'measured': 0, 'durationMs': 0, 'input': 0,
                                     'output': 0, 'cacheCreation': 0, 'cacheRead': 0})
        for key in a:
            a[key] += t.get(key, 0)
print(json.dumps({'agents': agents, 'reports': added}))

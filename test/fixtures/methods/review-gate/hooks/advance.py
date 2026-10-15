# Review gate: a finished rehearsal becomes the accumulated specification; never by force. When
# another rehearsal advanced it first, this one stays in its own folder (not a failure).
import json, os, subprocess, sys

ctx = json.load(sys.stdin)
store = os.path.join(ctx['root'], 'review-gate-store', ctx['project'] + '.git')
pushed = subprocess.run(
    ['git', '-c', 'protocol.file.allow=always', 'push', store, 'HEAD:refs/heads/spec'],
    capture_output=True, text=True,
)
if pushed.returncode != 0:
    print('review-gate.advance_skipped: ' + pushed.stderr[-300:], file=sys.stderr)
print(json.dumps({'advanced': pushed.returncode == 0}))

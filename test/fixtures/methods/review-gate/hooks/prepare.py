# Review gate: runs before every run, in the task folder, with the context as JSON on stdin.
# On the first run the task branch starts from the accumulated specification (a bare repository
# in the workspace whose `spec` branch is the last finished rehearsal). On every run the
# operator's review-gate.json is copied in and kept out of git. The last stdout line (JSON) gives
# the method its variables.
import json, os, shutil, subprocess, sys

ctx = json.load(sys.stdin)
config_from = ctx['options']['configFrom']
LOCAL = ['-c', 'protocol.file.allow=always']


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True, check=True).stdout


if ctx['first']:
    store = os.path.join(ctx['root'], 'review-gate-store', ctx['project'] + '.git')
    if not os.path.isdir(store):
        subprocess.run(['git', 'init', '--bare', '-q', store], check=True)
    if git(*LOCAL, 'ls-remote', store, 'refs/heads/spec').strip():
        git(*LOCAL, 'fetch', '--no-tags', store, 'refs/heads/spec')
        git('reset', '--hard', 'FETCH_HEAD')

source = os.path.join(config_from, 'review-gate.json')
if not os.path.isfile(source):
    sys.exit('review-gate.json is not in ' + config_from + ': create it in your clone and add it to'
             ' its .git/info/exclude')
shutil.copyfile(source, 'review-gate.json')
os.makedirs('.git/info', exist_ok=True)
exclude = '.git/info/exclude'
if '/review-gate.json' not in (open(exclude).read().splitlines() if os.path.exists(exclude) else []):
    open(exclude, 'a').write('/review-gate.json\n')
try:
    cfg = json.load(open('review-gate.json'))
except Exception:
    sys.exit('review-gate.json is not valid JSON')
print(json.dumps({'spec_root': cfg.get('spec_root') or '', 'direct_edits': cfg.get('direct_edits') is True}))

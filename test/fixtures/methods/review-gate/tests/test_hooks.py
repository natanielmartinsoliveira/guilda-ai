# The method's hooks run for real (python3 + git), as the workspace runs them.
# Run: npm run method:check -- <pack folder> review-gate
import json, os, shutil, subprocess, tempfile, unittest

HOOKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'hooks')
COMMIT = 'git -c user.name=a -c user.email=a@a commit -q'


def sh(cwd, cmd):
    return subprocess.run(['sh', '-c', cmd], cwd=cwd, capture_output=True, text=True, check=True).stdout


def hook(name, cwd, data):
    r = subprocess.run(['python3', os.path.join(HOOKS, name)], cwd=cwd, input=json.dumps(data),
                       capture_output=True, text=True)
    last = (r.stdout.strip().split('\n') or [''])[-1]
    try:
        out = json.loads(last)
    except Exception:
        out = {}
    return r.returncode == 0, out, r.stderr


class Hooks(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='method-hooks-')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def task(self, name):
        d = os.path.join(self.root, name)
        os.makedirs(d)
        sh(d, 'git init -q -b main && ' + COMMIT + ' --allow-empty -m base')
        return d

    def data(self, first, config_from):
        return {'first': first, 'project': 'svc', 'root': self.root, 'options': {'configFrom': config_from}}

    def operator(self, cfg):
        d = os.path.join(self.root, 'operator')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'review-gate.json'), 'w') as f:
            json.dump(cfg, f)
        return d

    def test_prepare_puts_the_config_out_of_git_and_returns_its_fields(self):
        op = self.operator({'spec_root': 'docs/spec', 'direct_edits': True})
        d = self.task('t1')
        ok, out, _ = hook('prepare.py', d, self.data(True, op))
        self.assertTrue(ok)
        self.assertEqual(out, {'spec_root': 'docs/spec', 'direct_edits': True})
        self.assertEqual(sh(d, 'git status --porcelain'), '')

    def test_a_missing_config_says_what_to_do(self):
        ok, _, err = hook('prepare.py', self.task('t1'), self.data(True, os.path.join(self.root, 'nowhere')))
        self.assertFalse(ok)
        self.assertIn('review-gate.json', err)

    def test_specification_accumulates_resume_does_not_move_stale_never_overwrites(self):
        op = self.operator({})
        first = self.task('t1')
        self.assertTrue(hook('prepare.py', first, self.data(True, op))[0])
        sh(first, 'mkdir spec && echo n1 > spec/n1.md && git add spec && ' + COMMIT + ' -m spec1')
        self.assertEqual(hook('advance.py', first, self.data(False, op))[1], {'advanced': True})
        second = self.task('t2')
        self.assertTrue(hook('prepare.py', second, self.data(True, op))[0])
        self.assertEqual(sh(second, 'cat spec/n1.md').strip(), 'n1')
        sh(second, COMMIT + ' --allow-empty -m mine')
        head = sh(second, 'git rev-parse HEAD')
        self.assertTrue(hook('prepare.py', second, self.data(False, op))[0])
        self.assertEqual(sh(second, 'git rev-parse HEAD'), head)
        sh(first, 'git reset -q --hard HEAD~1 && ' + COMMIT + ' --allow-empty -m other')
        ok, out, _ = hook('advance.py', first, self.data(False, op))
        self.assertTrue(ok)
        self.assertEqual(out, {'advanced': False})

    def test_direct_route_needs_direct_edits(self):
        run = lambda v: hook('direct.py', self.root, {'vars': v})
        self.assertTrue(run({'direct_edits': True})[0])
        self.assertFalse(run({'direct_edits': False})[0])
        self.assertIn('direct_edits', run({})[2])


if __name__ == '__main__':
    unittest.main()

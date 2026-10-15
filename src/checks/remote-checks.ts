import type { ChecksConfig } from '../tenants/tenants';
import type { CheckTool, Finding } from './checks.service';
/** A finding and its identity across line shifts (code parts hashed in the workspace). */
export interface RemoteRaw {
  key: string;
  finding: Finding;
}
/**
 * Runs inside a company's Coder workspace, in the task folder (cwd), with python3 and docker
 * there. Input (stdin, JSON): base, files, tools, images, semgrep configs, scope, timeout.
 * Copies the changed files as they are (cur/) and as they were at the base (base/), runs the
 * same containers the local checks use, reads the reports there and prints only metadata:
 * rule, file, line, message, severity, plus a comparison key whose code part is a hash.
 * No code leaves the workspace.
 */
export const REMOTE_CHECKS = String.raw`
import hashlib, json, os, re, shutil, stat, subprocess, sys, uuid
cfg = json.load(sys.stdin)
ROOT = os.getcwd()
D = os.path.join(ROOT, '.ai-dev-team', 'checks')
MAX = 2 * 1024 * 1024
LOCK = {'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'poetry.lock',
        'Pipfile.lock', 'requirements.txt', 'go.sum', 'Cargo.lock', 'Gemfile.lock'}
def h(v):
    return hashlib.sha256(v.encode('utf-8', 'surrogateescape')).hexdigest()[:16]
def norm(v):
    return re.sub(r'\s+', ' ', v or '').strip()
def snippet(path, start, end):
    if not start:
        return ''
    try:
        lines = open(path, encoding='utf-8', errors='replace').read().split('\n')
    except OSError:
        return ''
    return norm('\n'.join(lines[start - 1:max(start, end or start)]))
def run_tool(tool, side, targets):
    base_dir = os.path.join(D, side)
    present = [f for f in targets if os.path.isfile(os.path.join(base_dir, f))]
    if not present:
        return []
    mount = '/scan/' + side
    out = os.path.join(D, 'out-' + side)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    os.chmod(out, 0o777)
    if tool == 'semgrep':
        argv = ['semgrep', 'scan', '--metrics=off', '--disable-version-check', '--json', '--output',
                '/out/report.json', '--quiet', '--timeout', '30']
        for c in cfg['semgrep']:
            argv += ['--config', c]
        argv += [mount + '/' + f for f in present]
    elif tool == 'gitleaks':
        argv = ['gitleaks', 'dir', mount, '--no-banner', '--exit-code', '0', '--redact=85',
                '--report-format', 'json', '--report-path', '/out/report.json']
    else:
        argv = ['/osv-scanner', 'scan', 'source', '--format', 'json', '--output-file',
                '/out/report.json'] + [mount + '/' + f for f in present]
    name = 'ai-dev-check-' + uuid.uuid4().hex[:12]
    cmd = ['docker', 'run', '--rm', '--name', name,
           '--network', 'none' if tool == 'gitleaks' else 'bridge',
           '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
           '--pids-limit', '1024', '--memory', '4g', '--cpus', '2', '--workdir', '/src',
           '--mount', 'type=bind,source=' + base_dir + ',target=' + mount + ',readonly',
           '--mount', 'type=bind,source=' + out + ',target=/out',
           '--env', 'HOME=/tmp', '--env', 'SEMGREP_SEND_METRICS=off',
           '--env', 'XDG_CACHE_HOME=/tmp/.cache',
           '--entrypoint', argv[0], cfg['images'][tool]] + argv[1:]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=cfg['timeout'])
    except subprocess.TimeoutExpired:
        subprocess.run(['docker', 'rm', '--force', name], capture_output=True)
        raise Exception('timed out')
    text = (r.stdout or '') + (r.stderr or '')
    if tool == 'osv' and r.returncode == 128 and 'No package sources found' in text:
        return []
    if not (r.returncode == 0 or (tool == 'osv' and r.returncode == 1)):
        raise Exception('exit %s: %s' % (r.returncode, text[-400:]))
    try:
        raw = open(os.path.join(out, 'report.json'), encoding='utf-8').read()
        start = min([i for i in (raw.find('['), raw.find('{')) if i >= 0])
        report = json.loads(raw[start:])
    except Exception:
        raise Exception('no report: ' + text[-400:])
    rel = lambda p: re.sub('^' + re.escape(mount) + '/', '', p or '')
    raws = []
    if tool == 'semgrep':
        for s in report.get('results', []):
            f = rel(s.get('path'))
            line = (s.get('start') or {}).get('line')
            code = snippet(os.path.join(base_dir, f), line, (s.get('end') or {}).get('line'))
            extra = s.get('extra') or {}
            raws.append({'key': '%s|%s|%s' % (s['check_id'], f, h(code)), 'finding': {
                'tool': tool, 'rule': s['check_id'].split('.')[-1], 'file': f, 'line': line,
                'message': norm(extra.get('message'))[:300], 'severity': extra.get('severity')}})
    elif tool == 'gitleaks':
        for g in (report if isinstance(report, list) else []):
            f = rel(g.get('File'))
            raws.append({'key': '%s|%s|%s' % (g.get('RuleID'), f, h(g.get('Match') or '')),
                         'finding': {'tool': tool, 'rule': g.get('RuleID'), 'file': f,
                                     'line': g.get('StartLine'),
                                     'message': g.get('Description') or 'possível segredo'}})
    else:
        for res in report.get('results', []):
            for p in res.get('packages') or []:
                pkg = p.get('package') or {}
                for v in p.get('vulnerabilities') or []:
                    raws.append({'key': '%s|%s' % (v.get('id'), pkg.get('name')), 'finding': {
                        'tool': tool, 'rule': v.get('id'),
                        'file': rel((res.get('source') or {}).get('path')),
                        'message': '%s@%s: %s' % (pkg.get('name'), pkg.get('version') or '?',
                                                  (v.get('summary') or '')[:200])}})
    return raws
result = {'tools': {}, 'errors': []}
shutil.rmtree(D, ignore_errors=True)
try:
    copied = []
    for f in cfg['files']:
        if f.startswith('/') or '..' in f.split('/'):
            continue
        src = os.path.join(ROOT, f)
        try:
            st = os.lstat(src)
        except OSError:
            continue
        # Deleted files cannot introduce anything; symlinks are never followed.
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX:
            continue
        dst = os.path.join(D, 'cur', f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        b = subprocess.run(['git', 'cat-file', 'blob', cfg['base'] + ':' + f], capture_output=True)
        if b.returncode == 0 and len(b.stdout) <= MAX:
            bdst = os.path.join(D, 'base', f)
            os.makedirs(os.path.dirname(bdst), exist_ok=True)
            open(bdst, 'wb').write(b.stdout)
        copied.append(f)
    for side in ('cur', 'base'):
        os.makedirs(os.path.join(D, side), exist_ok=True)
    scope = re.compile(cfg['scope'], re.I) if cfg.get('scope') else None
    for tool in cfg['tools']:
        if tool == 'semgrep':
            targets = [f for f in copied if not scope or scope.search(f)]
        elif tool == 'osv':
            targets = [f for f in copied if os.path.basename(f) in LOCK]
        else:
            targets = copied
        if not targets:
            continue
        try:
            result['tools'][tool] = {'files': len(targets), 'cur': run_tool(tool, 'cur', targets),
                                     'base': run_tool(tool, 'base', targets)}
        except Exception as e:
            result['errors'].append('%s: %s' % (tool, str(e)[:500]))
finally:
    shutil.rmtree(D, ignore_errors=True)
print(json.dumps(result))
`;
/** What the script prints. */
export interface RemoteChecksOutput {
  tools: Partial<Record<CheckTool, { files: number; cur: RemoteRaw[]; base: RemoteRaw[] }>>;
  errors: string[];
}
export function remoteChecksInput(
  cfg: ChecksConfig,
  base: string,
  files: string[],
  timeoutSeconds: number,
) {
  return JSON.stringify({
    base,
    files,
    tools: cfg.tools,
    images: cfg.images,
    semgrep: cfg.semgrep?.configs ?? [],
    scope: cfg.scope,
    timeout: timeoutSeconds,
  });
}

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config } from '../config';
import { KIT_JS, RUN_SH } from './kit';
const segment = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Where a task's prints and trace are kept on this machine (outside every workspace). */
export function evidenceDir(tenant: string, taskId: string) {
  for (const part of [tenant, taskId])
    if (!segment.test(part)) throw new Error(`Invalid evidence path segment: ${part}`);
  return resolve(config().ATTACHMENTS_ROOT, tenant, '.evidence', taskId);
}
/** A local folder with the kit, run.sh and the Playwright version, ready to upload. */
export async function kitDir(version: string, timezone = 'UTC') {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dev-team-kit-'));
  await writeFile(join(dir, 'evidence-kit.cjs'), KIT_JS);
  await writeFile(join(dir, 'run.sh'), RUN_SH, { mode: 0o755 });
  await writeFile(join(dir, 'version'), version);
  await writeFile(join(dir, 'timezone'), timezone);
  return dir;
}

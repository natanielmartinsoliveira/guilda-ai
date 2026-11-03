import { existsSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { TaskError } from '../config';
import type { TaskWorkspace } from '../workspaces/task-workspace';
/** Where the company's references are, in the task folder (out of git with .ai-dev-team/). */
export const KNOWLEDGE_DIR = '.ai-dev-team/knowledge';
export interface KnowledgeFolder {
  path: string;
  about: string;
}
/** frameworks/acme-rules → acme-rules: the folder's name in the task folder. */
export const knowledgeName = (path: string) => basename(path.replace(/\/+$/, ''));
/** Lines for {{KNOWLEDGE}}: where each folder is (from the task folder) and what it holds. */
export function knowledgeList(folders: KnowledgeFolder[] = []) {
  return folders.map((k) => `${KNOWLEDGE_DIR}/${knowledgeName(k.path)}/: ${k.about}`);
}
/**
 * The project's knowledge folders, fresh in the task folder (a folder the pack no longer lists
 * is gone). A folder missing from the pack is the company's configuration: the task stops.
 */
export async function uploadKnowledge(
  ws: TaskWorkspace,
  packDir: string | undefined,
  folders: KnowledgeFolder[] = [],
) {
  if (!folders.length) return;
  await ws.remove(KNOWLEDGE_DIR);
  if (!packDir) throw new TaskError('knowledge: the project has no company pack', false);
  const root = resolve(packDir);
  for (const k of folders) {
    const local = resolve(root, k.path);
    if (!local.startsWith(root + sep) || !existsSync(local) || !statSync(local).isDirectory())
      throw new TaskError(`knowledge: folder "${k.path}" not found in the company pack`, false);
    await ws.upload(local, `${KNOWLEDGE_DIR}/${knowledgeName(k.path)}`);
  }
}

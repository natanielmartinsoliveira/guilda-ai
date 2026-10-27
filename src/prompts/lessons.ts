import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const PROJECT = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** What reaches a prompt: the newest lessons when the files grow past it. */
const MAX_PROMPT_CHARS = 8000;
const MAX_LESSON_CHARS = 1000;
/** The company's lessons for every project ("_" is no project id, so it never collides). */
const COMPANY = '_all';
const file = (packDir: string, name: string) => join(packDir, 'lessons', `${name}.md`);
const items = (path: string) =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).trim())
        .filter(Boolean)
    : [];
/**
 * What the company learned running this project's tasks (lessons/_all.md and
 * lessons/<project>.md in the pack, one "- " line each): the newest that fit, oldest first.
 */
export function projectLessons(packDir: string | undefined, projectId: string): string[] {
  if (!packDir || !PROJECT.test(projectId)) return [];
  const all = [...items(file(packDir, COMPANY)), ...items(file(packDir, projectId))];
  const kept: string[] = [];
  let size = 0;
  for (const lesson of [...all].reverse()) {
    size += lesson.length + 3;
    if (size > MAX_PROMPT_CHARS) break;
    kept.unshift(lesson);
  }
  return kept;
}
/**
 * Adds a lesson to the project's file in the pack, uncommitted: the company reviews it in git
 * and shares it by pushing the pack. One line, so a lesson never breaks the list.
 */
export function addLesson(packDir: string, projectId: string, text: string, origin?: string) {
  if (!PROJECT.test(projectId)) throw new Error(`Invalid project ${JSON.stringify(projectId)}`);
  const lesson = text.replace(/\s+/g, ' ').trim().slice(0, MAX_LESSON_CHARS);
  if (!lesson) throw new Error('Empty lesson');
  const path = file(packDir, projectId);
  mkdirSync(join(packDir, 'lessons'), { recursive: true });
  if (!existsSync(path)) appendFileSync(path, `# ${projectId}\n\n`);
  appendFileSync(path, `- ${lesson}${origin ? ` (${origin})` : ''}\n`);
  return lesson;
}

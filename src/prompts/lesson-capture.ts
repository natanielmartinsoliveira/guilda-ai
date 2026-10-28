import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { log, redact } from '../config';
import { Issue, LessonSuggestion, Project, Task } from '../database/entities';
/** A bare failure becomes a suggestion when it keeps coming back; an answered stop at once. */
export const REPEATS = 3;
const MAX_TEXT = 1000;
const MAX_TASKS = 20;
/**
 * The problem as it repeats across tasks: lowercase, without what changes from one task to
 * the next (ids, hashes, numbers, paths, `quoted` names), on its first line.
 */
export function signatureOf(problem: string) {
  const line = problem.split('\n').find((l) => l.trim()) ?? '';
  const general = line
    .toLowerCase()
    .replace(/`[^`]*`/g, '`?`')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')
    .replace(/\S*\/\S*/g, '/')
    .replace(/\b[0-9a-f]{7,40}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return createHash('sha1').update(general).digest('hex');
}
const clip = (text: string) => redact(text).trim().slice(0, MAX_TEXT);
/** Whether the operator should see it now. */
export const visible = (s: Pick<LessonSuggestion, 'status' | 'answer' | 'count'>) =>
  s.status === 'open' && (!!s.answer || s.count >= REPEATS);
/**
 * Records that a task of a project met a problem (and, for a stop, how the operator answered
 * it). Never fails the task: capture is a side note to the work.
 */
export async function captureLesson(
  db: DataSource | EntityManager,
  taskId: string,
  problem: string,
  answer?: string,
) {
  try {
    if (!problem.trim()) return;
    const task = await db.getRepository(Task).findOneBy({ id: taskId });
    const issue = task && (await db.getRepository(Issue).findOneBy({ id: task.issueId }));
    const project = issue && (await db.getRepository(Project).findOneBy({ id: issue.projectId }));
    if (!task || !project) return;
    const repo = db.getRepository(LessonSuggestion);
    const signature = signatureOf(problem);
    const known = await repo.findOneBy({
      tenantId: task.tenantId,
      projectKey: project.key,
      signature,
    });
    if (!known) {
      await repo.save({
        tenantId: task.tenantId,
        projectKey: project.key,
        signature,
        problem: clip(problem),
        answer: answer ? clip(answer) : null,
        count: 1,
        taskIds: [taskId],
        status: 'open',
      });
      return;
    }
    // A saved or dismissed one stays so: the operator already ruled on it.
    await repo.update(known.id, {
      problem: clip(problem),
      answer: answer ? clip(answer) : known.answer,
      count: known.count + 1,
      taskIds: [...known.taskIds.filter((id) => id !== taskId), taskId].slice(-MAX_TASKS),
    });
  } catch (error) {
    log('lesson.capture_failed', {
      taskId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    });
  }
}
/** The text a saved suggestion becomes: the problem, then how it was answered. */
export function lessonText(s: Pick<LessonSuggestion, 'problem' | 'answer'>) {
  const problem = s.problem.split('\n').find((l) => l.trim()) ?? s.problem;
  return (s.answer ? `${problem} → ${s.answer}` : problem).replace(/\s+/g, ' ').trim();
}

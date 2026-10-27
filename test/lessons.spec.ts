import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addLesson, projectLessons } from '../src/prompts/lessons';
import { renderPrompt } from '../src/prompts/prompt-files';

const pack = () => mkdtempSync(join(tmpdir(), 'lessons-'));

test('a lesson lands in the pack, one line, and reaches the project with the company ones', () => {
  const dir = pack();
  mkdirSync(join(dir, 'lessons'));
  writeFileSync(join(dir, 'lessons', '_all.md'), '# all\n\n- Vale para todo projeto\n');
  expect(projectLessons(dir, 'svc')).toEqual(['Vale para todo projeto']);
  addLesson(dir, 'svc', '  o workspace não tem\ncomposer:   use o wrapper  ', '50484, 2026-10-27');
  expect(readFileSync(join(dir, 'lessons', 'svc.md'), 'utf8')).toBe(
    '# svc\n\n- o workspace não tem composer: use o wrapper (50484, 2026-10-27)\n',
  );
  expect(projectLessons(dir, 'svc')).toEqual([
    'Vale para todo projeto',
    'o workspace não tem composer: use o wrapper (50484, 2026-10-27)',
  ]);
  // another project sees only the company's
  expect(projectLessons(dir, 'other')).toEqual(['Vale para todo projeto']);
});

test('no pack, a bad project id or an empty lesson add nothing; long files keep the newest', () => {
  expect(projectLessons(undefined, 'svc')).toEqual([]);
  const dir = pack();
  expect(() => addLesson(dir, '../x', 'texto')).toThrow(/Invalid project/);
  expect(() => addLesson(dir, 'svc', '   ')).toThrow(/Empty/);
  for (let i = 0; i < 30; i++) addLesson(dir, 'svc', `${'x'.repeat(900)} ${i}`);
  const kept = projectLessons(dir, 'svc');
  expect(kept.length).toBeLessThan(30);
  expect(kept[kept.length - 1]).toMatch(/ 29$/);
});

test('the core prompts carry the lessons only when there are some', async () => {
  const empty = await renderPrompt('coder.md', { LESSONS: [] });
  expect(empty).not.toContain('LESSONS');
  expect(empty).not.toContain('Lições de tarefas anteriores');
  const withLessons = await renderPrompt('coder.md', { LESSONS: ['rode o composer pelo wrapper'] });
  expect(withLessons).toContain('Lições de tarefas anteriores deste projeto');
  expect(withLessons).toContain('- rode o composer pelo wrapper');
});

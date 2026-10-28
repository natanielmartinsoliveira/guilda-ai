import { DataSource } from 'typeorm';
import { database, item } from './db';
import { LessonSuggestion } from '../src/database/entities';
import { OrchestratorService } from '../src/tasks/orchestrator.service';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import {
  captureLesson,
  lessonText,
  REPEATS,
  signatureOf,
  visible,
} from '../src/prompts/lesson-capture';

let db: DataSource;
beforeEach(async () => {
  db = await database();
});
afterEach(async () => {
  await db.destroy();
});
const task = (key = item.externalId) =>
  new OrchestratorService(db, new TenantRegistry()).accept('acme', {
    ...item,
    externalId: key,
    key,
  });

test('the same problem on two tasks has one signature: ids, paths, numbers and names left out', () => {
  expect(
    signatureOf('O agente parou: o slug `50484-a` já é o registro em /w/t1/x.md (3 vezes)'),
  ).toBe(
    signatureOf('O agente parou: o slug `50999-b` já é o registro em /w/t2/y.md (7 vezes)\n- outro'),
  );
  expect(signatureOf('composer: command not found')).not.toBe(
    signatureOf('php: command not found'),
  );
});

test('an answered stop is suggested at once; a bare failure only once it repeats', async () => {
  const first = await task('1');
  await captureLesson(
    db,
    first.id,
    'O agente parou: o slug `a` já é registro\n- detalhe',
    'use o slug -cert',
  );
  const [stop] = await db.getRepository(LessonSuggestion).find();
  expect(stop).toMatchObject({ projectKey: 'demo', count: 1, answer: 'use o slug -cert' });
  expect(visible(stop)).toBe(true);
  expect(lessonText(stop)).toBe('O agente parou: o slug `a` já é registro → use o slug -cert');

  const tasks = [await task('2'), await task('3'), await task('4')];
  for (const [i, t] of tasks.entries()) {
    await captureLesson(db, t.id, `composer: command not found (tentativa ${i})`);
    const failure = await db
      .getRepository(LessonSuggestion)
      .findOneByOrFail({ signature: signatureOf('composer: command not found (tentativa 0)') });
    expect(visible(failure)).toBe(i + 1 >= REPEATS);
    expect(failure.taskIds).toHaveLength(i + 1);
  }
});

test('a dismissed suggestion never comes back; capture never fails the task', async () => {
  const t = await task('5');
  await captureLesson(db, t.id, 'O agente parou: X', 'faça Y');
  const repo = db.getRepository(LessonSuggestion);
  const [s] = await repo.find();
  await repo.update(s.id, { status: 'dismissed' });
  await captureLesson(db, t.id, 'O agente parou: X', 'faça Y de novo');
  const again = await repo.findOneByOrFail({ id: s.id });
  expect(again.status).toBe('dismissed');
  expect(again.count).toBe(2);
  expect(visible(again)).toBe(false);
  await expect(
    captureLesson(db, '00000000-0000-0000-0000-000000000000', 'x'),
  ).resolves.toBeUndefined();
});

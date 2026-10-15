import { describe, expect, test } from 'vitest';
import {
  ago,
  eventTenant,
  matches,
  normalizeKey,
  phaseIndex,
  PHASES,
  replaceTenants,
  sortTasks,
  stageLabel,
  statusLabel,
  validKey,
} from './live';
import type { TaskView } from './types';
const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1',
  tenantId: 'acme',
  branch: 'ai/x',
  status: 'RUNNING',
  stage: 'AGENT',
  provider: 'claude',
  attempts: 1,
  error: null,
  revisions: [],
  attachments: [],
  decisions: [],
  createdAt: '2026-10-06T10:00:00Z',
  updatedAt: '2026-10-06T10:00:00Z',
  ...over,
});
describe('filters', () => {
  test('status filters match what the operator means', () => {
    const none = new Set<string>();
    expect(matches(task({ status: 'PENDING' }), 'active', none)).toBe(true);
    expect(matches(task({ status: 'SUCCESS', prUrl: 'u' }), 'pr', none)).toBe(true);
    expect(matches(task({ status: 'SUCCESS' }), 'pr', none)).toBe(false);
    expect(matches(task({ status: 'FAILED' }), 'failed', none)).toBe(true);
    expect(matches(task({ status: 'CANCELLED' }), 'cancelled', none)).toBe(true);
    expect(matches(task({ status: 'WAITING' }), 'waiting', none)).toBe(true);
    // A failure with an open decision is waiting for the operator too.
    expect(matches(task({ status: 'FAILED' }), 'waiting', new Set(['t1']))).toBe(true);
    // A task with its PR open and a revision running is in progress.
    const revising = task({
      status: 'SUCCESS',
      prUrl: 'u',
      revisions: [{ status: 'RUNNING' } as TaskView['revisions'][number]],
    });
    expect(matches(revising, 'active', none)).toBe(true);
    expect(matches(task(), 'all', none)).toBe(true);
  });
  test('labels', () => {
    expect(statusLabel(task({ status: 'FAILED' }), new Set(['t1']))).toBe('Esperando você');
    expect(statusLabel(task({ status: 'SUCCESS', prUrl: 'u' }), new Set())).toBe('PR aberto');
    expect(statusLabel(task({ status: 'PENDING' }), new Set())).toBe('Na fila');
    expect(stageLabel('TESTS')).toBe('Testes');
    expect(stageLabel('ALGO_NOVO')).toBe('ALGO_NOVO');
  });
});
describe('phases', () => {
  test('stages map to a phase of the timeline; waits are outside it', () => {
    expect(PHASES[phaseIndex('QUEUED')].label).toBe('Fila');
    expect(PHASES[phaseIndex('FIXING')].label).toBe('Testes');
    expect(PHASES[phaseIndex('PULL_REQUEST')].label).toBe('Entrega');
    expect(phaseIndex('DONE')).toBe(PHASES.length);
    expect(phaseIndex('WAITING_INPUT')).toBe(-1);
    expect(phaseIndex('WAITING_CAPACITY')).toBe(-1);
    expect(phaseIndex('DESCONHECIDO')).toBe(0);
  });
  test('front phase stages: design while preparing, front-end while coding', () => {
    expect(stageLabel('DESIGN')).toBe('Lendo o design');
    expect(stageLabel('FRONTEND')).toBe('Fazendo o front-end');
    expect(PHASES[phaseIndex('DESIGN')].label).toBe('Preparo');
    expect(PHASES[phaseIndex('FRONTEND')].label).toBe('Código');
  });
});
describe('helpers', () => {
  test('ago', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(ago('2026-10-06T11:59:30Z', now)).toBe('agora');
    expect(ago('2026-10-06T11:45:00Z', now)).toBe('há 15 min');
    expect(ago('2026-10-06T09:00:00Z', now)).toBe('há 3 h');
    expect(ago('2026-10-04T12:00:00Z', now)).toBe('há 2 d');
  });
  test('newest change first', () => {
    const list = sortTasks([
      task({ id: 'a', updatedAt: '2026-10-06T10:00:00Z' }),
      task({ id: 'b', updatedAt: '2026-10-06T11:00:00Z' }),
    ]);
    expect(list.map((t) => t.id)).toEqual(['b', 'a']);
  });
  test('reloading a tenant replaces only its items', () => {
    const current = [task({ id: 'a' }), task({ id: 'b', tenantId: 'globex' })];
    const next = replaceTenants(current, ['acme'], [task({ id: 'c' })]);
    expect(next.map((t) => t.id).sort()).toEqual(['b', 'c']);
  });
  test('events find their tenant, revisions through the task', () => {
    const tasks = [task({ id: 't1', tenantId: 'globex' })];
    expect(
      eventTenant(
        { type: 'task', id: 't9', taskId: 't9', tenantId: 'acme', status: 'RUNNING' },
        tasks,
      ),
    ).toBe('acme');
    expect(
      eventTenant({ type: 'revision', id: 'r1', taskId: 't1', status: 'RUNNING' }, tasks),
    ).toBe('globex');
    expect(
      eventTenant({ type: 'revision', id: 'r2', taskId: 'nope', status: 'RUNNING' }, tasks),
    ).toBeUndefined();
  });
  test('card keys are normalized and validated', () => {
    expect(normalizeKey('  pf-12 ')).toBe('PF-12');
    expect(validKey('PF-12')).toBe(true);
    expect(validKey('PF12')).toBe(false);
    expect(validKey('12-PF')).toBe(false);
  });
  test('a space where the dash goes becomes the dash; no guessing without one', () => {
    expect(normalizeKey('pf 12')).toBe('PF-12');
    expect(normalizeKey(' pf - 12 ')).toBe('PF-12');
    expect(normalizeKey('pf  -12')).toBe('PF-12');
    // "AB234" could be AB-234 or AB2-34: left as typed, the screen asks for the dash.
    expect(normalizeKey('pf12')).toBe('PF12');
  });
});

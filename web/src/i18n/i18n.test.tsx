import { render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ago, PHASES, stageLabel } from '../live';
import { ROLE_STATUS, SPOTS } from '../office/spots';
import { Login } from '../screens/Login';
import { en } from './en';
import { setLanguage, t } from './index';
import { ptBR } from './pt-BR';

afterEach(() => setLanguage('pt-BR'));

test('both languages have exactly the same keys', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(ptBR).sort());
});

test('a value left out keeps its {name} visible (Review Focus 2)', () => {
  expect(t('ago.minutes', {})).toBe('há {n} min');
});

test('an unknown stage keeps its raw name in both languages (Review Focus 5)', () => {
  expect(stageLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  setLanguage('en');
  expect(stageLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  expect(stageLabel('AGENT')).toBe('Coding');
});

test('English: the guild stations, statuses and timeline phases follow the language', () => {
  setLanguage('en');
  expect(SPOTS.coder.label).toBe('Coder');
  expect(SPOTS.mural.label).toBe('Board (PRs)');
  expect(ROLE_STATUS.reviewer).toBe('Reviewing');
  expect(PHASES.map((p) => p.label)).toContain('Security');
  setLanguage('pt-BR');
  expect(SPOTS.coder.label).toBe('Programador');
});

test('English: login screen, stages and relative times', () => {
  setLanguage('en');
  render(<Login onDone={() => undefined} />);
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  expect(screen.getByLabelText('Password')).toBeTruthy();
  expect(ago(new Date(Date.now() - 5 * 60000).toISOString())).toBe('5 min ago');
  expect(document.documentElement.lang).toBe('en');
});

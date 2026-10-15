import { configSchema } from '../src/config';
import { language, t } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ptBR } from '../src/i18n/pt-BR';
import { WebAuthController } from '../src/web/web-auth.controller';

afterEach(() => delete process.env.GUILDA_LANG);

test('both languages have exactly the same keys', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(ptBR).sort());
});

test('pt-BR by default; en when chosen', () => {
  expect(language()).toBe('pt-BR');
  process.env.GUILDA_LANG = 'en';
  expect(language()).toBe('en');
});

test('a value left out keeps its {name} visible instead of failing', () => {
  const key = Object.keys(ptBR).find((k) => ptBR[k as keyof typeof ptBR].includes('{'))!;
  expect(t(key as keyof typeof ptBR, {})).toMatch(/\{[a-z]+\}/i);
});

test('an unknown language is refused at startup', () => {
  const base = { DATABASE_PASSWORD: 'x', RABBITMQ_URL: 'amqp://localhost' };
  expect(configSchema.safeParse({ ...base, GUILDA_LANG: 'xx' }).success).toBe(false);
  expect(configSchema.safeParse({ ...base, GUILDA_LANG: 'en' }).success).toBe(true);
  expect(configSchema.parse(base).GUILDA_LANG).toBe('pt-BR');
});

test('/web-api/me tells the panel its language, even before login', async () => {
  const controller = new WebAuthController({ session: async () => undefined } as never);
  const req = { get: () => undefined } as never;
  expect(await controller.me(req)).toEqual({ authenticated: false, language: 'pt-BR' });
  process.env.GUILDA_LANG = 'en';
  expect(await controller.me(req)).toEqual({ authenticated: false, language: 'en' });
});

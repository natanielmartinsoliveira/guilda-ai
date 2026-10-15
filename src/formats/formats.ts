import { z } from 'zod';
import type { Tenant, TenantProject } from '../tenants/tenants';
// Deliberately independent from config.ts (imported by tenants.ts, which redact() depends on).
// A blank word would match every line: each one needs a letter or digit.
const words = z
  .array(z.string().trim().min(1).regex(/\w/, 'card: each word needs a letter or digit'))
  .min(1);
/** Filled by the system in the PR template: a section cannot take them over. */
const SYSTEM_PLACEHOLDERS = [
  'BRANCH_URL',
  'KEY',
  'TITLE',
  'ISSUE_URL',
  'MIGRATIONS',
  'TESTS_WRITTEN',
  'TESTS_PASSING',
  'TEST_COMMAND',
  'REVIEW',
  'CHECKS',
];
/** One prose section the agent writes for the PR template (<tag>…</tag> → {{PLACEHOLDER}}). */
const prSection = z.object({
  tag: z.string().regex(/^[a-z][a-z0-9_]*$/, 'tag: lowercase word (letters, digits, _)'),
  // Same shape the templates are filled with ({{UPPER_CASE}}, no digits).
  placeholder: z
    .string()
    .regex(/^[A-Z_]+$/, 'placeholder: UPPER_CASE letters and _')
    .refine((p) => !SYSTEM_PLACEHOLDERS.includes(p), 'placeholder reserved: filled by the system'),
  /** What the agent is asked to write in it. */
  ask: z.string().min(1),
  /** Used when the agent wrote nothing; "card" = the start of the card. */
  fallback: z.string().optional(),
  /** check: "Sim…" → ✅, "Não se aplica" → ➖, anything else → ⬜. */
  kind: z.enum(['text', 'check']).default('text'),
});
export type PrSection = z.infer<typeof prSection>;
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'timezone: unknown IANA time zone (e.g. America/Sao_Paulo, UTC)');
/** `formats:` of a company or a project: every field optional, filled by the layer below. */
export const formatsConfig = z
  .object({
    card: z
      .object({
        /** Titles that open the screen (front-end) section of a card. */
        frontTitles: words.optional(),
        /** Top-level titles that end it. */
        endTitles: words.optional(),
        /** Phrases saying the section has nothing to do ("não se aplica"). */
        nothing: words.optional(),
      })
      .optional(),
    pullRequest: z.object({ sections: z.array(prSection).min(1).optional() }).optional(),
    evidence: z
      .object({
        /** Comment template (relative to the company pack); {{SHOTS}} = the prints. */
        comment: z.string().min(1).optional(),
        /** One print in the comment: {{N}}, {{TITLE}}, {{URL}}, {{AT}}, {{FILE}}. */
        shot: z.string().min(1).optional(),
        timezone: timezone.optional(),
      })
      .optional(),
  })
  .optional();
type FormatsConfig = z.infer<typeof formatsConfig>;
export interface Formats {
  card: { frontTitles: string[]; endTitles: string[]; nothing: string[] };
  pullRequest: { sections: PrSection[] };
  evidence: { comment?: string; shot: string; timezone: string };
}
/** The core's formats: generic words (Portuguese and English), no company's own format. */
export const DEFAULT_FORMATS: Formats = {
  card: {
    frontTitles: ['front-end'],
    endTitles: [
      'back-end',
      'cenários',
      'definições técnicas',
      'critérios de aceite',
      'objetivo',
      'regras',
      'observações',
      'fora do escopo',
      'definition of done',
      'acceptance criteria',
      'test scenarios',
      'technical definitions',
      'business rules',
      'out of scope',
    ],
    nothing: [
      'n/a',
      'na',
      'não se aplica',
      'nenhum',
      'nenhuma',
      'sem alteração',
      'sem alterações',
      'sem mudança',
      'sem mudanças',
      'not applicable',
      'none',
      'no changes',
    ],
  },
  pullRequest: {
    sections: [
      {
        tag: 'problema',
        placeholder: 'PROBLEM',
        ask: 'o problema ou a necessidade que motivou a mudança',
        fallback: 'card',
        kind: 'text',
      },
      {
        tag: 'solucao',
        placeholder: 'SOLUTION',
        ask: 'o que foi feito, de forma objetiva',
        fallback: '(o agente não descreveu a solução; ver commits)',
        kind: 'text',
      },
      {
        tag: 'como_testar',
        placeholder: 'HOW_TO_TEST',
        ask: 'passo a passo para validar a funcionalidade na aplicação',
        fallback: '(a preencher)',
        kind: 'text',
      },
    ],
  },
  evidence: {
    shot: '{{N}}. {{TITLE}} — {{URL}} — {{AT}}\n[imagem {{FILE}}]',
    timezone: 'UTC',
  },
};
function layer(base: Formats, over: FormatsConfig): Formats {
  if (!over) return base;
  return {
    card: { ...base.card, ...strip(over.card) },
    pullRequest: { ...base.pullRequest, ...strip(over.pullRequest) },
    evidence: { ...base.evidence, ...strip(over.evidence) },
  };
}
/** Only the fields that were given (an absent field never erases the layer below). */
function strip<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
/** The formats a project works with: core, then its company, then the project itself. */
export function formatsFor(
  tenant: Pick<Tenant, 'formats'>,
  project: Pick<TenantProject, 'formats'>,
) {
  return layer(layer(DEFAULT_FORMATS, tenant.formats), project.formats);
}

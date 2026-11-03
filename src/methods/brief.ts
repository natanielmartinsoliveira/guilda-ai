import { z } from 'zod';
import type { DecisionBrief } from '../database/entities';
const line = z.string().trim().min(1).max(600);
const schema = z.object({
  summary: line,
  recommendation: z.object({ approve: z.boolean(), why: line }),
  choices: z
    .array(
      z
        .object({
          question: line,
          options: z.array(z.string().trim().min(1).max(200)).min(2).max(4),
          recommended: z.number().int().min(0),
          why: line.optional(),
        })
        .refine((c) => c.recommended < c.options.length, 'recommended is an option'),
    )
    .max(6)
    .default([]),
  risks: z
    .array(z.object({ level: z.enum(['high', 'medium', 'low']), text: line }))
    .max(5)
    .default([]),
  highlights: z.array(line).max(6).default([]),
});
/**
 * The brief in the agent's answer: its last ```json block. Anything that does not read as one is
 * no brief (the question goes as it is): a brief helps the person, it never holds the task.
 */
export function readBrief(message?: string): DecisionBrief | undefined {
  const blocks = [...(message ?? '').matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
/** The brief with every text passed through f (a secret never reaches the operator's screen). */
export function mapBrief(brief: DecisionBrief, f: (text: string) => string): DecisionBrief {
  return {
    summary: f(brief.summary),
    recommendation: { approve: brief.recommendation.approve, why: f(brief.recommendation.why) },
    choices: brief.choices.map((c) => ({
      question: f(c.question),
      options: c.options.map(f),
      recommended: c.recommended,
      ...(c.why ? { why: f(c.why) } : {}),
    })),
    risks: brief.risks.map((r) => ({ level: r.level, text: f(r.text) })),
    highlights: brief.highlights.map(f),
  };
}

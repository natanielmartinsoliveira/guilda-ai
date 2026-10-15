import { AgentResult } from './agent.types';
/**
 * Capacity failures belong to the credential (another one may succeed); "task" failures
 * belong to the work itself and must not burn through every credential.
 */
export type FailureKind = 'quota' | 'rate_limit' | 'auth' | 'task';
// Order matters: a quota message often also says 429.
const patterns: [Exclude<FailureKind, 'task'>, RegExp][] = [
  [
    'quota',
    /insufficient_quota|exceeded your current quota|quota (?:exceeded|exhausted)|credit balance is too low|usage limit|hit your limit|out of credits|billing_hard_limit/i,
  ],
  [
    'auth',
    /invalid[_ -]api[_ -]key|invalid x-api-key|authentication[_ ]error|\b401\b|unauthorized|not logged in|please (?:run .*)?log ?in|token (?:has )?expired|failed to authenticate|oauth (?:session|token) (?:has )?expired/i,
  ],
  ['rate_limit', /\b429\b|rate[_ -]?limit|too many requests|overloaded|\b529\b|try again later/i],
];
/**
 * Classifies only the CLI's own error channel (errorText + stderr tail), never the agent's
 * transcript: a test log mentioning "429" must not look like an exhausted key.
 */
export function classifyFailure(result: AgentResult): FailureKind {
  if (result.success) return 'task';
  const text = `${result.errorText ?? ''}\n${result.stderr.slice(-4000)}`;
  if (/Process timed out|Output limit exceeded|Spawn failed/.test(result.stderr)) return 'task';
  return patterns.find(([, re]) => re.test(text))?.[0] ?? 'task';
}
const units: Record<string, number> = { second: 1 / 60, minute: 1, hour: 60, day: 1440 };
/** "try again in 3 hours", "retry after 20 minutes" → minutes, when the provider says so. */
export function retryAfterMinutes(result: AgentResult): number | undefined {
  const text = `${result.errorText ?? ''}\n${result.stderr.slice(-4000)}`;
  const match =
    /(?:try again|retry)(?: after| in)\s+(\d+(?:\.\d+)?)\s*(second|minute|hour|day)s?/i.exec(text);
  if (!match) return undefined;
  return Math.max(1, Math.ceil(Number(match[1]) * units[match[2].toLowerCase()]));
}

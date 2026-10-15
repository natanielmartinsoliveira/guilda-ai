import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';
import { tenantSecrets } from './tenants/tenants';
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
export const configSchema = z.object({
  PORT: positive(3000),
  DATABASE_HOST: z.string().default('localhost'),
  DATABASE_PORT: positive(5432),
  DATABASE_NAME: z.string().default('ai_dev_team'),
  DATABASE_USER: z.string().default('ai_dev_team'),
  DATABASE_PASSWORD: z.string().min(1),
  RABBITMQ_URL: z.string().url(),
  TENANTS_FILE: z.string().default('tenants.yaml'),
  /** Language of the panel, Telegram, engine questions and core prompts (each dev's .env). */
  GUILDA_LANG: z.enum(['pt-BR', 'en']).default('pt-BR'),
  /** Company pack folders separated by ":"; when set, they replace TENANTS_FILE. */
  GUILDA_PACKS: z.string().default(''),
  /** Operator token for /api (VS Code, MCP). Unset disables the API. */
  API_TOKEN: z.string().min(32).optional(),
  WORKSPACE_ROOT: z.string().default('./workspaces'),
  ATTACHMENTS_ROOT: z.string().default('./attachments'),
  /** Polling sources (Jira) run in the API process; "false" turns them off. */
  SOURCE_POLLING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ATTACHMENT_MAX_BYTES: positive(10 * 1024 * 1024),
  ATTACHMENT_MAX_FILES: positive(10),
  AGENT_HOME: z.string().default('./.agent-home'),
  CODEX_BIN: z.string().default('/usr/local/bin/codex'),
  CLAUDE_BIN: z.string().default('/usr/local/bin/claude'),
  GEMINI_BIN: z.string().default('/usr/local/bin/gemini'),
  BWRAP_BIN: z.string().default('bwrap'),
  DOCKER_BIN: z.string().default('docker'),
  /** Coder CLI, logged in with `coder login`; used by projects in a Coder workspace. */
  CODER_BIN: z.string().default('coder'),
  CODEX_TIMEOUT_MS: positive(1800000),
  CLAUDE_TIMEOUT_MS: positive(1800000),
  TEST_TIMEOUT_MS: positive(600000),
  /** Times the agent gets the failing test output back to fix it; 0 disables. */
  TEST_FIX_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),
  MAX_OUTPUT_BYTES: positive(1048576),
  MAX_ATTEMPTS: positive(3),
  /** Revisions ("/ai ...") accepted per task: bounds cost and comment loops. */
  MAX_REVISIONS: positive(10),
  RETRY_DELAY_MS: positive(30000),
  /** Bot that warns the operator (decisions, PRs); off unless token and chat are both set. */
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  /** The only chat the bot talks to and accepts clicks from. */
  TELEGRAM_CHAT_ID: z
    .string()
    .regex(/^-?\d+$/, 'numeric chat id')
    .optional(),
  /** "false": no message when a PR is opened (decisions are always sent). */
  TELEGRAM_NOTIFY_PR: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Public base URL of the front (e.g. the ngrok domain); links are left out while unset. */
  WEB_PUBLIC_URL: z.string().url().optional(),
  /** scrypt hash of the front password (npm run web:password); the front is off while unset. */
  WEB_PASSWORD_HASH: z
    .string()
    .regex(/^scrypt:\d+:\d+:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/, 'use npm run web:password')
    .optional(),
  /** How often the live updates (SSE) look for changes. */
  EVENTS_POLL_MS: positive(2000),
});
export type Settings = z.infer<typeof configSchema>;
let cached: Settings | undefined;
export function config(): Settings {
  // "KEY=" in .env means "not set": fall back to the default instead of rejecting "".
  return (cached ??= configSchema.parse(
    Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== '')),
  ));
}
const tenantId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export function workspace(tenant: string, taskId: string) {
  if (!tenantId.safeParse(tenant).success) throw new Error('Invalid tenant ID');
  if (!z.uuid().safeParse(taskId).success) throw new Error('Invalid task ID');
  return resolve(config().WORKSPACE_ROOT, tenant, taskId);
}
export function redact(value: string): string {
  const secrets = ['DATABASE_PASSWORD', 'RABBITMQ_URL', 'API_TOKEN', 'TELEGRAM_BOT_TOKEN']
    .map((k) => process.env[k])
    .filter((v): v is string => !!v)
    .concat(tenantSecrets());
  return secrets
    .reduce((out, secret) => out.split(secret).join('[REDACTED]'), value)
    .replace(
      // GitHub, OpenAI/Anthropic, GitLab, Atlassian (Jira/Bitbucket) and Notion token shapes.
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{20,}|AT(?:ATT|BB|CTT)[A-Za-z0-9_=-]{20,}|(?:secret|ntn)_[A-Za-z0-9]{40,})/g,
      '[REDACTED]',
    );
}
export function log(event: string, context: Record<string, unknown> = {}) {
  console.log(redact(JSON.stringify({ time: new Date().toISOString(), event, ...context })));
}
export class TaskError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

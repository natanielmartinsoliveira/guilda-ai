import 'reflect-metadata';
import { resolve } from 'node:path';
Object.assign(process.env, {
  DATABASE_PASSWORD: 'test-password',
  RABBITMQ_URL: 'amqp://localhost',
  TENANTS_FILE: resolve(__dirname, 'fixtures/tenants.yaml'),
  // The operator's .env may point at real packs: tests always use the fixture file.
  GUILDA_PACKS: '',
  GUILDA_LANG: 'pt-BR',
  ACME_GITHUB_TOKEN: 'test-acme-github-token',
  ACME_WEBHOOK_SECRET: 'test-acme-webhook-secret-32-chars',
  ACME_OPENAI_KEY: 'test-acme-openai-key',
  ACME_JIRA_TOKEN: 'test-acme-jira-token',
  SOURCE_POLLING: 'false',
  GLOBEX_GITHUB_TOKEN: 'test-globex-github-token',
  GLOBEX_WEBHOOK_SECRET: 'test-globex-webhook-secret-32-ch',
  GLOBEX_ANTHROPIC_KEY: 'test-globex-anthropic-key',
  MAX_OUTPUT_BYTES: '1024',
  WORKSPACE_ROOT: '/tmp/ai-dev-team-test-workspaces',
  ATTACHMENTS_ROOT: '/tmp/ai-dev-team-test-attachments',
  AGENT_HOME: '/tmp/ai-dev-team-test-agent-home',
  ATTACHMENT_MAX_BYTES: '2048',
  ATTACHMENT_MAX_FILES: '3',
  API_TOKEN: 'test-api-token-with-at-least-32-characters',
  // config.ts loads the real .env, which never overrides these: tests never reach Telegram.
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  WEB_PUBLIC_URL: '',
  EVENTS_POLL_MS: '100',
});

// MCP server (stdio) so editors like Claude Code in VS Code can hand work to the AI Dev Team.
// stdout carries the protocol: nothing else may print to it.
import { config as loadEnv } from 'dotenv';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { contentType, toLocalPath } from './paths';
loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true });
const baseUrl = (
  process.env.AI_DEV_TEAM_URL || `http://localhost:${process.env.PORT || 3000}`
).replace(/\/$/, '');
const maxBytes = Number(process.env.ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024;
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (value: unknown, isError = false): ToolResult => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
  ...(isError ? { isError } : {}),
});
export async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = process.env.API_TOKEN;
  if (!token) throw new Error('API_TOKEN is not set in the AI Dev Team .env');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new Error(`AI Dev Team API unreachable at ${baseUrl}; is "npm run start" running?`);
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`API ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}
const tool =
  <A>(run: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return text(await run(args));
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  };
export async function buildForm(fields: Record<string, string | undefined>, files: string[] = []) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields))
    if (value !== undefined) form.append(name, value);
  for (const original of files) {
    const path = toLocalPath(original);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`Not a readable file: ${original}`);
    if (info.size > maxBytes) throw new Error(`File above ${maxBytes} bytes: ${original}`);
    form.append(
      'files',
      new Blob([await readFile(path)], { type: contentType(path) }),
      basename(path),
    );
  }
  return form;
}
function server() {
  const mcp = new McpServer({ name: 'ai-dev-team', version: '0.1.0' });
  mcp.registerTool(
    'list_tenants',
    {
      title: 'List companies',
      description:
        'Companies (tenants) and projects the AI Dev Team can work on. Call first to choose tenant and project.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    tool(() => call('/api/tenants')),
  );
  mcp.registerTool(
    'create_task',
    {
      title: 'Send task to AI Dev Team',
      description:
        'Queues a coding task. An agent implements it in an isolated clone, runs the project tests and opens a draft PR. ' +
        'Asynchronous: returns a taskId; follow up with get_task. Attach screenshots, specs or logs via files (absolute paths). ' +
        'Write a self-contained description: the agent sees only the repository, the text and the files.',
      inputSchema: {
        tenant: z.string().describe('Tenant id from list_tenants'),
        title: z.string().min(1).max(256),
        description: z
          .string()
          .max(100000)
          .optional()
          .describe('What to do and acceptance criteria'),
        project: z
          .string()
          .optional()
          .describe('Project id; optional when the tenant has only one'),
        files: z.array(z.string()).max(10).optional().describe('Absolute paths of files to attach'),
      },
    },
    tool(async ({ tenant, files, title, description, project }) =>
      call(`/api/tenants/${encodeURIComponent(tenant)}/tasks`, {
        method: 'POST',
        body: await buildForm({ title, description: description ?? '', project }, files),
      }),
    ),
  );
  mcp.registerTool(
    'revise_task',
    {
      title: 'Request changes on a task PR',
      description:
        'Asks the agent to adjust the pull request of a finished task (like commenting "/ai ..." on the PR). ' +
        'It starts from the current PR branch, including human commits, and pushes a new commit; the result ' +
        'is commented on the PR. Asynchronous: follow up with get_task (revisions list). Be specific about ' +
        'what is wrong and what is expected; attach files (absolute paths) when useful.',
      inputSchema: {
        tenant: z.string(),
        taskId: z.string().uuid(),
        instructions: z.string().min(1).max(100000),
        files: z.array(z.string()).max(10).optional().describe('Absolute paths of files to attach'),
      },
    },
    tool(async ({ tenant, taskId, instructions, files }) =>
      call(
        `/api/tenants/${encodeURIComponent(tenant)}/tasks/${encodeURIComponent(taskId)}/revisions`,
        { method: 'POST', body: await buildForm({ instructions }, files) },
      ),
    ),
  );
  mcp.registerTool(
    'get_task',
    {
      title: 'Task status',
      description: 'Status, current stage, error, PR URL and revisions of a task.',
      inputSchema: { tenant: z.string(), taskId: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    tool(({ tenant, taskId }) =>
      call(`/api/tenants/${encodeURIComponent(tenant)}/tasks/${encodeURIComponent(taskId)}`),
    ),
  );
  const jobArgs = {
    tenant: z.string(),
    taskId: z.string().uuid(),
    revision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Revision number, to act on a revision instead of the task itself'),
  };
  const jobPath = (tenant: string, taskId: string, action: string, revision?: number) =>
    `/api/tenants/${encodeURIComponent(tenant)}/tasks/${encodeURIComponent(taskId)}/${action}` +
    (revision ? `?revision=${revision}` : '');
  mcp.registerTool(
    'promote_task',
    {
      title: 'Publish a rehearsal as a draft PR',
      description:
        'Queues a finished rehearsal (stage REHEARSED) to be published: one commit with only the ' +
        "delivery's files on the current base branch, pushed, and a draft PR without reviewers.",
      inputSchema: { tenant: jobArgs.tenant, taskId: jobArgs.taskId },
    },
    tool(({ tenant, taskId }) => call(jobPath(tenant, taskId, 'promote'), { method: 'POST' })),
  );
  mcp.registerTool(
    'retry_task',
    {
      title: 'Retry a failed task',
      description:
        'Queues a FAILED or CANCELLED task (or revision) again, starting over: tasks from the current ' +
        'base branch, revisions from the current PR head. Use after fixing the cause (token, config). ' +
        'Tasks that already have a PR must use revise_task instead.',
      inputSchema: jobArgs,
    },
    tool(({ tenant, taskId, revision }) =>
      call(jobPath(tenant, taskId, 'retry', revision), { method: 'POST' }),
    ),
  );
  mcp.registerTool(
    'cancel_task',
    {
      title: 'Cancel a queued task',
      description:
        'Cancels a task (or revision) that is queued or waiting for AI capacity. A running job is not interrupted.',
      inputSchema: jobArgs,
    },
    tool(({ tenant, taskId, revision }) =>
      call(jobPath(tenant, taskId, 'cancel', revision), { method: 'POST' }),
    ),
  );
  mcp.registerTool(
    'ai_status',
    {
      title: 'AI credentials status',
      description:
        'AI credentials of a tenant in fallback order: which are available, which are parked ' +
        '(quota, rate limit, invalid auth), until when, and the last error. Keys are never shown.',
      inputSchema: { tenant: z.string() },
      annotations: { readOnlyHint: true },
    },
    tool(({ tenant }) => call(`/api/tenants/${encodeURIComponent(tenant)}/ai`)),
  );
  mcp.registerTool(
    'list_tasks',
    {
      title: 'Recent tasks',
      description: 'Most recent tasks of a tenant, newest first.',
      inputSchema: { tenant: z.string(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    tool(({ tenant, limit }) =>
      call(`/api/tenants/${encodeURIComponent(tenant)}/tasks?limit=${limit ?? 20}`),
    ),
  );
  mcp.registerTool(
    'list_decisions',
    {
      title: 'Decisions waiting for the operator',
      description:
        'Questions the AI asked instead of guessing (the task waits) and final failures (retry, ' +
        'retry with instructions or cancel). Open ones by default; all=true includes answered ones.',
      inputSchema: { tenant: z.string(), all: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    tool(({ tenant, all }) =>
      call(`/api/tenants/${encodeURIComponent(tenant)}/decisions${all ? '?status=all' : ''}`),
    ),
  );
  mcp.registerTool(
    'answer_decision',
    {
      title: 'Answer a decision',
      description:
        'For a question decision: answers, one per question in order; the task resumes with them. ' +
        'For a failure decision: action retry, cancel, or retry_with_instructions with instructions.',
      inputSchema: {
        tenant: z.string(),
        decisionId: z.string().uuid(),
        answers: z.array(z.string()).optional(),
        action: z.enum(['retry', 'cancel', 'retry_with_instructions']).optional(),
        instructions: z.string().optional(),
      },
    },
    tool(({ tenant, decisionId, answers, action, instructions }) =>
      call(
        `/api/tenants/${encodeURIComponent(tenant)}/decisions/${encodeURIComponent(decisionId)}/answer`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(answers ? { answers } : { action, instructions }),
        },
      ),
    ),
  );
  return mcp;
}
if (require.main === module)
  void server()
    .connect(new StdioServerTransport())
    .catch((error) => {
      process.stderr.write(`ai-dev-team mcp failed: ${error}\n`);
      process.exitCode = 1;
    });

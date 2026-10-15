import { Injectable } from '@nestjs/common';
import { AgentInput, AgentProvider, ATTACHMENTS_MOUNT } from './agent.types';
/** Matches CODEX_HOME set by the sandbox. */
const CODEX_HOME = '/home/agent/.codex';
/**
 * Other model providers reached through the Codex CLI. They must accept the OpenAI Responses
 * API as Codex sends it: Codex no longer supports chat completions (wire_api = "chat"), and
 * always sends fields such as client_metadata and non-function tools. Groq rejects those (and
 * its free tier allows less per minute than one Codex request); Gemini has no Responses API.
 */
export const CODEX_ENDPOINTS = {
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
  },
} as const;
export type CodexEndpoint = keyof typeof CODEX_ENDPOINTS;
import { ProcessRunnerService } from './process-runner.service';
import { SandboxService } from './sandbox.service';
import { config, TaskError } from '../config';
@Injectable()
export class CodexProvider implements AgentProvider {
  constructor(
    private readonly runner: ProcessRunnerService,
    private readonly sandbox: SandboxService,
  ) {}
  /** endpoint: OpenAI itself, or one of CODEX_ENDPOINTS (key in that endpoint's variable). */
  async execute(input: AgentInput, endpoint: 'openai' | CodexEndpoint = 'openai') {
    const other = endpoint === 'openai' ? undefined : CODEX_ENDPOINTS[endpoint];
    const bin = config().CODEX_BIN;
    let globalHelp = '',
      execHelp = '';
    for (const args of [['--help'], ['exec', '--help']]) {
      const help = await this.runner.run(bin, args, {
        cwd: input.workspace,
        taskId: input.taskId,
        agent: 'capability-check',
        provider: 'codex',
        timeoutMs: 15000,
      });
      if (args[0] === 'exec') execHelp = help.stdout;
      else globalHelp = help.stdout;
      if (
        !help.success ||
        (args[0] === 'exec' &&
          (!help.stdout.includes('--json') || !help.stdout.includes('--sandbox')))
      )
        throw new TaskError(
          'Installed Codex does not expose exec --json --sandbox; inspect codex exec --help',
        );
    }
    if (!globalHelp.includes('--ask-for-approval'))
      throw new TaskError('Codex lacks noninteractive approval policy');
    const optional = ['--ephemeral', '--ignore-user-config', '--ignore-rules'].filter((flag) =>
      execHelp.includes(flag),
    );
    // Images go to the model natively; other files are read from the mount via the prompt.
    const images = (input.attachments?.files ?? [])
      .filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.contentType))
      .map((f) => `${ATTACHMENTS_MOUNT}/${f.name}`);
    // --image takes several values; the following flag ends the list, never the "-" prompt.
    const imageArgs = images.length && execHelp.includes('--image') ? ['--image', ...images] : [];
    // Harness: instructions become Codex's global AGENTS.md; skills go to its skills folder.
    // Codex has no subagents, so harness agents are not used here.
    const harness = input.harness;
    const homeMounts = [
      ...(harness?.instructions
        ? [{ source: harness.instructions, target: `${CODEX_HOME}/AGENTS.md` }]
        : []),
      ...(harness?.skills ?? []).map((s) => ({
        source: s.path,
        target: `${CODEX_HOME}/skills/${s.name}`,
      })),
    ];
    // -c values are TOML; model ids and effort are schema-validated, so quoting is safe.
    const overrides = [
      ...(input.effort
        ? [`model_reasoning_effort="${input.effort === 'max' ? 'xhigh' : input.effort}"`]
        : []),
      ...(other
        ? [
            `model_provider="${endpoint}"`,
            `model_providers.${endpoint}.name="${other.name}"`,
            `model_providers.${endpoint}.base_url="${other.baseUrl}"`,
            `model_providers.${endpoint}.env_key="${other.keyEnv}"`,
            `model_providers.${endpoint}.wire_api="responses"`,
          ]
        : []),
    ];
    if (overrides.length && !execHelp.includes('--config'))
      throw new TaskError('Installed Codex lacks -c/--config overrides');
    const result = await this.sandbox.run(
      bin,
      [
        '--ask-for-approval',
        'never',
        'exec',
        ...imageArgs,
        ...(input.model ? ['--model', input.model] : []),
        ...overrides.flatMap((o) => ['-c', o]),
        '--json',
        '--sandbox',
        input.readOnly ? 'read-only' : 'workspace-write',
        ...optional,
        '-',
      ],
      {
        cwd: input.workspace,
        taskId: input.taskId,
        tenantId: input.tenantId,
        credentialId: input.credentialId,
        apiKey: input.apiKey,
        attachmentsDir: input.attachments?.dir,
        homeMounts,
        readOnly: input.readOnly,
        ...(other ? { apiKeyEnv: other.keyEnv } : {}),
        agent: input.role ?? 'coder',
        provider: other ? endpoint : 'codex',
        timeoutMs: input.timeoutMs,
        input: input.prompt,
      },
      true,
      'codex',
    );
    return result.success
      ? { ...result, message: codexMessage(result.stdout) }
      : { ...result, errorText: codexErrors(result.stdout) };
  }
}
/** Text of the last agent message in `codex exec --json` output (JSONL). */
export function codexMessage(stdout: string): string | undefined {
  let last: string | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      const item = event.item ?? event.msg;
      if (item?.type === 'agent_message') last = item.text ?? item.message ?? last;
    } catch {
      // Not an event line.
    }
  }
  return last;
}
/** Messages of error/failed events in `codex exec --json` output (JSONL), agent chatter excluded. */
export function codexErrors(stdout: string): string | undefined {
  const messages: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: { type?: string; message?: string; error?: { message?: string }; msg?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // Older CLI versions nest the event under "msg".
    const e = (event.msg && typeof event.msg === 'object' ? event.msg : event) as typeof event;
    if (!/error|failed/i.test(e.type ?? '')) continue;
    const message = e.error?.message ?? e.message;
    if (message) messages.push(message);
  }
  return messages.length ? messages.join('\n') : undefined;
}

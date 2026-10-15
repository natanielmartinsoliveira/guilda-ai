import { Injectable } from '@nestjs/common';
import { AgentInput, AgentProvider, ATTACHMENTS_MOUNT } from './agent.types';
import { ProcessRunnerService } from './process-runner.service';
import { SandboxService } from './sandbox.service';
import { config, TaskError } from '../config';
/** Gemini CLI reads its global context file from here (HOME is the sandbox's throwaway home). */
const GEMINI_CONTEXT = '/home/agent/.gemini/GEMINI.md';
/**
 * Gemini CLI (Google AI Studio key). The prompt goes through stdin; -p only switches to
 * headless mode. Edits are auto-approved, shell commands are not: headless mode denies them,
 * so the agent never runs commands (the orchestrator runs the project's tests). Read-only runs
 * use plan mode. Needs Node 20+ as the system `node`, the only one the sandbox sees.
 */
@Injectable()
export class GeminiProvider implements AgentProvider {
  constructor(
    private readonly runner: ProcessRunnerService,
    private readonly sandbox: SandboxService,
  ) {}
  async execute(input: AgentInput) {
    const bin = config().GEMINI_BIN;
    const help = await this.runner.run(bin, ['--help'], {
      cwd: input.workspace,
      taskId: input.taskId,
      agent: 'capability-check',
      provider: 'gemini',
      timeoutMs: 15000,
    });
    if (
      !help.success ||
      !['--prompt', '--output-format', '--approval-mode'].every((f) => help.stdout.includes(f))
    )
      throw new TaskError(
        'Installed Gemini CLI lacks required headless options (needs Node 20+); inspect gemini --help',
      );
    if (!input.apiKey) throw new TaskError('Gemini credentials require apiKey');
    const result = await this.sandbox.run(
      bin,
      [
        '--approval-mode',
        input.readOnly ? 'plan' : 'auto_edit',
        ...(help.stdout.includes('--skip-trust') ? ['--skip-trust'] : []),
        '--output-format',
        'json',
        ...(input.model ? ['--model', input.model] : []),
        // Attachments live outside the workspace: they must be added to it to be readable.
        ...(input.attachments && help.stdout.includes('--include-directories')
          ? ['--include-directories', ATTACHMENTS_MOUNT]
          : []),
        '--prompt',
        'Siga as instruções recebidas na entrada acima.',
      ],
      {
        cwd: input.workspace,
        taskId: input.taskId,
        tenantId: input.tenantId,
        credentialId: input.credentialId,
        apiKey: input.apiKey,
        apiKeyEnv: 'GEMINI_API_KEY',
        attachmentsDir: input.attachments?.dir,
        // The harness instructions become Gemini's global context; it has no skills/subagents.
        homeMounts: input.harness?.instructions
          ? [{ source: input.harness.instructions, target: GEMINI_CONTEXT }]
          : [],
        readOnly: input.readOnly,
        agent: input.role ?? 'coder',
        provider: 'gemini',
        timeoutMs: input.timeoutMs,
        input: input.prompt,
      },
    );
    const out = geminiOutput(result.stdout);
    if (!result.success || out.error)
      return { ...result, success: false, errorText: out.error ?? undefined };
    if (out.response === undefined)
      return { ...result, success: false, stderr: 'Gemini returned invalid JSON' };
    return { ...result, raw: out.raw, message: out.response };
  }
}
/** `gemini -o json` prints {response, stats} or {error: {type, message, code}}. */
export function geminiOutput(stdout: string) {
  // Warnings may precede the JSON document.
  const start = stdout.indexOf('{');
  let raw: { response?: unknown; error?: { message?: string; code?: unknown } } | undefined;
  try {
    raw = start < 0 ? undefined : JSON.parse(stdout.slice(start));
  } catch {
    raw = undefined;
  }
  const error = raw?.error
    ? [raw.error.code && `status ${String(raw.error.code)}`, raw.error.message]
        .filter(Boolean)
        .join(': ')
    : undefined;
  return {
    raw,
    error,
    response: typeof raw?.response === 'string' ? raw.response : undefined,
  };
}

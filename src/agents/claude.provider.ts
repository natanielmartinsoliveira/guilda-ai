import { Injectable } from '@nestjs/common';
import { AgentInput, AgentProvider, AgentResult, ATTACHMENTS_MOUNT } from './agent.types';
/** Matches CLAUDE_CONFIG_DIR set by the sandbox. */
const CLAUDE_HOME = '/home/agent/.claude';
const HARNESS_INSTRUCTIONS = '/home/agent/harness-instructions.md';
import { ProcessRunnerService } from './process-runner.service';
import { SandboxService } from './sandbox.service';
import { config, TaskError } from '../config';
import { changedRepositories, CoderWorkspace } from '../workspaces/coder-workspace';
import { shellQuote } from '../workspaces/shell';
const REQUIRED = ['--print', '--output-format', '--permission-mode'];
@Injectable()
export class ClaudeProvider implements AgentProvider {
  constructor(
    private readonly runner: ProcessRunnerService,
    private readonly sandbox: SandboxService,
  ) {}
  async execute(input: AgentInput) {
    if (input.remote) return this.executeRemote(input, input.remote);
    const bin = config().CLAUDE_BIN;
    const help = await this.runner.run(bin, ['--help'], {
      cwd: input.workspace,
      taskId: input.taskId,
      agent: 'capability-check',
      provider: 'claude',
      timeoutMs: 15000,
    });
    if (!help.success || !REQUIRED.every((flag) => help.stdout.includes(flag)))
      throw new TaskError(
        'Installed Claude lacks required noninteractive options; inspect claude --help',
      );
    const harness = input.harness;
    const homeMounts = [
      ...(harness?.skills ?? []).map((s) => ({
        source: s.path,
        target: `${CLAUDE_HOME}/skills/${s.name}`,
      })),
      ...(harness?.agents ?? []).map((a) => ({
        source: a.path,
        target: `${CLAUDE_HOME}/agents/${a.name}.md`,
      })),
      ...(harness?.instructions
        ? [{ source: harness.instructions, target: HARNESS_INSTRUCTIONS }]
        : []),
    ];
    const instructions =
      harness?.instructions && help.stdout.includes('--append-system-prompt')
        ? ['--append-system-prompt-file', HARNESS_INSTRUCTIONS]
        : [];
    const result = await this.sandbox.run(
      bin,
      this.flags(
        help.stdout,
        input,
        input.attachments ? ATTACHMENTS_MOUNT : undefined,
        instructions,
      ),
      {
        cwd: input.workspace,
        taskId: input.taskId,
        tenantId: input.tenantId,
        credentialId: input.credentialId,
        apiKey: input.apiKey,
        attachmentsDir: input.attachments?.dir,
        homeMounts,
        readOnly: input.readOnly,
        agent: input.role ?? 'coder',
        provider: 'claude',
        timeoutMs: input.timeoutMs,
        input: input.prompt,
      },
      true,
      'claude',
    );
    return this.parse(result);
  }
  /** The CLI flags, from what this Claude's --help offers. */
  private flags(
    help: string,
    input: AgentInput,
    attachments: string | undefined,
    instructions: string[],
    /** user: settings only from the throwaway home; user,project: also the repository's. */
    sources = 'user',
  ) {
    // Repository CLAUDE.md/AGENTS.md are read (project guidance), but settings files — where
    // hooks and plugins live — come only from the throwaway home, and MCP servers declared by
    // the repository are ignored. The tenant harness is the only customization added.
    const optional = [
      '--no-session-persistence',
      ...(help.includes('--setting-sources') ? ['--setting-sources', sources] : []),
      '--strict-mcp-config',
    ].filter((flag) => !flag.startsWith('--') || help.includes(flag));
    const permissionPrompts = help.includes('--permission-prompts')
      ? ['--permission-prompts', 'none']
      : [];
    // File tools are confined to working directories; the attachments folder must be added.
    // --add-dir is variadic, so it goes first and the next flag closes its list.
    const addDir = attachments && help.includes('--add-dir') ? ['--add-dir', attachments] : [];
    // Read-only runs (reviewer, planner): the workspace is mounted read-only anyway; denying
    // the edit tools keeps the model from spending tokens on edits that cannot land.
    const readOnly =
      input.readOnly && help.includes('--disallowed-tools')
        ? ['--disallowed-tools', 'Edit,Write,NotebookEdit']
        : [];
    const effort = input.effort && help.includes('--effort') ? ['--effort', input.effort] : [];
    // A method's agent runs its own tools with nobody to approve them (one comma list: the flag
    // is variadic like --add-dir, and the next flag closes it).
    const allowed =
      input.allowedTools?.length && help.includes('--allowedTools')
        ? ['--allowedTools', input.allowedTools.join(',')]
        : [];
    return [
      ...addDir,
      ...allowed,
      ...readOnly,
      '--print',
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      ...optional,
      ...permissionPrompts,
      ...instructions,
      ...(input.model ? ['--model', input.model] : []),
      ...effort,
    ];
  }
  /**
   * Inside the company's Coder workspace, with the Claude login stored there (its account):
   * nothing is mounted or copied, and the operator's clones are checked before and after.
   */
  private async executeRemote(input: AgentInput, ws: CoderWorkspace) {
    const base = {
      taskId: input.taskId,
      provider: 'claude',
      timeoutMs: 15000,
      at: 'none' as const,
    };
    const help = await ws.run(['claude', '--help'], { ...base, agent: 'capability-check' });
    if (!help.success || !REQUIRED.every((flag) => help.stdout.includes(flag)))
      throw new TaskError(
        `Claude do workspace ${ws.cfg.name} sem as opções não interativas; confira claude --help`,
      );
    const login = await ws.run(['sh', '-c', 'test -s "$HOME/.claude/.credentials.json"'], {
      ...base,
      agent: 'login-check',
    });
    if (!login.success)
      throw new TaskError(
        `Claude sem login no workspace ${ws.cfg.name}: abra o terminal do workspace, rode claude e /login com a conta da empresa`,
        false,
      );
    if (input.attachments) await ws.upload(input.attachments.dir, '.ai-dev-team/attachments');
    const own = async () =>
      (
        await ws.run(
          ['sh', '-c', 'git rev-parse HEAD; GIT_OPTIONAL_LOCKS=0 git status --porcelain | sha1sum'],
          { taskId: input.taskId, agent: 'readonly-check', timeoutMs: 60000 },
        )
      ).stdout;
    const before = await ws.protectSnapshot(input.taskId);
    const ownBefore = input.readOnly ? await own() : undefined;
    // The company's own harness: the repository's CLAUDE.md, skills, commands and enabled
    // plugins, as when its developers use Claude in that workspace.
    const flags = this.flags(
      help.stdout,
      input,
      input.attachments ? ws.attachmentsPath : undefined,
      [],
      'user,project',
    );
    // A method's extra folders ("~/…" in the workspace HOME, which only its shell knows).
    const dirs = (help.stdout.includes('--add-dir') ? (input.addDirs ?? []) : []).map((d) =>
      d.startsWith('~/') ? `"$HOME"/${shellQuote(d.slice(2))}` : shellQuote(d),
    );
    const result = await ws.run(
      dirs.length
        ? [
            'sh',
            '-c',
            `exec claude ${dirs.map((d) => `--add-dir ${d}`).join(' ')} "$@"`,
            'sh',
            ...flags,
          ]
        : ['claude', ...flags],
      {
        taskId: input.taskId,
        agent: input.role ?? 'coder',
        provider: 'claude',
        timeoutMs: input.timeoutMs,
        input: input.prompt,
        env: input.env,
      },
    );
    const changed = changedRepositories(before, await ws.protectSnapshot(input.taskId));
    if (changed.length)
      throw new TaskError(
        `O agente alterou repositórios fora da pasta da tarefa: ${changed.join(', ')}. Se foi você editando no VS Code ao mesmo tempo, repita a tarefa. Nada foi desfeito.`,
        false,
      );
    if (ownBefore !== undefined && ownBefore !== (await own()))
      throw new TaskError(
        'Execução somente leitura (revisor/planejador) alterou a pasta da tarefa',
        false,
      );
    return this.parse(result);
  }
  private parse(result: AgentResult): AgentResult {
    let raw:
      | { is_error?: boolean; result?: unknown; api_error_status?: unknown; modelUsage?: unknown }
      | undefined;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      raw = undefined;
    }
    // Which models answered (the session's and its subagents'): ids only, never content.
    const usage = raw?.modelUsage;
    const models =
      usage && typeof usage === 'object' && !Array.isArray(usage)
        ? Object.keys(usage)
            .filter((m) => /^[A-Za-z0-9._:@/-]{1,100}$/.test(m))
            .sort()
        : [];
    if (models.length) result = { ...result, models };
    // The final JSON carries the API error (credits, limits) even when the exit code is non-zero.
    const errorText = raw?.is_error
      ? [raw.api_error_status && `status ${raw.api_error_status}`, raw.result]
          .filter(Boolean)
          .join(': ')
      : undefined;
    if (!result.success) return { ...result, raw, errorText };
    if (!raw) return { ...result, success: false, stderr: 'Claude returned invalid JSON' };
    if (raw.is_error) return { ...result, success: false, raw, errorText };
    return { ...result, raw, message: typeof raw.result === 'string' ? raw.result : undefined };
  }
}

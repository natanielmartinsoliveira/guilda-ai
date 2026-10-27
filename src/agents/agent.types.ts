import type { Attachment } from '../attachments/attachments';
import type { ResolvedHarness } from './harness';
import type { AiEffort, AiRole } from '../tenants/tenants';
import type { CoderWorkspace } from '../workspaces/coder-workspace';
export const ATTACHMENTS_MOUNT = '/attachments';
export interface AgentInput {
  taskId: string;
  tenantId: string;
  /** Credential id: selects the isolated CLI home (login) under AGENT_HOME/<tenant>/. */
  credentialId: string;
  /** The credential's key; absent when the CLI uses a stored login. */
  apiKey?: string;
  model?: string;
  effort?: AiEffort;
  /** What the run is for (audit, and the CLI's own agent label). Default: coder. */
  role?: AiRole;
  /** The agent may read the workspace but never change it (reviewer, planner). */
  readOnly?: boolean;
  /** Host directory mounted read-only at ATTACHMENTS_MOUNT, and the files it holds. */
  attachments?: { dir: string; files: Attachment[] };
  /** The tenant's AI harness (skills, subagents, instructions), resolved for this run. */
  harness?: ResolvedHarness;
  prompt: string;
  workspace: string;
  /** Set for coder workspaces: the CLI runs there, with its own login (nothing mounted). */
  remote?: CoderWorkspace;
  /** Extra environment for a remote run (e.g. the git identity a method's commits need). */
  env?: Record<string, string>;
  /** A method's agent: folders it may read in the workspace ("~/…" = the workspace HOME). */
  addDirs?: string[];
  /** A method's agent: tools/commands it may run with nobody to approve them. */
  allowedTools?: string[];
  /** A method's agent: the CLI keeps its session transcripts (its tools read them). */
  keepSessions?: boolean;
  timeoutMs: number;
}
export interface AgentResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  raw?: unknown;
  /** The provider's own error message, extracted from its structured output. */
  errorText?: string;
  /** The agent's final message (its summary), extracted from its structured output. */
  message?: string;
  /** Models the run really used (main session and subagents), as the provider reports them. */
  models?: string[];
  /** What the run cost, as the provider reports it (USD). */
  costUsd?: number;
  /** Tokens, turns and time, as the provider reports them (counts only, never content). */
  usage?: RunUsage;
  /** The agent_runs row of the command that produced this result. */
  runId?: string;
}
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}
export interface RunUsage extends TokenUsage {
  durationMs?: number;
  /** Time spent waiting on the model's API, within durationMs. */
  apiDurationMs?: number;
  turns?: number;
  /** Per model (the session's and its subagents'). */
  byModel?: Record<string, TokenUsage & { costUsd?: number }>;
}
export interface AgentProvider {
  execute(input: AgentInput): Promise<AgentResult>;
}

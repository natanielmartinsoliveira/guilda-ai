export type Status = 'PENDING' | 'RUNNING' | 'WAITING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export interface Tenant {
  concurrency?: number;
  officeTheme?: 'guild' | 'studio' | 'pipeline';
  id: string;
  name: string;
  providers: string[];
  jira: boolean;
  /** Sources that start a card the operator names by its key. */
  sources?: {
    id: string;
    type: string;
    label: string;
    key: 'jira' | 'number';
    example: string;
    bases: boolean;
    /** The operator may state the route of the project's method when starting a card. */
    routes?: boolean;
  }[];
  /** A project with a company method: the operator picks one of its routes for each change. */
  projects: {
    id: string;
    repository: string;
    method?: string;
    routes?: { id: string; label: string }[];
  }[];
}
export interface AgentAttempt {
  credential: string;
  provider: string;
  role?: string;
  model?: string;
  effort?: string;
  outcome: string;
  error?: string;
  /** The models the run really used (session and subagents). */
  usedModels?: string[];
  /** What the run cost (USD), as the provider reported it. */
  costUsd?: number;
}
export interface RevisionView {
  id: string;
  number: number;
  instructions: string;
  origin: string;
  requestedBy?: string;
  status: Status;
  stage: string;
  error: string | null;
  commitSha?: string;
  agentAttempts?: AgentAttempt[];
  createdAt: string;
}
export interface RunView {
  agent: string;
  provider: string;
  status: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}
export interface TaskView {
  id: string;
  /** What the task's AI runs cost so far (USD). */
  costUsd?: number;
  tenantId: string;
  project?: string;
  branch: string;
  key?: string;
  title?: string;
  source?: string;
  url?: string;
  status: Status;
  stage: string;
  provider: string;
  attempts: number;
  error: string | null;
  prUrl?: string;
  agentAttempts?: AgentAttempt[];
  /** Coder workspace in rehearsal: nothing published; the commit stays there to be checked. */
  rehearsal?: {
    workspace: string;
    branch: string;
    commitSha: string;
    files: string[];
    discarded?: boolean;
    /** Published as a draft PR (it is a delivery now). */
    promoted?: boolean;
  };
  /** A failed/cancelled coder task whose folder was removed. */
  discarded?: boolean;
  /** Test evidence for the audit: framed prints and the comment to paste on the card. */
  evidence?: {
    shots: { file: string; title: string; url: string; at: string }[];
    comment: string;
    trace: boolean;
  };
  revisions: RevisionView[];
  attachments: string[];
  review?: {
    final: 'approved' | 'changes-addressed' | 'skipped';
    rounds: unknown[];
    skipped?: string;
  };
  checks?: { findings: unknown[]; tools: Record<string, unknown>; errors: string[] };
  decisions: {
    id: string;
    type: 'question' | 'failure';
    status: 'open' | 'answered';
    revisionId: string | null;
    createdAt: string;
  }[];
  runs?: RunView[];
  createdAt: string;
  updatedAt: string;
}
export interface DecisionQuestion {
  text: string;
  options?: string[];
}
export interface DecisionView {
  id: string;
  tenantId: string;
  type: 'question' | 'failure';
  status: 'open' | 'answered';
  taskId: string;
  revisionId: string | null;
  card: string | null;
  title: string | null;
  questions: DecisionQuestion[] | null;
  reason: string | null;
  details: string | null;
  answer: unknown;
  createdAt: string;
  answeredAt: string | null;
}
export type DecisionAnswer =
  | { answers: string[] }
  | { action: 'retry' | 'cancel' }
  | { action: 'retry_with_instructions'; instructions: string };
export type StartResult = { taskId: string } | { skipped: string; taskId?: string };
/** Where a sub-task started on its own may begin (story branch, sibling branches). */
export type SubtaskBases =
  | { subtask: false }
  | {
      subtask: true;
      story: string;
      storyBranch: string;
      ownBranch?: string;
      ownExists: boolean;
      bases: { branch: string; label: string; date: string }[];
    };
export interface ChangeEvent {
  type: 'task' | 'revision' | 'decision';
  id: string;
  taskId: string;
  tenantId?: string;
  status: string;
  stage?: string;
}

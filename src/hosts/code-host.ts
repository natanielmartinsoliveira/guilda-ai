export interface ChangeRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
}
export interface PullRequestInput {
  branch: string;
  base: string;
  title: string;
  body: string;
  /** Hosts that support it open the PR as a draft (Bitbucket always does). */
  draft?: boolean;
  /** Usernames asked to review, on hosts that support it. */
  reviewers?: string[];
}
/** A reviewer's comment on a pull request; path/line for comments on a line of code. */
export interface ReviewComment {
  id: string;
  author: string;
  /** The author's login, when the host gives one (GitLab username). */
  authorId?: string;
  body: string;
  /** ISO timestamp; comments are read "since" the newest one already handled. */
  createdAt: string;
  path?: string;
  line?: number;
  /** Written by an app/bot account (e.g. a pipeline's quality agent), not by a person. */
  bot?: boolean;
  /** A reply inside another comment's thread. */
  reply?: boolean;
}
/** Where a project's code lives: clone/push credentials and pull request creation. */
export interface CodeHost {
  readonly id: string;
  cloneUrl(repository: string): string;
  /** HTTP header git sends for clone/push; never written to disk or remotes. */
  gitAuthHeader(): string;
  /** For ssh remotes cloned in a workspace: the command git uses for ssh (GIT_SSH_COMMAND). */
  gitSshCommand?(): string;
  /** Idempotent: returns the existing pull request for the branch when there is one. */
  ensurePullRequest(repository: string, input: PullRequestInput): Promise<ChangeRequest>;
  commentOnPullRequest(repository: string, number: number, body: string): Promise<void>;
  /**
   * Open comments on a pull request created after `since` (conversation and lines of code),
   * oldest first. Resolved and deleted comments are left out.
   */
  pullRequestComments(repository: string, number: number, since?: string): Promise<ReviewComment[]>;
  /** Last commit date (ISO) of a branch; undefined when the branch does not exist. */
  branchDate(repository: string, branch: string): Promise<string | undefined>;
  /** The default branch and the names at its root; undefined when the repository is unknown. */
  repositoryInfo?(repository: string): Promise<RepositoryInfo | undefined>;
}
export interface RepositoryInfo {
  defaultBranch: string;
  files: string[];
}

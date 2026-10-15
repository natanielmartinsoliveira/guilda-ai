import { TaskError } from '../config';
import { ChangeRequest, CodeHost, PullRequestInput, ReviewComment } from './code-host';
interface GithubPR {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
}
export class GithubHost implements CodeHost {
  constructor(
    readonly id: string,
    private readonly token: string,
  ) {}
  cloneUrl(repository: string) {
    return `https://github.com/${repository}.git`;
  }
  gitAuthHeader() {
    return `Authorization: Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`;
  }
  async request<T>(repository: string, path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new TaskError('GitHub network request failed', true);
    }
    if (!response.ok)
      throw new TaskError(
        `GitHub ${method} ${path.split('?')[0]} returned ${response.status}`,
        response.status >= 500 ||
          response.status === 429 ||
          (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'),
      );
    return response.json() as Promise<T>;
  }
  async branchDate(repository: string, branch: string) {
    try {
      const ref = await this.request<{ commit?: { commit?: { committer?: { date?: string } } } }>(
        repository,
        `/branches/${encodeURIComponent(branch)}`,
      );
      return ref?.commit?.commit?.committer?.date;
    } catch (error) {
      if (error instanceof TaskError && error.message.endsWith(' returned 404')) return undefined;
      throw error;
    }
  }
  async pullRequestComments(repository: string, number: number, since?: string) {
    const after = since ? `&since=${encodeURIComponent(since)}` : '';
    // Conversation comments (the issue side of the PR) and comments on lines of code.
    const [conversation, lines] = await Promise.all([
      this.request<GithubComment[]>(repository, `/issues/${number}/comments?per_page=100${after}`),
      this.request<GithubComment[]>(
        repository,
        `/pulls/${number}/comments?per_page=100&sort=created&direction=asc${after}`,
      ),
    ]);
    return [...conversation, ...lines]
      .filter((c) => !since || c.created_at > since)
      .map(comment)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /** The comments on lines of code that belong to one review. */
  async reviewComments(repository: string, number: number, reviewId: number) {
    const list = await this.request<GithubComment[]>(
      repository,
      `/pulls/${number}/reviews/${reviewId}/comments?per_page=100`,
    );
    return list.map(comment);
  }
  async commentOnPullRequest(repository: string, number: number, body: string) {
    // Pull requests are issues for the comments API.
    await this.request(repository, `/issues/${number}/comments`, 'POST', { body });
  }
  async ensurePullRequest(repository: string, input: PullRequestInput): Promise<ChangeRequest> {
    const owner = repository.split('/')[0],
      lookup = `/pulls?state=all&head=${encodeURIComponent(`${owner}:${input.branch}`)}`;
    const existing = await this.request<GithubPR[]>(repository, lookup);
    if (existing.length) return map(existing[0]);
    try {
      return map(
        await this.request<GithubPR>(repository, '/pulls', 'POST', {
          head: input.branch,
          base: input.base,
          title: input.title,
          body: input.body,
          draft: true,
        }),
      );
    } catch (error) {
      // The POST may have succeeded before the response was lost.
      const found = await this.request<GithubPR[]>(repository, lookup);
      if (found.length) return map(found[0]);
      throw error;
    }
  }
}
interface GithubComment {
  id: number;
  body?: string;
  created_at: string;
  user?: { login?: string; type?: string };
  in_reply_to_id?: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
}
function comment(c: GithubComment): ReviewComment {
  return {
    id: String(c.id),
    author: c.user?.login ?? 'revisor',
    body: c.body ?? '',
    createdAt: c.created_at,
    path: c.path,
    line: c.line ?? c.original_line ?? undefined,
    bot: c.user?.type === 'Bot',
    reply: !!c.in_reply_to_id,
  };
}
function map(pr: GithubPR): ChangeRequest {
  return {
    id: String(pr.id),
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.state,
  };
}

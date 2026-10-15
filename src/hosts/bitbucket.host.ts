import { TaskError } from '../config';
import { ChangeRequest, CodeHost, PullRequestInput, ReviewComment } from './code-host';
interface BitbucketPR {
  id: number;
  title: string;
  state: string;
  links: { html: { href: string } };
}
interface BitbucketComment {
  id: number;
  created_on: string;
  deleted?: boolean;
  pending?: boolean;
  parent?: { id: number };
  /** Present once someone resolves the comment's thread. */
  resolution?: unknown;
  content?: { raw?: string };
  user?: { display_name?: string; nickname?: string; type?: string };
  inline?: { path?: string; from?: number | null; to?: number | null };
}
export interface BitbucketHostConfig {
  auth: 'access-token' | 'api-token';
  email?: string;
  token: string;
}
/** Bitbucket Cloud (bitbucket.org). Repository = "workspace/repo_slug". */
export class BitbucketHost implements CodeHost {
  constructor(
    readonly id: string,
    private readonly cfg: BitbucketHostConfig,
  ) {}
  cloneUrl(repository: string) {
    return `https://bitbucket.org/${repository}.git`;
  }
  gitAuthHeader() {
    // Static usernames documented by Atlassian for token-based git over HTTPS.
    const user = this.cfg.auth === 'api-token' ? 'x-bitbucket-api-token-auth' : 'x-token-auth';
    return `Authorization: Basic ${Buffer.from(`${user}:${this.cfg.token}`).toString('base64')}`;
  }
  private apiAuth() {
    return this.cfg.auth === 'api-token'
      ? `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.token}`).toString('base64')}`
      : `Bearer ${this.cfg.token}`;
  }
  async request<T>(repository: string, path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.bitbucket.org/2.0/repositories/${repository}${path}`, {
        method,
        headers: {
          Authorization: this.apiAuth(),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new TaskError('Bitbucket network request failed', true);
    }
    if (!response.ok)
      throw new TaskError(
        `Bitbucket ${method} ${path.split('?')[0]} returned ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  private async find(repository: string, branch: string) {
    // Any state: a merged or declined PR for this branch must not be recreated.
    const query = new URLSearchParams({ q: `source.branch.name="${branch}"` });
    for (const state of ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']) query.append('state', state);
    const page = await this.request<{ values?: BitbucketPR[] }>(
      repository,
      `/pullrequests?${query}`,
    );
    return page?.values?.[0];
  }
  async ensurePullRequest(repository: string, input: PullRequestInput): Promise<ChangeRequest> {
    const existing = await this.find(repository, input.branch);
    if (existing) return map(existing);
    try {
      return map(
        await this.request<BitbucketPR>(repository, '/pullrequests', 'POST', {
          title: input.title,
          description: input.body,
          source: { branch: { name: input.branch } },
          destination: { branch: { name: input.base } },
          draft: true,
          close_source_branch: false,
        }),
      );
    } catch (error) {
      // The POST may have succeeded before the response was lost.
      const found = await this.find(repository, input.branch);
      if (found) return map(found);
      throw error;
    }
  }
  async pullRequestComments(repository: string, number: number, since?: string) {
    const comments: ReviewComment[] = [];
    const prefix = `https://api.bitbucket.org/2.0/repositories/${repository}`;
    let path: string | undefined = `/pullrequests/${number}/comments?pagelen=100`;
    // Paginated; a bound keeps a pathological PR from looping forever.
    for (let page = 0; path && page < 20; page++) {
      const data: {
        values: BitbucketComment[];
        next?: string;
      } = await this.request(repository, path);
      for (const c of data.values ?? []) {
        // Pending comments are drafts the reviewer has not published yet.
        if (c.deleted || c.pending || c.resolution || (since && c.created_on <= since)) continue;
        comments.push({
          id: String(c.id),
          author: c.user?.display_name ?? c.user?.nickname ?? 'revisor',
          body: c.content?.raw ?? '',
          createdAt: c.created_on,
          path: c.inline?.path,
          line: c.inline?.to ?? c.inline?.from ?? undefined,
          bot: c.user?.type === 'app_user',
          reply: !!c.parent,
        });
      }
      path = data.next?.startsWith(prefix) ? data.next.slice(prefix.length) : undefined;
    }
    return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async branchDate(repository: string, branch: string) {
    try {
      const ref = await this.request<{ target?: { date?: string } }>(
        repository,
        `/refs/branches/${encodeURIComponent(branch)}`,
      );
      return ref?.target?.date;
    } catch (error) {
      if (error instanceof TaskError && error.message.endsWith(' returned 404')) return undefined;
      throw error;
    }
  }
  async commentOnPullRequest(repository: string, number: number, body: string) {
    await this.request(repository, `/pullrequests/${number}/comments`, 'POST', {
      content: { raw: body },
    });
  }
}
function map(pr: BitbucketPR): ChangeRequest {
  return {
    id: String(pr.id),
    number: pr.id,
    title: pr.title,
    url: pr.links.html.href,
    state: pr.state,
  };
}

import { TaskError } from '../config';
import { ChangeRequest, CodeHost, PullRequestInput, ReviewComment } from './code-host';
interface GitlabConfig {
  baseUrl: string;
  sshUrl: string;
  token: string;
}
interface GitlabMR {
  id: number;
  iid: number;
  title: string;
  state: string;
  web_url: string;
}
interface GitlabNote {
  id: number;
  body?: string;
  created_at: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  author?: { username?: string; name?: string; bot?: boolean };
  position?: {
    new_path?: string | null;
    new_line?: number | null;
    old_path?: string | null;
    old_line?: number | null;
  };
}
/**
 * Self-hosted GitLab (API v4). Clones go over ssh with the Coder workspace's own key; merge
 * requests, comments and branches go through the API with the company's token (metadata only).
 */
export class GitlabHost implements CodeHost {
  constructor(
    readonly id: string,
    private readonly cfg: GitlabConfig,
  ) {}
  cloneUrl(repository: string) {
    return `${this.cfg.sshUrl}/${repository}.git`;
  }
  /** Clones go over ssh with the workspace's key: no HTTP header. */
  gitAuthHeader() {
    return '';
  }
  private async call(path: string, method = 'GET', body?: unknown) {
    let response: Response;
    try {
      response = await fetch(`${this.cfg.baseUrl}/api/v4${path}`, {
        method,
        headers: {
          'PRIVATE-TOKEN': this.cfg.token,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new TaskError(`GitLab inacessível (${this.cfg.baseUrl}) — a VPN está ligada?`, true);
    }
    if (!response.ok)
      throw new TaskError(
        `GitLab ${method} ${path.split('?')[0]} returned ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    const text = await response.text();
    return { data: (text ? JSON.parse(text) : undefined) as unknown, headers: response.headers };
  }
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return (await this.call(path, method, body)).data as T;
  }
  private project(repository: string) {
    return `/projects/${encodeURIComponent(repository)}`;
  }
  private async find(repository: string, branch: string) {
    // Any state: a merged or closed MR for this branch must not be recreated.
    const query = new URLSearchParams({
      source_branch: branch,
      state: 'all',
      order_by: 'created_at',
      sort: 'desc',
    });
    const list = await this.request<GitlabMR[]>(
      `${this.project(repository)}/merge_requests?${query}`,
    );
    return list?.[0];
  }
  private async reviewerIds(usernames: string[]) {
    const ids: number[] = [];
    for (const username of usernames) {
      const users = await this.request<{ id: number }[]>(
        `/users?${new URLSearchParams({ username })}`,
      );
      if (!users?.length)
        throw new TaskError(`Revisor ${username} não encontrado no GitLab`, false);
      ids.push(users[0].id);
    }
    return ids;
  }
  async ensurePullRequest(repository: string, input: PullRequestInput): Promise<ChangeRequest> {
    const existing = await this.find(repository, input.branch);
    if (existing) return map(existing);
    const reviewer_ids = await this.reviewerIds(input.reviewers ?? []);
    try {
      return map(
        await this.request<GitlabMR>(`${this.project(repository)}/merge_requests`, 'POST', {
          source_branch: input.branch,
          target_branch: input.base,
          // GitLab treats the prefix as draft: it cannot be merged until someone removes it.
          title: input.draft ? `Draft: ${input.title}` : input.title,
          description: input.body,
          reviewer_ids,
          remove_source_branch: false,
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
    let page: string | null = '1';
    // Paginated; a bound keeps a pathological MR from looping forever.
    for (let n = 0; page && n < 20; n++) {
      const { data, headers } = await this.call(
        `${this.project(repository)}/merge_requests/${number}/discussions?per_page=100&page=${page}`,
      );
      for (const discussion of (data as { notes?: GitlabNote[] }[] | undefined) ?? []) {
        const notes = discussion.notes ?? [];
        // A resolved thread is settled, whatever was said in it.
        const resolvable = notes.filter((note) => note.resolvable);
        if (resolvable.length && resolvable.every((note) => note.resolved)) continue;
        notes.forEach((note, index) => {
          if (note.system || note.resolved || (since && note.created_at <= since)) return;
          const p = note.position;
          comments.push({
            id: String(note.id),
            author: note.author?.name ?? note.author?.username ?? 'revisor',
            authorId: note.author?.username,
            body: note.body ?? '',
            createdAt: note.created_at,
            path: p?.new_path ?? p?.old_path ?? undefined,
            line: p?.new_line ?? p?.old_line ?? undefined,
            bot: note.author?.bot === true,
            reply: index > 0,
          });
        });
      }
      page = headers.get('x-next-page') || null;
    }
    return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async branchDate(repository: string, branch: string) {
    try {
      const ref = await this.request<{ commit?: { committed_date?: string } }>(
        `${this.project(repository)}/repository/branches/${encodeURIComponent(branch)}`,
      );
      return ref?.commit?.committed_date;
    } catch (error) {
      if (error instanceof TaskError && error.message.endsWith(' returned 404')) return undefined;
      throw error;
    }
  }
  /** opened, merged, closed or locked. */
  async mergeRequestState(repository: string, number: number) {
    const mr = await this.request<{ state?: string }>(
      `${this.project(repository)}/merge_requests/${number}`,
    );
    return mr?.state ?? 'unknown';
  }
  async commentOnPullRequest(repository: string, number: number, body: string) {
    await this.request(`${this.project(repository)}/merge_requests/${number}/notes`, 'POST', {
      body,
    });
  }
}
function map(mr: GitlabMR): ChangeRequest {
  return {
    id: String(mr.id),
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    state: mr.state,
  };
}

import { TaskError } from '../../config';
import { JiraSource } from '../../tenants/tenants';
export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType?: string;
  size?: number;
  content: string;
}
export interface JiraIssueRef {
  id: string;
  key: string;
  fields?: { summary?: string; status?: { name?: string; statusCategory?: { key?: string } } };
}
export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    /** ADF document on Cloud (REST v3), wiki markup string on Data Center (REST v2). */
    description?: unknown;
    attachment?: JiraAttachment[];
    project?: { key: string };
    issuetype?: { subtask?: boolean; name?: string };
    /** In the order shown on the card (Jira rank). */
    subtasks?: JiraIssueRef[];
    /** The story of a sub-task. */
    parent?: { key: string; id?: string };
    status?: { name?: string; statusCategory?: { key?: string } };
  };
}
export interface JiraComment {
  id: string;
  created: string;
  author?: string;
  /** ADF on Cloud, plain/wiki text on Data Center. */
  body: unknown;
}
const FIELDS = 'summary,description,attachment,project,issuetype,subtasks,status,parent';
/** Jira REST client scoped to one configured source (one company, one base URL). */
export class JiraClient {
  constructor(
    private readonly source: JiraSource,
    private readonly http: typeof fetch = fetch,
  ) {}
  private get api() {
    return `${this.source.baseUrl}/rest/api/${this.source.deployment === 'cloud' ? 3 : 2}`;
  }
  private headers(): Record<string, string> {
    const auth =
      this.source.deployment === 'cloud'
        ? `Basic ${Buffer.from(`${this.source.email}:${this.source.token}`).toString('base64')}`
        : `Bearer ${this.source.token}`;
    return { Authorization: auth, Accept: 'application/json' };
  }
  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.http(url, {
        ...init,
        headers: {
          ...this.headers(),
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new TaskError(`Jira ${this.source.id} unreachable`, true);
    }
    if (!response.ok)
      throw new TaskError(
        `Jira ${init.method ?? 'GET'} ${new URL(url).pathname} returned ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  /** First page of the configured JQL: enough per poll, the rest comes on the next ones. */
  async search(max = 50, jql = this.source.jql): Promise<JiraIssue[]> {
    const query = new URLSearchParams({
      jql,
      fields: FIELDS,
      maxResults: String(max),
    });
    // Cloud replaced /search with /search/jql (token pagination); Data Center keeps /search.
    const path = this.source.deployment === 'cloud' ? 'search/jql' : 'search';
    const r = await this.request<{ issues?: JiraIssue[] }>(`${this.api}/${path}?${query}`);
    return r?.issues ?? [];
  }
  async issue(key: string): Promise<JiraIssue> {
    const query = new URLSearchParams({ fields: FIELDS });
    return this.request<JiraIssue>(`${this.api}/issue/${encodeURIComponent(key)}?${query}`);
  }
  /** Newest comments first (one page is plenty between two polls). */
  async comments(key: string, max = 50): Promise<JiraComment[]> {
    const query = new URLSearchParams({ orderBy: '-created', maxResults: String(max) });
    const r = await this.request<{
      comments?: {
        id: string;
        created: string;
        author?: { displayName?: string };
        body: unknown;
      }[];
    }>(`${this.api}/issue/${encodeURIComponent(key)}/comment?${query}`);
    return (r?.comments ?? []).map((c) => ({
      id: c.id,
      created: c.created,
      author: c.author?.displayName,
      body: c.body,
    }));
  }
  /** Downloads only from the configured Jira origin, so credentials never reach other hosts. */
  async download(attachment: JiraAttachment, maxBytes: number): Promise<Buffer> {
    const url = new URL(attachment.content);
    if (url.origin !== new URL(this.source.baseUrl).origin)
      throw new TaskError(`Attachment outside Jira origin refused: ${url.origin}`);
    if (attachment.size && attachment.size > maxBytes)
      throw new TaskError(`Attachment ${attachment.filename} above ${maxBytes} bytes`);
    let response: Response;
    try {
      // Cross-origin redirects (Cloud media service) drop the Authorization header by spec.
      response = await this.http(url, {
        headers: this.headers(),
        redirect: 'follow',
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw new TaskError(`Jira attachment ${attachment.filename} unreachable`, true);
    }
    if (!response.ok)
      throw new TaskError(
        `Jira attachment ${attachment.filename} returned ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxBytes)
      throw new TaskError(`Attachment ${attachment.filename} above ${maxBytes} bytes`);
    return body;
  }
  async comment(issueKey: string, text: string) {
    // Cloud v3 only accepts rich text (ADF); Data Center v2 takes a plain string.
    const body =
      this.source.deployment === 'cloud'
        ? {
            body: {
              type: 'doc',
              version: 1,
              content: text.split('\n\n').map((paragraph) => ({
                type: 'paragraph',
                content: [{ type: 'text', text: paragraph }],
              })),
            },
          }
        : { body: text };
    await this.request(`${this.api}/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  /** Moves the card by transition name or target status name. Returns false when unavailable. */
  async transition(issueKey: string, name: string): Promise<boolean> {
    const url = `${this.api}/issue/${encodeURIComponent(issueKey)}/transitions`;
    const { transitions = [] } = await this.request<{
      transitions?: { id: string; name: string; to?: { name?: string } }[];
    }>(url);
    // Workflows can hold near-duplicates ("Em andamento" and "EM ANDAMENTO"): an exact match
    // wins over a case-insensitive one.
    const wanted = name.toLowerCase();
    const match =
      transitions.find((t) => t.name === name || t.to?.name === name) ??
      transitions.find(
        (t) => t.name.toLowerCase() === wanted || t.to?.name?.toLowerCase() === wanted,
      );
    if (!match) return false;
    await this.request(url, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    return true;
  }
}

import { BusinessmapSource } from '../../tenants/tenants';
import { normalizeLabel } from './text';
export interface BmCard {
  card_id: number;
  board_id?: number;
  title?: string;
  description?: string | null;
  /** 1 backlog, 2 requested, 3 in progress, 4 done, 5 archive. */
  section?: number;
  column_id?: number;
  tag_ids?: number[];
  custom_fields?: { field_id: number; value?: unknown }[];
  linked_cards?: { card_id: number; link_type: string }[];
}
/** Sections from here on are closed (done, archive). */
const CLOSED = 4;
/** Businessmap API v2, read-only (GET only): the AI Dev Team never writes to the board. */
export class BusinessmapClient {
  constructor(
    private readonly source: BusinessmapSource,
    private readonly http: typeof fetch = fetch,
  ) {}
  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.source.baseUrl}/api/v2${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await this.http(url, {
      method: 'GET',
      headers: { apikey: this.source.token, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Businessmap GET ${path}: HTTP ${res.status}`);
    return ((await res.json()) as { data: T }).data;
  }
  /** Tag id → label, for the whole account. */
  async tags() {
    const list = await this.get<{ tag_id: number; label: string }[]>('/tags');
    return new Map((list ?? []).map((t) => [t.tag_id, t.label]));
  }
  private async list(filter: Record<string, string>) {
    const out: BmCard[] = [];
    for (let page = 1; ; page++) {
      const r = await this.get<{ pagination?: { all_pages?: number }; data: BmCard[] }>('/cards', {
        board_ids: String(this.source.boardId),
        per_page: '200',
        page: String(page),
        ...filter,
      });
      out.push(...(r?.data ?? []));
      if (page >= (r?.pagination?.all_pages ?? 1)) return out;
    }
  }
  /** Open cards in the trigger columns or with the trigger tag, each once. */
  async candidates() {
    const found: BmCard[] = [];
    const { columns, tag } = this.source.trigger;
    if (columns.length) found.push(...(await this.list({ column_ids: columns.join(',') })));
    if (tag) {
      const wanted = normalizeLabel(tag);
      const id = [...(await this.tags())].find(
        ([, label]) => normalizeLabel(label) === wanted,
      )?.[0];
      // A tag nobody created yet matches nothing.
      if (id !== undefined) found.push(...(await this.list({ tag_ids: String(id) })));
    }
    const seen = new Set<number>();
    return found.filter((c) => {
      if ((c.section ?? 0) >= CLOSED || seen.has(c.card_id)) return false;
      seen.add(c.card_id);
      return true;
    });
  }
  card(id: number) {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid card id ${id}`);
    return this.get<BmCard>(`/cards/${id}`);
  }
}

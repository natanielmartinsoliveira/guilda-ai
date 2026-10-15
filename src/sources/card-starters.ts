import { Injectable } from '@nestjs/common';
import { BusinessmapSource, JiraSource, Tenant, TenantSource } from '../tenants/tenants';
import { BusinessmapPoller } from './businessmap/businessmap.poller';
import { IngestResult, JiraPoller, SubtaskBases } from './jira/jira.poller';
/** How a source writes its card keys: Jira (PF-123) or a number (48816). */
export type KeyFormat = 'jira' | 'number';
/** A source type that can start a card the operator names by its key. */
export interface CardStarter {
  type: string;
  label: string;
  key: KeyFormat;
  example: string;
  start(tenant: Tenant, source: TenantSource, key: string, base?: string): Promise<IngestResult>;
  /** For sources with sub-tasks on their own: the branches one may start from. */
  bases?(tenant: Tenant, source: TenantSource, key: string): Promise<SubtaskBases>;
}
/** The key as the source writes it, or undefined when it cannot be one. */
export function normalizeCardKey(format: KeyFormat, raw: string): string | undefined {
  if (format === 'number') {
    const digits = raw.trim().replace(/^#/, '').replace(/\s+/g, '');
    return /^\d{1,12}$/.test(digits) ? digits : undefined;
  }
  // " pf 12 " and "pf - 12" become PF-12; a key without any separator is not guessed.
  const key = raw
    .trim()
    .toUpperCase()
    .replace(/\s*-\s*|\s+/g, '-');
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? key : undefined;
}
/** The card starters of each source type, and what each company's sources can do. */
@Injectable()
export class CardStarters {
  private readonly starters: Record<string, CardStarter>;
  constructor(jira: JiraPoller, businessmap: BusinessmapPoller) {
    this.starters = {
      jira: {
        type: 'jira',
        label: 'Jira',
        key: 'jira',
        example: 'PF-123',
        start: (tenant, source, key, base) => jira.startIn(tenant, source as JiraSource, key, base),
        bases: (tenant, source, key) => jira.basesIn(tenant, source as JiraSource, key),
      },
      businessmap: {
        type: 'businessmap',
        label: 'Businessmap',
        key: 'number',
        example: '48816',
        start: (tenant, source, key) =>
          businessmap.startById(tenant, source as BusinessmapSource, Number(key)),
      },
    };
  }
  for(source: Pick<TenantSource, 'type'>): CardStarter | undefined {
    return Object.hasOwn(this.starters, source.type) ? this.starters[source.type] : undefined;
  }
  /** The company's sources that start cards, as the front shows them. */
  list(tenant: Pick<Tenant, 'sources'>) {
    // Two sources of the same type (two Jira instances) are told apart by their id.
    const count = (type: string) => tenant.sources.filter((s) => s.type === type).length;
    return tenant.sources.flatMap((s) => {
      const starter = this.for(s);
      return starter
        ? [
            {
              id: s.id,
              type: s.type,
              label: count(s.type) > 1 ? `${starter.label} (${s.id})` : starter.label,
              key: starter.key,
              example: starter.example,
              bases: !!starter.bases,
            },
          ]
        : [];
    });
  }
}

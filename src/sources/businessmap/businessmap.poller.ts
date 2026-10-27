import { loadMethod } from '../../methods/method';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { config, log } from '../../config';
import { Issue, IssueMeta } from '../../database/entities';
import { latestTask, OrchestratorService } from '../../tasks/orchestrator.service';
import { BusinessmapSource, Tenant, tenants } from '../../tenants/tenants';
import type { IngestResult } from '../jira/jira.poller';
import { BmCard, BusinessmapClient } from './businessmap.client';
import { htmlToText, normalizeLabel, repositoryFromLink } from './text';
/**
 * Polls Businessmap boards, read-only: cards in the trigger columns or with the trigger tag
 * become tasks. Nothing is written back (no move, no comment): a card that cannot be taken yet
 * (no repository link, no route tag) is only logged and read again on the next poll.
 */
@Injectable()
export class BusinessmapPoller implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  /** Card + reason already logged, so a waiting card is not logged on every poll. */
  private readonly logged = new Set<string>();
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: DataSource,
    private readonly orchestrator: OrchestratorService,
  ) {}
  /** Overridable in tests. */
  protected client(source: BusinessmapSource) {
    return new BusinessmapClient(source);
  }
  onModuleInit() {
    if (!config().SOURCE_POLLING) return;
    for (const tenant of tenants())
      for (const source of tenant.sources)
        if (source.type === 'businessmap') {
          void this.poll(tenant, source);
          this.timers.push(
            setInterval(() => void this.poll(tenant, source), source.pollSeconds * 1000),
          );
        }
  }
  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }
  async poll(tenant: Tenant, source: BusinessmapSource) {
    // Session lock: with several API replicas only one polls a source at a time.
    const lock = this.db.createQueryRunner();
    await lock.connect();
    const key = `poll:${tenant.id}/${source.id}`;
    try {
      const [{ locked }] = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
        key,
      ]);
      if (!locked) return;
      try {
        const client = this.client(source);
        const { owners } = source.trigger;
        // Only the configured owners' cards (others in the same column belong to other people).
        const found = (await client.candidates()).filter(
          (c) => !owners.length || owners.includes(c.owner_user_id ?? -1),
        );
        if (!found.length) return;
        const tags = await client.tags();
        await this.exclusive(`${tenant.id}/${source.id}`, async () => {
          for (const ref of found)
            await this.ingest(tenant, source, client, ref, tags).catch((error: unknown) =>
              log('businessmap.ingest_failed', {
                tenant: tenant.id,
                source: source.id,
                card: ref.card_id,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
        });
      } finally {
        await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      }
    } catch (error) {
      log('businessmap.poll_failed', {
        tenant: tenant.id,
        source: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await lock.release();
    }
  }
  async ingest(
    tenant: Tenant,
    source: BusinessmapSource,
    client: BusinessmapClient,
    ref: BmCard,
    tags: Map<number, string>,
    /** The route the operator chose when starting the card by hand. */
    chosen?: string,
    /** The operator restarts a card whose last task published nothing (never a poll). */
    again = false,
  ): Promise<IngestResult> {
    const externalId = String(ref.card_id);
    // Cards stay in the trigger column after being taken: already accepted ones cost one lookup.
    const existing = await this.db
      .getRepository(Issue)
      .findOneBy({ tenantId: tenant.id, source: source.id, externalId });
    if (existing && !again) {
      const task = await latestTask(this.db.manager, existing.id);
      return { skipped: 'Esse card já tem tarefa', taskId: task?.id };
    }
    const card = await client.card(ref.card_id);
    const link = card.custom_fields?.find((f) => f.field_id === source.repositoryField)?.value;
    if (typeof link !== 'string' || !link.trim())
      return this.skip(
        tenant,
        source,
        externalId,
        'O card não tem o campo de repositório preenchido',
      );
    const project = tenant.projects.find((p) => {
      const host = tenant.hosts.find((h) => h.id === p.host);
      if (host?.type !== 'gitlab') return false;
      return repositoryFromLink(link, new URL(host.baseUrl).hostname) === p.repository;
    });
    if (!project)
      return this.skip(
        tenant,
        source,
        externalId,
        `Repositório do card não configurado em nenhum projeto: ${link.trim()}`,
      );
    let route: string | undefined;
    if (project.method) {
      const known = tenant.packDir
        ? Object.keys(loadMethod(tenant.packDir, project.method.name).routes)
        : [];
      const tagged = [
        ...new Set(
          (card.tag_ids ?? [])
            .map((id) => {
              const label = normalizeLabel(tags.get(id) ?? '');
              if (Object.hasOwn(source.routeTags, label)) return source.routeTags[label];
              // Without routeTags, a tag named as a route is that route.
              return !Object.keys(source.routeTags).length && known.includes(label)
                ? label
                : undefined;
            })
            .filter((r): r is string => !!r),
        ),
      ];
      const unknown = tagged.filter((r) => !known.includes(r));
      if (unknown.length)
        return this.skip(
          tenant,
          source,
          externalId,
          `Tag de rota sem rota no método ${project.method.name}: ${unknown.join(', ')}`,
        );
      // The operator's choice, when starting by hand, stands in for a missing tag (never against one).
      if (chosen && !known.includes(chosen))
        return this.skip(
          tenant,
          source,
          externalId,
          `Rota ${chosen} não existe no método ${project.method.name}`,
        );
      if (chosen && tagged.length && (tagged.length > 1 || tagged[0] !== chosen))
        return this.skip(
          tenant,
          source,
          externalId,
          `O card tem a tag de rota ${tagged.join(', ')}; a rota escolhida foi ${chosen}`,
        );
      // Without a route tag the card is taken anyway: the task asks the operator which route.
      const routes = chosen ? [chosen] : tagged;
      if (routes.length > 1)
        return this.skip(
          tenant,
          source,
          externalId,
          `Card com mais de uma rota (${routes.join(', ')}): escolha uma só`,
        );
      route = routes[0];
    }
    // Parent and related cards travel as context (their titles only).
    const linked: string[] = [];
    for (const l of card.linked_cards ?? []) {
      const other = await client.card(l.card_id).catch(() => undefined);
      if (other?.title)
        linked.push(
          `${l.link_type === 'parent' ? 'Card pai' : 'Card relacionado'}: ${other.title} (${l.card_id})`,
        );
    }
    const task = await this.orchestrator.accept(
      tenant.id,
      {
        source: source.id,
        externalId,
        key: externalId,
        title: (card.title || externalId).slice(0, 256),
        body: [htmlToText(card.description), linked.join('\n')].filter(Boolean).join('\n\n'),
        url: `${source.baseUrl}/ctrl_board/${source.boardId}/cards/${externalId}/details/`,
        project: project.id,
        ...(route ? { delivery: { route } } : {}),
      },
      { again },
    );
    log('businessmap.accepted', {
      tenant: tenant.id,
      source: source.id,
      card: externalId,
      taskId: task.id,
      route,
    });
    return { taskId: task.id };
  }
  /**
   * The operator picked this card (front): taken like a polled one, whatever its column, tags
   * or section — the repository and route rules still apply. Still read-only on the board.
   */
  async startById(
    tenant: Tenant,
    source: BusinessmapSource,
    id: number,
    route?: string,
    again = false,
  ): Promise<IngestResult> {
    const client = this.client(source);
    const card = await client.card(id);
    // Only cards of this source's board: another board's card belongs to another source.
    if (card.board_id !== undefined && card.board_id !== source.boardId)
      return { skipped: `O card ${id} não é do quadro desta origem (quadro ${source.boardId})` };
    const tags = await client.tags();
    return this.exclusive(`${tenant.id}/${source.id}`, () =>
      this.ingest(tenant, source, client, card, tags, route, again),
    );
  }
  private skip(tenant: Tenant, source: BusinessmapSource, card: string, reason: string) {
    const key = `${tenant.id}/${source.id}/${card}/${reason}`;
    if (!this.logged.has(key))
      log('businessmap.skipped', { tenant: tenant.id, source: source.id, card, reason });
    this.logged.add(key);
    return { skipped: reason };
  }
  /** One ingest pass per source at a time (two polls never start the same card twice). */
  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.running.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.running.set(key, next);
    try {
      return await next;
    } finally {
      if (this.running.get(key) === next) this.running.delete(key);
    }
  }
}

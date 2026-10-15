import { Injectable } from '@nestjs/common';
import { log, redact } from '../config';
import { JiraSource, Tenant } from '../tenants/tenants';
import { JiraClient } from './jira/jira.client';
/**
 * Events about one card. For sub-task deliveries, step events target the sub-task card and
 * delivery events (pr-opened, completed) the parent.
 */
export type SourceEvent =
  | { type: 'accepted'; taskId: string; steps?: string[]; stacked?: boolean }
  | { type: 'pr'; prUrl: string }
  | { type: 'pr-opened'; prUrl: string; remaining: number }
  | { type: 'step-started' }
  | { type: 'step-done'; prUrl: string; commit: string }
  | { type: 'completed'; prUrl: string }
  | { type: 'story-done'; branch: string }
  | { type: 'change-request'; revision: number }
  | { type: 'revised'; prUrl: string; commit: string }
  | { type: 'failed'; error: string };
/**
 * Tells the tracker what happened to its item (comment + card transition). Best effort:
 * a tracker outage must never fail or block the code task itself.
 */
@Injectable()
export class SourceReporter {
  /** Overridable in tests. */
  protected jira(source: JiraSource) {
    return new JiraClient(source);
  }
  async report(
    tenant: Tenant,
    item: { source: string; externalKey: string },
    event: SourceEvent,
  ): Promise<void> {
    const source = tenant.sources.find((s) => s.id === item.source);
    if (source?.type !== 'jira') return;
    const jira = this.jira(source);
    const steps: [string, () => Promise<unknown>][] = [];
    const comment = (text: string) => {
      if (source.comments) steps.push(['comment', () => jira.comment(item.externalKey, text)]);
    };
    const move = (name?: string) => {
      if (name)
        steps.push([
          `transition:${name}`,
          async () => {
            if (!(await jira.transition(item.externalKey, name)))
              log('source.transition_unavailable', {
                tenant: tenant.id,
                source: source.id,
                key: item.externalKey,
                transition: name,
              });
          },
        ]);
    };
    const short = (sha: string) => sha.slice(0, 7);
    switch (event.type) {
      case 'accepted':
        move(source.transitions.start);
        comment(
          event.stacked && event.steps?.length
            ? `AI Dev Team assumiu esta história (task ${event.taskId}): uma branch e um PR por sub-tarefa, cada uma a partir da anterior, nesta ordem: ${event.steps.join(' → ')}.`
            : event.steps?.length
              ? `AI Dev Team assumiu esta tarefa (task ${event.taskId}): um PR com um commit por sub-tarefa, nesta ordem: ${event.steps.join(' → ')}.`
              : `AI Dev Team assumiu esta tarefa (task ${event.taskId}). O PR será linkado aqui.`,
        );
        break;
      case 'pr':
        comment(`AI Dev Team abriu um draft PR para revisão: ${event.prUrl}`);
        move(source.transitions.review);
        break;
      case 'pr-opened':
        comment(
          `AI Dev Team abriu o draft PR ${event.prUrl}; faltam ${event.remaining} sub-tarefa(s), que entram como novos commits.`,
        );
        break;
      case 'step-started':
        move(source.transitions.start);
        break;
      case 'step-done':
        comment(
          `AI Dev Team implementou esta sub-tarefa no commit ${short(event.commit)}: ${event.prUrl}`,
        );
        move(source.transitions.review);
        break;
      case 'completed':
        comment(
          `AI Dev Team concluiu todas as sub-tarefas. PR pronto para revisão: ${event.prUrl}`,
        );
        move(source.transitions.review);
        break;
      case 'story-done':
        comment(
          `AI Dev Team concluiu todas as sub-tarefas; cada uma tem seu PR para a branch ${event.branch}. O PR da história para o branch principal é aberto manualmente.`,
        );
        move(source.transitions.review);
        break;
      case 'change-request':
        move(source.transitions.start);
        comment(
          `AI Dev Team está aplicando os comentários de revisão (revisão #${event.revision}).`,
        );
        break;
      case 'revised':
        comment(
          `AI Dev Team aplicou os ajustes no commit ${short(event.commit)}. PR: ${event.prUrl}`,
        );
        move(source.transitions.review);
        break;
      case 'failed':
        comment(`AI Dev Team não concluiu esta tarefa: ${redact(event.error).slice(0, 1500)}`);
        break;
    }
    for (const [step, run] of steps)
      try {
        await run();
      } catch (error) {
        log('source.report_failed', {
          tenant: tenant.id,
          source: source.id,
          key: item.externalKey,
          step,
          error: error instanceof Error ? error.message : String(error),
        });
      }
  }
}

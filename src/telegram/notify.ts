import { EntityManager } from 'typeorm';
import { config } from '../config';
import { Notification } from '../database/entities';
import { telegramEnabled } from './enabled';
import { rehearsalMessage } from './messages';
/** Queues the operator's warning about a new decision, in the caller's transaction. */
export async function notifyDecision(em: EntityManager, decisionId: string) {
  if (!telegramEnabled()) return;
  await em.save(Notification, { kind: 'decision', decisionId, status: 'pending' });
}
/** Queues "PR opened"; off with TELEGRAM_NOTIFY_PR=false. */
export async function notifyPr(
  em: EntityManager,
  payload: { tenantId: string; taskId: string; card: string; title: string; prUrl: string },
) {
  if (!telegramEnabled() || !config().TELEGRAM_NOTIFY_PR) return;
  await em.save(Notification, { kind: 'pr', payload, status: 'pending' });
}
/** Queues "rehearsal finished" as plain text (nothing was published), in the caller's transaction. */
export async function notifyRehearsal(
  em: EntityManager,
  input: Parameters<typeof rehearsalMessage>[0],
) {
  if (!telegramEnabled()) return;
  await em.save(Notification, {
    kind: 'text',
    payload: { text: rehearsalMessage(input) },
    status: 'pending',
  });
}

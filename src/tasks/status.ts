import { Status } from '../database/entities';
export function assertTransition(from: Status, to: Status) {
  const allowed: Record<Status, Status[]> = {
    PENDING: ['RUNNING', 'CANCELLED'],
    // WAITING: the AI asked the operator instead of guessing.
    RUNNING: ['PENDING', 'WAITING', 'SUCCESS', 'FAILED', 'CANCELLED'],
    WAITING: ['PENDING', 'CANCELLED'],
    SUCCESS: [],
    // Operator retry / decision puts a finished job back in the queue or closes it.
    FAILED: ['PENDING', 'CANCELLED'],
    CANCELLED: ['PENDING'],
  };
  if (!allowed[from].includes(to)) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}

import { NGROK_SKIP } from './sse';
import type {
  DecisionAnswer,
  DecisionView,
  StartResult,
  SubtaskBases,
  TaskView,
  Tenant,
} from './types';
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
let unauthorized: () => void = () => undefined;
/** Called when a /api request comes back 401 (session gone): the app shows the login again. */
export function setUnauthorizedHandler(handler: () => void) {
  unauthorized = handler;
}
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = typeof init.body === 'string';
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...NGROK_SKIP,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await response.text();
  const data = text ? parse(text) : undefined;
  if (!response.ok) {
    if (response.status === 401 && path.startsWith('/api/')) unauthorized();
    const raw = (data as { message?: unknown } | undefined)?.message;
    const message = Array.isArray(raw)
      ? raw.join('; ')
      : raw
        ? String(raw)
        : `Erro ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return data as T;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const tenantPath = (tenant: string) => `/api/tenants/${encodeURIComponent(tenant)}`;
export const api = {
  me: () => call<{ authenticated: boolean; language?: string }>('/web-api/me'),
  login: (password: string) => call<{ loginId: string }>('/web-api/login', post({ password })),
  verify: (loginId: string, code: string) =>
    call<{ ok: true }>('/web-api/verify', post({ loginId, code })),
  logout: () => call<{ ok: true }>('/web-api/logout', post({})),
  tenants: () => call<Tenant[]>('/api/tenants'),
  tasks: (tenant: string) => call<TaskView[]>(`${tenantPath(tenant)}/tasks?limit=50`),
  task: (tenant: string, id: string) =>
    call<TaskView>(`${tenantPath(tenant)}/tasks/${encodeURIComponent(id)}`),
  decisions: (tenant: string) => call<DecisionView[]>(`${tenantPath(tenant)}/decisions`),
  answer: (tenant: string, id: string, body: DecisionAnswer) =>
    call<DecisionView>(
      `${tenantPath(tenant)}/decisions/${encodeURIComponent(id)}/answer`,
      post(body),
    ),
  createTask: (tenant: string, form: FormData) =>
    call<{ taskId: string; key: string }>(`${tenantPath(tenant)}/tasks`, {
      method: 'POST',
      body: form,
    }),
  startCard: (tenant: string, source: string, key: string, base?: string, route?: string) =>
    call<StartResult>(
      `${tenantPath(tenant)}/sources/${encodeURIComponent(source)}/start`,
      post({ key, ...(base ? { base } : {}), ...(route ? { route } : {}) }),
    ),
  cardBases: (tenant: string, source: string, key: string) =>
    call<SubtaskBases>(
      `${tenantPath(tenant)}/sources/${encodeURIComponent(source)}/cards/${encodeURIComponent(key)}/bases`,
    ),
  fromJira: (tenant: string, key: string, base?: string) =>
    call<StartResult>(
      `${tenantPath(tenant)}/tasks/from-jira`,
      post(base ? { key, base } : { key }),
    ),
  jiraBases: (tenant: string, key: string) =>
    call<SubtaskBases>(`${tenantPath(tenant)}/jira/${encodeURIComponent(key)}/bases`),
  /** A print or the trace of the task's test evidence (sent with the session, like any call). */
  evidenceFile: async (tenant: string, id: string, file: string) => {
    const response = await fetch(
      `${tenantPath(tenant)}/tasks/${encodeURIComponent(id)}/evidence/${encodeURIComponent(file)}`,
      { credentials: 'same-origin', headers: { ...NGROK_SKIP } },
    );
    if (!response.ok) throw new ApiError(response.status, `Erro ${response.status}`);
    return response.blob();
  },
  discard: (tenant: string, id: string) =>
    call<{ discarded: boolean }>(
      `${tenantPath(tenant)}/tasks/${encodeURIComponent(id)}/discard`,
      post({}),
    ),
  revise: (tenant: string, id: string, form: FormData) =>
    call<{ revisionId: string; number: number }>(
      `${tenantPath(tenant)}/tasks/${encodeURIComponent(id)}/revisions`,
      { method: 'POST', body: form },
    ),
};

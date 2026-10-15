import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, ApiError, setUnauthorizedHandler } from './api';
function reply(status: number, body?: unknown) {
  return vi.fn(
    async () => new Response(body === undefined ? '' : JSON.stringify(body), { status }),
  );
}
afterEach(() => vi.unstubAllGlobals());
describe('api', () => {
  test('sends JSON actions to relative paths with the session cookie', async () => {
    const fetch = reply(200, { loginId: 'abc' });
    vi.stubGlobal('fetch', fetch);
    expect(await api.login('senha')).toEqual({ loginId: 'abc' });
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/web-api/login');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ password: 'senha' });
  });
  test('every call asks past the ngrok free-tier warning page', async () => {
    const fetch = reply(200, []);
    vi.stubGlobal('fetch', fetch);
    await api.tenants();
    await api.createTask('acme', new FormData());
    for (const call of fetch.mock.calls as unknown as [string, RequestInit][])
      expect(new Headers(call[1].headers).get('ngrok-skip-browser-warning')).toBe('1');
  });
  test('files go as multipart: no JSON content type', async () => {
    const fetch = reply(202, { taskId: 't1', key: 'T-1' });
    vi.stubGlobal('fetch', fetch);
    const form = new FormData();
    form.append('title', 'x');
    await api.createTask('acme', form);
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/tenants/acme/tasks');
    expect(init.body).toBe(form);
    expect(new Headers(init.headers).get('content-type')).toBeNull();
  });
  test('errors carry the status and the server message', async () => {
    vi.stubGlobal('fetch', reply(409, { statusCode: 409, message: 'Já respondida' }));
    const error = await api.answer('acme', 'd1', { action: 'retry' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: 'Já respondida' });
  });
  test('a 401 on /api calls the unauthorized handler; a wrong password does not', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal('fetch', reply(401, { message: 'Unauthorized' }));
    await expect(api.tenants()).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(api.login('errada')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  test('tenant ids are encoded in paths', async () => {
    const fetch = reply(200, []);
    vi.stubGlobal('fetch', fetch);
    await api.tasks('a b');
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      '/api/tenants/a%20b/tasks?limit=50',
    );
  });
});

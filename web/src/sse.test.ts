import { describe, expect, test, vi } from 'vitest';
import { fetchSource } from './sse';
/** A streamed response whose body arrives in the given chunks. */
function streamed(chunks: string[], type = 'text/event-stream; charset=utf-8', status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': type } });
}
const settle = () => new Promise((done) => setTimeout(done, 20));
describe('fetchSource', () => {
  test('asks past the ngrok warning, opens, and delivers change events split across chunks', async () => {
    const fetch = vi.fn(async () =>
      streamed([
        ': ping\n\n',
        'event: change\ndata: {"id":',
        '"t1"}\n\nevent: change\ndata: {"id":"t2"}\n\n',
      ]),
    );
    const source = fetchSource('/api/events', fetch);
    const opened = vi.fn();
    const got: string[] = [];
    source.onopen = opened;
    source.addEventListener('change', (event) => got.push(event.data));
    await settle();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/events');
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('ngrok-skip-browser-warning')).toBe('1');
    expect(opened).toHaveBeenCalledTimes(1);
    expect(got).toEqual(['{"id":"t1"}', '{"id":"t2"}']);
  });
  test('the ngrok warning page (200, not an event stream) is an error, not an open stream', async () => {
    const source = fetchSource('/api/events', async () =>
      streamed(['You are about to visit ... ERR_NGROK_6024'], 'text/plain'),
    );
    const opened = vi.fn();
    const failed = vi.fn();
    source.onopen = opened;
    source.onerror = failed;
    await settle();
    expect(opened).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
  });
  test('a 401 or a stream that ends is an error; closing it is not', async () => {
    const unauthorized = fetchSource('/api/events', async () => streamed([], 'text/plain', 401));
    const failed = vi.fn();
    unauthorized.onerror = failed;
    const ended = fetchSource('/api/events', async () => streamed(['event: change\ndata: {}\n\n']));
    const endedFailed = vi.fn();
    ended.onerror = endedFailed;
    await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(endedFailed).toHaveBeenCalledTimes(1);
    const hanging = fetchSource(
      '/api/events',
      (_url, init) =>
        new Promise((_done, fail) =>
          init?.signal?.addEventListener('abort', () =>
            fail(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );
    const closedFailed = vi.fn();
    hanging.onerror = closedFailed;
    hanging.close();
    await settle();
    expect(closedFailed).not.toHaveBeenCalled();
  });
});

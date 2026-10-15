import type { SourceLike } from './LiveProvider';
/** Header that makes ngrok's free tier answer the app instead of its "you are about to visit" page. */
export const NGROK_SKIP = { 'ngrok-skip-browser-warning': '1' };
/**
 * Server-sent events read through fetch instead of EventSource: EventSource cannot send
 * headers, so behind the ngrok free tier it got the warning page and never opened. Anything that
 * is not an event stream, a closed stream or a network error is reported through onerror (the
 * provider reconnects); close() is silent.
 */
export function fetchSource(url: string, fetchImpl: typeof fetch = fetch): SourceLike {
  const controller = new AbortController();
  const listeners: ((event: { data: string }) => void)[] = [];
  const source: SourceLike = {
    onerror: null,
    onopen: null,
    addEventListener: (_type, listener) => void listeners.push(listener),
    close: () => controller.abort(),
  };
  const dispatch = (block: string) => {
    let name = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (name === 'change' && data.length)
      for (const listener of listeners) listener({ data: data.join('\n') });
  };
  void (async () => {
    try {
      const response = await fetchImpl(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/event-stream', ...NGROK_SKIP },
        signal: controller.signal,
      });
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.includes('text/event-stream')
      )
        throw new Error(`Not an event stream (${response.status})`);
      source.onopen?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
          dispatch(buffer.slice(0, end));
          buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
        }
      }
      throw new Error('Event stream closed');
    } catch {
      if (!controller.signal.aborted) source.onerror?.();
    }
  })();
  return source;
}

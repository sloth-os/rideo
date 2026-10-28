import { describe, expect, it, vi } from 'vitest';
import { cappedRanges, limitedFetch, RANGE_CAP_BYTES } from '../src/engine/media-fetch';

/** Media reads that leave room on the connection (docs/design/engine-performance.md#media-requests). */

/** A server whose answers stream until the test ends them. */
function fakeServer() {
  const open: { url: string; push: (s: string) => void; end: () => void; fail: () => void }[] = [];
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('refused')) throw new TypeError('fetch failed');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    open.push({
      url,
      push: (s) => controller.enqueue(new TextEncoder().encode(s)),
      end: () => controller.close(),
      fail: () => controller.error(new Error('reset')),
    });
    init?.signal?.addEventListener('abort', () =>
      controller.error(new DOMException('aborted', 'AbortError')),
    );
    return new Response(body, { status: 206, headers: { 'content-range': 'bytes 0-9/10' } });
  });
  return { base: base as unknown as typeof fetch, open, calls: base };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('limited media fetch', () => {
  it('runs at most its limit at once and hands a slot on when a body ends, fails, is cancelled or aborted', async () => {
    const server = fakeServer();
    const get = limitedFetch(2, server.base);
    const a = get('/a');
    const b = get('/b');
    const c = get('/c');
    const controller = new AbortController();
    const d = get('/d', { signal: controller.signal });
    const e = get('/e');
    await tick();
    expect(server.open.map((o) => o.url)).toEqual(['/a', '/b']);
    // a's body read to its end
    const ra = await a;
    expect(ra.status).toBe(206);
    expect(ra.headers.get('content-range')).toBe('bytes 0-9/10');
    server.open[0]!.push('0123456789');
    server.open[0]!.end();
    expect(await ra.text()).toBe('0123456789');
    await tick();
    expect(server.open.map((o) => o.url)).toEqual(['/a', '/b', '/c']);
    // b's body cancelled by its reader
    await (await b).body!.cancel();
    await tick();
    expect(server.open.map((o) => o.url)).toEqual(['/a', '/b', '/c', '/d']);
    // d aborted by its caller (mediabunny's way to stop an open-ended range)
    await d;
    controller.abort();
    await tick();
    expect(server.open.map((o) => o.url)).toEqual(['/a', '/b', '/c', '/d', '/e']);
    // c's connection reset mid-body
    const rc = await c;
    server.open[2]!.fail();
    await expect(rc.text()).rejects.toThrow('reset');
    await e;
    const f = get('/f');
    await tick();
    expect(server.open.at(-1)!.url).toBe('/f');
    await f;
  });

  it('drops a waiting request that is aborted, and frees the slot of one that fails', async () => {
    const server = fakeServer();
    const get = limitedFetch(1, server.base);
    await expect(get('/refused')).rejects.toThrow('fetch failed');
    const first = get('/first');
    const controller = new AbortController();
    const waiting = get('/waiting', { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await first;
    expect(server.open.map((o) => o.url)).toEqual(['/first']);
  });
});

describe('bounded media ranges (docs/design/engine-performance.md#media-requests)', () => {
  it('closes an open-ended range at 4 MiB and leaves every other request as it is', async () => {
    const seen: (string | null)[] = [];
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('range'));
      return new Response('x', { status: 206 });
    });
    const get = cappedRanges(base as unknown as typeof fetch);
    await get('/media/a.mp4', { headers: { Range: 'bytes=1000-' } });
    await get('/media/a.mp4', { headers: { Range: 'bytes=0-99' } });
    await get('/media/a.mp4');
    expect(seen).toEqual([`bytes=1000-${1000 + RANGE_CAP_BYTES - 1}`, 'bytes=0-99', null]);
    expect(RANGE_CAP_BYTES).toBe(4 * 1024 * 1024);
    // The signal goes with it
    const ctrl = new AbortController();
    await get('/media/a.mp4', { headers: { Range: 'bytes=5-' }, signal: ctrl.signal });
    expect(base.mock.calls.at(-1)![1]!.signal).toBe(ctrl.signal);
  });
});

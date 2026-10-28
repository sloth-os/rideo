/**
 * Media reads that leave room on the tab's connection (docs/design/engine-performance.md#media-requests): a fetch
 * that runs at most `limit` requests at once. A request holds its slot until its body ends, fails or is cancelled
 * (mediabunny aborts an open-ended range once it has read what it needs), or until it is aborted.
 */
export function limitedFetch(
  limit: number,
  base: typeof fetch = (input, init) => fetch(input, init),
): typeof fetch {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = (signal?: AbortSignal | null) =>
    new Promise<void>((resolve, reject) => {
      const aborted = () => signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
      if (signal?.aborted) return reject(aborted());
      if (active < limit) {
        active++;
        return resolve();
      }
      const go = () => {
        signal?.removeEventListener('abort', onAbort);
        active++;
        resolve();
      };
      const onAbort = () => {
        const i = waiting.indexOf(go);
        if (i >= 0) waiting.splice(i, 1);
        reject(aborted());
      };
      waiting.push(go);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  const limited = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    await acquire(signal);
    let held = true;
    const done = () => {
      if (!held) return;
      held = false;
      release();
    };
    let res: Response;
    try {
      res = await base(input, init);
    } catch (err) {
      done();
      throw err;
    }
    if (!res.body) {
      done();
      return res;
    }
    signal?.addEventListener('abort', done, { once: true });
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done: end, value } = await reader.read();
          if (end) {
            done();
            controller.close();
          } else controller.enqueue(value);
        } catch (err) {
          done();
          controller.error(err);
        }
      },
      cancel(reason) {
        done();
        return reader.cancel(reason);
      },
    });
    const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    // What a reader may look at besides the body (mediabunny: a redirect, a same-origin answer)
    for (const key of ['url', 'redirected', 'type'] as const)
      Object.defineProperty(out, key, { value: res[key], configurable: true });
    return out;
  };
  return limited as typeof fetch;
}

/** The longest range a media read asks for (docs/design/engine-performance.md#media-requests). */
export const RANGE_CAP_BYTES = 4 * 1024 * 1024;

/**
 * A fetch that closes an open-ended range (`bytes=N-`) at `cap` bytes, so the server and the storage behind it send
 * no more than a read needs; mediabunny asks again from where an answer stopped.
 */
export function cappedRanges(
  base: typeof fetch = (input, init) => fetch(input, init),
  cap = RANGE_CAP_BYTES,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const open = /^bytes=(\d+)-$/.exec(headers.get('range') ?? '');
    if (!open) return base(input, init);
    const start = Number(open[1]);
    headers.set('range', `bytes=${start}-${start + cap - 1}`);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}

// Five in all: on HTTP/1.1 (six connections a host) one stays free for the API, heartbeats and an export's inputs

/** Timeline lanes (waveforms, filmstrips): two media requests at a time for the whole tab. */
export const laneFetch = limitedFetch(2, cappedRanges());

/** The preview and the animatic: three media requests at a time for the whole tab. */
export const previewFetch = limitedFetch(3, cappedRanges());

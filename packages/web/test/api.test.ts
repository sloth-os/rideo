import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, drain } from '../src/lib/api';
import { flushTelemetry, recordTiming, resetTelemetry } from '../src/lib/telemetry';
import { transfers } from '../src/workspace';

/**
 * Every answer of the API is read to its end, an empty `204` too (docs/architecture.md#layers): Chromium reports a
 * fetch whose body is never read as cancelled (`net::ERR_ABORTED`), and cancelling the body does the same.
 */

/** An answer whose (empty) body tells whether it was read to its end, cancelled, or left alone. */
function answer(status: number) {
  const seen = { read: false, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.read = true;
        controller.close();
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    // nothing pulled until someone reads
    { highWaterMark: 0 },
  );
  // a Response may not carry a body with a status such as 204; the status is the one the server sent
  const res = new Response(body, { status: 200 });
  Object.defineProperty(res, 'status', { value: status });
  Object.defineProperty(res, 'ok', { value: status >= 200 && status < 300 });
  return { res, seen };
}

function serve(...answers: Response[]) {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => answers.shift() ?? new Response(null, { status: 500 }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetTelemetry();
});

describe('empty answers read to their end (docs/architecture.md#layers)', () => {
  it('reads a stored desk state’s 204 (none stored) to its end before taking it for none', async () => {
    const { res, seen } = answer(204);
    const fetch = serve(res);
    await expect(api.deskState('prj_0000000000000001', 'clp_0000000000000001')).resolves.toBeNull();
    expect(fetch.mock.calls[0]?.[0]).toMatch(
      /\/projects\/prj_0000000000000001\/clips\/clp_0000000000000001\/desk-state$/,
    );
    expect(seen).toEqual({ read: true, cancelled: false });
  });

  it('reads the 204 of a DELETE (Start over, a deleted character) to its end', async () => {
    const cleared = answer(204);
    const deleted = answer(204);
    const fetch = serve(cleared.res, deleted.res);
    await expect(api.clearDeskState('prj_0000000000000001', 'clp_0000000000000001')).resolves.toBeUndefined();
    await expect(api.deleteCharacter('prj_0000000000000001', 'chr_1')).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['DELETE', 'DELETE']);
    expect(cleared.seen).toEqual({ read: true, cancelled: false });
    expect(deleted.seen).toEqual({ read: true, cancelled: false });
  });

  it('takes a 204 whose empty body fails to arrive for the answer it is', async () => {
    const broken = () => {
      const res = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError('network error'));
          },
        }),
        { status: 200 },
      );
      Object.defineProperty(res, 'status', { value: 204 });
      return res;
    };
    serve(broken(), broken());
    await expect(api.deskState('prj_0000000000000001', 'clp_0000000000000001')).resolves.toBeNull();
    await expect(api.clearDeskState('prj_0000000000000001', 'clp_0000000000000001')).resolves.toBeUndefined();
    // an answer read already is left as it is
    const read = answer(204);
    await read.res.arrayBuffer();
    await expect(drain(read.res)).resolves.toBeUndefined();
  });

  it('reads the 204 of a telemetry batch to its end', async () => {
    recordTiming('project_load', 1.5);
    const { res, seen } = answer(204);
    const fetch = serve(res);
    await flushTelemetry();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ read: true, cancelled: false });
  });

  it('reads the 204 of a transfer the server reads to its end, and its refusal too', async () => {
    const taken = answer(204);
    const refused = answer(404);
    const fetch = serve(taken.res, refused.res);
    const meta = { size: 3, start: 0, end: 2 };
    await expect(transfers.putTransfer('st_1', new Blob(['abc']), meta)).resolves.toBeUndefined();
    await expect(transfers.putTransfer('st_2', new Blob(['abc']), meta)).rejects.toThrow(
      'the server did not take the file (404)',
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toMatch(/\/workspace\/transfers\/st_1$/);
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({ 'x-rideo-size': '3', 'x-rideo-range': '0-2' });
    expect(taken.seen).toEqual({ read: true, cancelled: false });
    expect(refused.seen).toEqual({ read: true, cancelled: false });
  });
});

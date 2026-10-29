import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, UPLOAD_SLICE_BYTES } from '../src/lib/api';

/** Rendered outputs leave the tab as bytes in slices (docs/design/editor.md#memory). */
afterEach(() => vi.unstubAllGlobals());

describe('staging an editor output', () => {
  it('sends bytes in slices with their offset and the total, and a Blob whole', async () => {
    const calls: { url: string; size: number; type: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body as Uint8Array | Blob;
        calls.push({
          url,
          size: body instanceof Blob ? body.size : body.byteLength,
          type: new Headers(init.headers).get('content-type'),
        });
        return new Response(JSON.stringify({ name: 'part-0001.mp4', size: 0, complete: true }));
      }),
    );
    const total = 2 * UPLOAD_SLICE_BYTES + 1000;
    await api.editorUpload('job_0000000000aaaaaa', 's1', 'part-0001.mp4', new Uint8Array(total));
    expect(calls.map((c) => [new URL(c.url, 'http://x').searchParams.get('offset'), c.size])).toEqual([
      ['0', UPLOAD_SLICE_BYTES],
      [String(UPLOAD_SLICE_BYTES), UPLOAD_SLICE_BYTES],
      [String(2 * UPLOAD_SLICE_BYTES), 1000],
    ]);
    for (const c of calls) {
      expect(new URL(c.url, 'http://x').searchParams.get('total')).toBe(String(total));
      expect(c.type).toBe('application/octet-stream');
    }
    // an empty output is one slice; a Blob goes whole, without an offset
    calls.length = 0;
    await api.editorUpload('job_0000000000aaaaaa', 's1', 'empty.flac', new Uint8Array(0));
    await api.editorUpload('job_0000000000aaaaaa', 's1', 'poster.jpg', new Blob(['jpeg']));
    expect(calls.map((c) => new URL(c.url, 'http://x').searchParams.get('offset'))).toEqual(['0', null]);
  });
});

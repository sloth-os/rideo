import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaStore } from '../../src/media/store';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** A file host answering each request with the next behaviour: drop the connection, a status, or the file. */
async function host(script: ('drop' | number | 'file')[]) {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const step = script[Math.min(seen.length, script.length - 1)]!;
    seen.push(req.url ?? '');
    if (step === 'drop') return req.socket.destroy();
    if (step === 'file') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end('mp4-bytes');
    }
    res.writeHead(step);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/out.mp4`, seen };
}

async function store() {
  const dataDir = await mkdtemp(join(tmpdir(), 'rideo-media-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    media: new MediaStore({
      storage: new MemoryBackend(),
      layout: new Layout('/rideo'),
      ff: {} as never,
      dataDir,
      maxCacheBytes: 1e9,
      downloadRetryMs: 5,
    }),
  };
}

describe('gateway output downloads (docs/design/ai-gateway.md#sdk-usage)', () => {
  it('downloads again after a dropped connection or a 5xx from the file host', async () => {
    const { media, dataDir } = await store();
    const flaky = await host(['drop', 503, 'file']);
    const out = join(dataDir, 'take.mp4');
    expect(await media.downloadTo(flaky.url, out)).toEqual({ mime: 'video/mp4', size: 9 });
    expect((await readFile(out)).toString()).toBe('mp4-bytes');
    expect(flaky.seen).toHaveLength(3);
  });

  it('fails as a retryable gateway error after its tries, and at once on a 404', async () => {
    const { media, dataDir } = await store();
    const down = await host([503]);
    await expect(media.downloadTo(down.url, join(dataDir, 'a.mp4'))).rejects.toMatchObject({
      code: 'gateway_error',
      retryable: true,
    });
    expect(down.seen).toHaveLength(3);
    const gone = await host([404]);
    await expect(media.downloadTo(gone.url, join(dataDir, 'b.mp4'))).rejects.toMatchObject({
      code: 'gateway_error',
      retryable: false,
    });
    expect(gone.seen).toHaveLength(1);
    const dropped = await host(['drop']);
    await expect(media.downloadTo(dropped.url, join(dataDir, 'c.mp4'))).rejects.toMatchObject({
      code: 'gateway_error',
      retryable: true,
      message: expect.stringContaining('download failed for'),
    });
    expect(dropped.seen).toHaveLength(3);
  });
});

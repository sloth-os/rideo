import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { buildServer, type RideoServer } from '../../src/http/app';

/**
 * The line a studio logs once it serves (docs/design/observability.md#logs): the address to open in a browser, which
 * the studio's links, cookie and desk rule are made for, apart from the address it listens on.
 */
let server: RideoServer | undefined;
let dataDir: string | undefined;
afterAll(async () => {
  await server?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('the ready log', () => {
  it('names the public address as url and the address it listens on as listen', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rideo-ready-'));
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(JSON.parse(line));
        done();
      },
    });
    const config = loadConfig({
      RIDEO_PORT: '0',
      RIDEO_HOST: '127.0.0.1',
      RIDEO_DATA_DIR: dataDir,
      RIDEO_STORAGE: 'embedded',
      RIDEO_PUBLIC_URL: 'https://studio.example.com/rideo',
      NODE_ENV: 'test',
      RIDEO_WATERMARK_KEY: 'integration-test-key',
      RIDEO_WEBDAV_SYNC_INTERVAL_SEC: '0',
      RIDEO_WEB_DIST: join(dataDir, 'no-web'),
    });
    server = await buildServer(config, { logger: { level: 'info', stream } });
    const listen = await server.start();

    expect(listen).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const ready = lines.filter((line) => line.msg === 'Rideo is ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      url: 'https://studio.example.com/rideo',
      listen,
      basePath: '/rideo',
      storage: 'embedded',
      gateway: 'not configured',
    });
  });
});

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from '../helpers/stack';

/** Cross-origin isolation of the studio (docs/design/engine-performance.md): threads for ffmpeg.wasm. */
let web: string;
let isolated: Stack;
let plain: Stack;
beforeAll(async () => {
  web = await mkdtemp(join(tmpdir(), 'rideo-web-'));
  await mkdir(join(web, 'assets'));
  await writeFile(join(web, 'index.html'), '<!doctype html><title>Rideo</title>');
  await writeFile(join(web, 'assets', 'app-abc123.js'), 'export {};');
  [isolated, plain] = await Promise.all([
    startStack({ env: { RIDEO_WEB_DIST: web } }),
    startStack({ env: { RIDEO_WEB_DIST: web, RIDEO_CROSS_ORIGIN_ISOLATION: 'off' } }),
  ]);
}, 120_000);
afterAll(async () => {
  await isolated?.stop();
  await plain?.stop();
});

describe('cross-origin isolation', () => {
  it('sends COOP and COEP with the studio, its assets and its routes, unless turned off', async () => {
    for (const path of ['/', '/assets/app-abc123.js', '/p/prj_0000000000/editor']) {
      const res = await fetch(`${isolated.url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    }
    const asset = await fetch(`${isolated.url}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    const off = await fetch(`${plain.url}/`);
    expect(off.status).toBe(200);
    expect(off.headers.get('cross-origin-opener-policy')).toBeNull();
    expect(off.headers.get('cross-origin-embedder-policy')).toBeNull();
  });
});

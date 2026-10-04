import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from '../helpers/stack';

/** Serving under a subpath (docs/design/subpath.md): both proxy styles reach the same studio. */
let stack: Stack;
let web: string;
beforeAll(async () => {
  web = await mkdtemp(join(tmpdir(), 'rideo-web-'));
  await mkdir(join(web, 'assets'));
  await writeFile(
    join(web, 'index.html'),
    '<!doctype html><html><head><meta charset="UTF-8" /><base href="/" /><script type="module" src="./assets/app.js"></script></head><body></body></html>',
  );
  await writeFile(join(web, 'assets', 'app.js'), 'export {};');
  stack = await startStack({ env: { RIDEO_BASE_PATH: '/studio', RIDEO_WEB_DIST: web } });
});
afterAll(async () => {
  await stack?.stop();
  await rm(web, { recursive: true, force: true });
});

const page = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${stack.url}${path}`, { headers });
  return { res, text: await res.text() };
};

describe('a studio under /studio', () => {
  it('writes its base into every page, with the prefix kept or stripped, or the proxy’s', async () => {
    for (const path of [
      '/studio/',
      '/studio',
      '/',
      '/studio/p/prj_0123456789ab/editor',
      '/p/prj_0123456789ab',
    ]) {
      const { res, text } = await page(path);
      expect(res.status, path).toBe(200);
      expect(text, path).toContain('<base href="/studio/" />');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    }
    const proxied = await page('/', { 'x-forwarded-prefix': '/rideo' });
    expect(proxied.text).toContain('<base href="/rideo/" />');
    const hostile = await page('/', { 'x-forwarded-prefix': '//evil.example' });
    expect(hostile.text).toContain('<base href="/studio/" />');
  });

  it('serves files, the API and problems under the prefix', async () => {
    const js = await page('/studio/assets/app.js');
    expect(js.res.status).toBe(200);
    expect(js.res.headers.get('content-type')).toContain('javascript');
    const missing = await page('/studio/assets/gone-123.js');
    expect(missing.res.status).toBe(404);
    expect(missing.res.headers.get('content-type')).toContain('application/problem+json');
    expect((await page('/studio/api/health')).res.status).toBe(200);
    expect((await page('/api/health')).res.status).toBe(200);
    const config = JSON.parse((await page('/studio/api/config')).text);
    expect(config.basePath).toBe('/studio');
    expect(JSON.parse((await page('/api/config', { 'x-forwarded-prefix': '/rideo' })).text).basePath).toBe(
      '/rideo',
    );
  });

  it('keeps the session cookie, the live channel and the built-in WebDAV server under the prefix', async () => {
    const out = await fetch(`${stack.url}/studio/api/auth/logout`, { method: 'POST' });
    expect(out.headers.get('set-cookie')).toContain('Path=/studio;');
    const hello = await new Promise<{ type: string }>((resolve, reject) => {
      const ws = new WebSocket(`${stack.url.replace(/^http/, 'ws')}/studio/api/live`);
      ws.onmessage = (e) => {
        resolve(JSON.parse(String(e.data)));
        ws.close();
      };
      ws.onerror = () => reject(new Error('live channel refused'));
    });
    expect(hello.type).toBe('hello');
    await stack.api('POST', '/projects', { kind: 'edit', title: 'Under a subpath' });
    const dav = await fetch(`${stack.url}/studio/dav/rideo/`, {
      method: 'PROPFIND',
      headers: { depth: '1' },
    });
    expect(dav.status).toBe(207);
    const xml = await dav.text();
    const hrefs = [...xml.matchAll(/<(?:\w+:)?href>([^<]+)</g)].map((m) => decodeURIComponent(m[1]!));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(new URL(href, stack.url).pathname.startsWith('/studio/dav/')).toBe(true);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/http/app';
import { KEPT_PREFIX_WARNING_EVERY_MS } from '../../src/http/base-path';
import { type Stack, startStack } from '../helpers/stack';

/** Serving under a subpath (docs/design/subpath.md): both proxy styles reach the same studio. */
let stack: Stack;
/** A studio at the root, for prefixes a client names (docs/design/subpath.md#both-proxy-styles). */
let root: Stack;
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
  root = await startStack({ gw: stack.gw, env: { RIDEO_WEB_DIST: web } });
});
afterAll(async () => {
  await root?.stop();
  await stack?.stop();
  await rm(web, { recursive: true, force: true });
});

const page = async (path: string, headers: Record<string, string> = {}, on: Stack = stack) => {
  const res = await fetch(`${on.url}${path}`, { headers });
  return { res, text: await res.text() };
};

/** What a path reaches: `json` (an API route), `metrics`, `page` (the app, as for any unknown page) or `problem`. */
const reached = async (
  on: Stack,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
) => {
  const res = await fetch(`${on.url}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await res.body?.cancel();
  const type = res.headers.get('content-type') ?? '';
  const kind = type.startsWith('text/plain')
    ? 'metrics'
    : type.startsWith('text/html')
      ? 'page'
      : type.startsWith('application/problem+json')
        ? 'problem'
        : type.startsWith('application/json')
          ? 'json'
          : type.includes('xml')
            ? 'dav'
            : type;
  return `${res.status} ${kind}`;
};

/** The first WebSocket frame's text: server frames are not masked. */
function firstFrame(buf: Buffer): string | null {
  if (buf.length < 2) return null;
  let length = buf[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buf.length < 10) return null;
    length = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  return buf.length >= offset + length ? buf.subarray(offset, offset + length).toString('utf8') : null;
}

/** A WebSocket upgrade of `path`: `101` with the type of the first message, or the status of the refusal. */
const upgrade = (on: Stack, path: string, headers: Record<string, string> = {}) =>
  new Promise<string>((resolve, reject) => {
    const { hostname, port } = new URL(on.url);
    const req = request({
      hostname,
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket, head) => {
      let buf = head;
      const done = () => {
        const text = firstFrame(buf);
        if (text === null) return false;
        socket.destroy();
        resolve(`${res.statusCode} ${(JSON.parse(text) as { type: string }).type}`);
        return true;
      };
      if (done()) return;
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        done();
      });
      socket.on('error', reject);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(String(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

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
    // longer than a base path may be: ignored, the configured base written
    const long = await page('/', { 'x-forwarded-prefix': `/${'a'.repeat(300)}` });
    expect(long.text).toContain('<base href="/studio/" />');
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

  it('serves a stripping proxy’s requests as they come, written with its X-Forwarded-Prefix', async () => {
    const proxy = { 'x-forwarded-prefix': '/rideo' };
    expect(await reached(stack, 'GET', '/api/health', proxy)).toBe('200 json');
    expect(await upgrade(stack, '/api/live', proxy)).toBe('101 hello');
    const out = await fetch(`${stack.url}/api/auth/logout`, { method: 'POST', headers: proxy });
    expect(out.headers.get('set-cookie')).toContain('Path=/rideo;');
    const dav = await fetch(`${stack.url}/dav/`, { method: 'PROPFIND', headers: { ...proxy, depth: '1' } });
    expect(dav.status).toBe(207);
    const hrefs = [...(await dav.text()).matchAll(/<(?:\w+:)?href>([^<]+)</g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(new URL(href, stack.url).pathname.startsWith('/rideo/dav/')).toBe(true);
  });

  it('never strips again a path its proxy stripped: /studio/studio/… is not /…', async () => {
    // a stripping proxy at /studio in front: the client's /studio/studio/api/health arrives as /studio/api/health
    const proxy = { 'x-forwarded-prefix': '/studio' };
    expect(await reached(stack, 'GET', '/studio/api/health', proxy)).toBe('200 page');
    expect(await reached(stack, 'GET', '/studio/metrics', proxy)).toBe('200 page');
    expect(await reached(stack, 'PROPFIND', '/studio/dav/', { ...proxy, depth: '0' })).toBe('404 problem');
    expect(await upgrade(stack, '/studio/api/live', proxy)).toBe('200');
    // the same paths without the header: a proxy that keeps the prefix
    expect(await reached(stack, 'GET', '/studio/api/health')).toBe('200 json');
    expect(await upgrade(stack, '/studio/api/live')).toBe('101 hello');
  });

  it('never serves a route under a client’s X-Forwarded-Prefix: a proxy’s rules about paths hold', async () => {
    // what a proxy in front may deny, kept under the base path
    expect(await reached(stack, 'GET', '/studio/metrics')).toBe('200 metrics');
    expect(await reached(stack, 'GET', '/studio/api/settings')).toBe('200 json');
    // the same under a prefix the client names, before the base path or after it, and the base path itself with a
    // client's header (a keeping proxy that passes it on): no route serves them
    for (const [prefix, base] of [
      ['/x', '/x'],
      ['/studio/x', '/studio/x'],
      ['/x', '/studio'],
    ] as const) {
      const client = { 'x-forwarded-prefix': prefix };
      expect(await reached(stack, 'GET', `${base}/metrics`, client), base).toBe('200 page');
      expect(await reached(stack, 'GET', `${base}/api/settings`, client), base).toBe('200 page');
      expect(
        await reached(stack, 'PUT', `${base}/api/settings`, client, {
          values: { RIDEO_BRAND_NAME: 'Owned' },
        }),
        base,
      ).toBe('404 problem');
    }
    expect((await stack.api<{ brand: { name: string } }>('GET', '/config')).brand.name).toBe('Rideo');
  });

  it('never re-roots routing under a client’s X-Forwarded-Prefix', async () => {
    expect(await reached(stack, 'GET', '/x/api/health', { 'x-forwarded-prefix': '/x' })).toBe('200 page');
    expect(await reached(stack, 'GET', '/studio/x/api/config', { 'x-forwarded-prefix': '/studio/x' })).toBe(
      '200 page',
    );
    expect(await reached(stack, 'PROPFIND', '/x/dav/', { 'x-forwarded-prefix': '/x', depth: '0' })).toBe(
      '404 problem',
    );
    expect(await upgrade(stack, '/x/api/live', { 'x-forwarded-prefix': '/x' })).toBe('200');
  });
});

describe('a studio at the root', () => {
  it('never re-roots routing under a client’s X-Forwarded-Prefix: a proxy’s rules about paths hold', async () => {
    const client = { 'x-forwarded-prefix': '/x' };
    // what a proxy in front may deny
    expect(await reached(root, 'GET', '/metrics')).toBe('200 metrics');
    expect(await reached(root, 'GET', '/api/settings')).toBe('200 json');
    expect(await reached(root, 'PROPFIND', '/dav/', { depth: '0' })).toBe('207 dav');
    expect(await upgrade(root, '/api/live')).toBe('101 hello');
    // the same under a prefix the client names: no route serves it
    expect(await reached(root, 'GET', '/x/metrics', client)).toBe('200 page');
    expect(await reached(root, 'GET', '/x/api/settings', client)).toBe('200 page');
    expect(
      await reached(root, 'PUT', '/x/api/settings', client, { values: { RIDEO_BRAND_NAME: 'Owned' } }),
    ).toBe('404 problem');
    expect((await root.api<{ brand: { name: string } }>('GET', '/config')).brand.name).toBe('Rideo');
    expect(await reached(root, 'PROPFIND', '/x/dav/', { ...client, depth: '0' })).toBe('404 problem');
    expect(await upgrade(root, '/x/api/live', client)).toBe('200');
    // the header still names the base of the client's pages
    expect((await page('/', client, root)).text).toContain('<base href="/x/" />');
  });

  it('serves a stripping proxy at /mcp/: a header base may start with one of the studio’s own paths', async () => {
    for (const prefix of ['/mcp', '/api/x', '/assets']) {
      const proxy = { 'x-forwarded-prefix': prefix };
      expect((await page('/', proxy, root)).text, prefix).toContain(`<base href="${prefix}/" />`);
      expect(JSON.parse((await page('/api/config', proxy, root)).text).basePath, prefix).toBe(prefix);
    }
    // the app's own requests through the proxy at /mcp/: the client's /mcp/api/… arrives as /api/…
    const proxy = { 'x-forwarded-prefix': '/mcp' };
    expect(await reached(root, 'GET', '/api/health', proxy)).toBe('200 json');
    expect(await upgrade(root, '/api/live', proxy)).toBe('101 hello');
    const out = await fetch(`${root.url}/api/auth/logout`, { method: 'POST', headers: proxy });
    expect(out.headers.get('set-cookie')).toContain('Path=/mcp;');
    const dav = await fetch(`${root.url}/dav/`, { method: 'PROPFIND', headers: { ...proxy, depth: '1' } });
    expect(dav.status).toBe(207);
    const hrefs = [...(await dav.text()).matchAll(/<(?:\w+:)?href>([^<]+)</g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs)
      expect(new URL(href, root.url).pathname.startsWith('/mcp/dav/'), href).toBe(true);
    // its client's /mcp/mcp arrives as /mcp: the studio's MCP endpoint, never the header's value removed
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'subpath', version: '0' },
      },
    };
    expect(
      await reached(root, 'POST', '/mcp', { ...proxy, accept: 'application/json, text/event-stream' }, init),
    ).toMatch(/^200 (json|text\/event-stream)$/);
  });
});

describe('the warning about a proxy that keeps the prefix and sends X-Forwarded-Prefix', () => {
  it('is logged once per 10-minute window, with the base, which base it is and the method only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rideo-kept-prefix-'));
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(JSON.parse(line));
        done();
      },
    });
    let now = 1_000_000;
    const server = await buildServer(
      loadConfig({
        RIDEO_PORT: '0',
        RIDEO_HOST: '127.0.0.1',
        RIDEO_DATA_DIR: dataDir,
        RIDEO_STORAGE: 'embedded',
        RIDEO_BASE_PATH: '/studio',
        NODE_ENV: 'test',
        RIDEO_WATERMARK_KEY: 'integration-test-key',
        RIDEO_WEBDAV_SYNC_INTERVAL_SEC: '0',
        RIDEO_WEB_DIST: web,
      }),
      { logger: { level: 'warn', stream }, now: () => now },
    );
    const at = { url: await server.start() } as Stack;
    try {
      const warnings = () =>
        lines.filter((l) => String(l.msg).startsWith('a request that carries X-Forwarded-Prefix'));
      // no header, or a path under no base: nothing to say
      expect(await reached(at, 'GET', '/studio/api/health')).toBe('200 json');
      expect(await reached(at, 'GET', '/api/health', { 'x-forwarded-prefix': '/rideo' })).toBe('200 json');
      expect(warnings()).toHaveLength(0);
      // a keeping proxy that sends the header: the page answers, and the line is logged once; a share link carries
      // its secret in its path, an API or agent token in `?token=`
      const proxy = { 'x-forwarded-prefix': '/studio' };
      const share = '/studio/review/prj_0123456789ab.rev_0123456789ab.S3CR3T-LINK?token=secret-tok&x=1';
      expect(await reached(at, 'GET', share, proxy)).toBe('200 page');
      expect(await reached(at, 'GET', '/studio/metrics', { 'x-forwarded-prefix': '/x<y>' })).toBe('200 page');
      expect(await upgrade(at, '/studio/api/live', proxy)).toBe('200');
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toMatchObject({
        level: 40,
        component: 'subpath',
        base: '/studio',
        signal: 'configured',
        method: 'GET',
      });
      expect(warnings()[0]).not.toHaveProperty('url');
      expect(String(warnings()[0]!.msg)).toContain(
        "if the proxy in front keeps the prefix in paths, it must not send X-Forwarded-Prefix and must drop a client's",
      );
      // nothing after the base, no query, no header text
      expect(JSON.stringify(lines)).not.toMatch(/review|prj_|rev_|S3CR3T|secret-tok|token|<y>/);
      // the rest of the window: still one line
      now += KEPT_PREFIX_WARNING_EVERY_MS - 1;
      expect(await reached(at, 'GET', '/studio/api/config', proxy)).toBe('200 page');
      expect(warnings()).toHaveLength(1);
      // the next window: one more, from a WebSocket upgrade too
      now += 1;
      expect(await upgrade(at, '/studio/api/live?token=secret-tok', proxy)).toBe('200');
      expect(await reached(at, 'GET', '/studio/api/config', proxy)).toBe('200 page');
      expect(warnings()).toHaveLength(2);
      expect(warnings()[1]).toMatchObject({ base: '/studio', signal: 'configured', method: 'GET' });
      // the window after: a path under the header's own base, from a POST
      now += KEPT_PREFIX_WARNING_EVERY_MS;
      expect(await reached(at, 'POST', '/rideo/api/projects', { 'x-forwarded-prefix': '/rideo' }, {})).toBe(
        '404 problem',
      );
      expect(warnings()).toHaveLength(3);
      expect(warnings()[2]).toMatchObject({ base: '/rideo', signal: 'header', method: 'POST' });
      expect(JSON.stringify(lines)).not.toMatch(/S3CR3T|secret-tok|token/);
    } finally {
      await server.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('a studio under /studio with a token', () => {
  const TOKEN = 'subpath-studio-token';
  let tokened: Stack;
  beforeAll(async () => {
    tokened = await startStack({
      gw: stack.gw,
      env: { RIDEO_BASE_PATH: '/studio', RIDEO_API_TOKEN: TOKEN, RIDEO_WEB_DIST: web },
    });
  });
  afterAll(async () => {
    await tokened?.stop();
  });

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
  };
  const bearer = { authorization: `Bearer ${TOKEN}` };

  /** The status of a request whose path goes out as written: the router decodes percent-escapes itself. */
  const status = async (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) => {
    const res = await fetch(`${tokened.url}${path}`, {
      method,
      headers: {
        accept: 'application/json, text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await res.body?.cancel();
    return res.status;
  };

  /** A request in absolute form (`GET http://host/path`): its status and the type of what answered. */
  const absolute = (target: string, headers: Record<string, string> = {}) =>
    new Promise<string>((resolve, reject) => {
      const { hostname, port } = new URL(tokened.url);
      const req = request({ hostname, port, path: target, headers }, (res) => {
        res.resume();
        const type = String(res.headers['content-type'] ?? '');
        resolve(`${res.statusCode} ${type.split(';')[0]}`);
      });
      req.on('error', reject);
      req.end();
    });

  it('asks for credentials on every protected path under the base, however it is written', async () => {
    expect({
      projects: await status('GET', '/studio/%61pi/projects'),
      escapedRoute: await status('GET', '/studio/api/%70rojects'),
      mcp: await status('POST', '/studio/%6dcp', {}, initialize),
      metrics: await status('GET', '/studio/%6detrics'),
      settings: await status('GET', '/studio/api/%73ettings'),
      live: await upgrade(tokened, '/studio/api/%6cive'),
      plainLive: await upgrade(tokened, '/studio/api/live'),
      // the open routes stay open
      health: await status('GET', '/studio/%61pi/health'),
    }).toEqual({
      projects: 401,
      escapedRoute: 401,
      mcp: 401,
      metrics: 401,
      settings: 401,
      live: '401',
      plainLive: '401',
      health: 200,
    });
  });

  it('never serves a protected route to a request in absolute form without credentials', async () => {
    for (const host of ['127.0.0.1', 'example.com']) {
      // with the base path: not removed from an absolute-form target, so no route under it answers (the app's page)
      expect(await absolute(`http://${host}/studio/api/projects`), host).toBe('200 text/html');
      expect(await absolute(`http://${host}/studio/%61pi/projects`), host).toBe('200 text/html');
      expect(await absolute(`http://${host}/studio/metrics`), host).toBe('200 text/html');
      // without it: the route asks for credentials
      expect(await absolute(`http://${host}/api/projects`), host).toBe('401 application/problem+json');
      expect(await absolute(`http://${host}/%61pi/projects`), host).toBe('401 application/problem+json');
      expect(await absolute(`http://${host}/metrics`), host).toBe('401 application/problem+json');
    }
    // with the token, the absolute form reaches the route like any other
    expect(await absolute('http://127.0.0.1/api/projects', bearer)).toBe('200 application/json');
  });

  it('serves the same paths with the token', async () => {
    expect({
      projects: await status('GET', '/studio/%61pi/projects', bearer),
      escapedRoute: await status('GET', '/studio/api/%70rojects', bearer),
      mcp: await status('POST', '/studio/%6dcp', bearer, initialize),
      metrics: await status('GET', '/studio/%6detrics', bearer),
      settings: await status('GET', '/studio/api/%73ettings', bearer),
      live: await upgrade(tokened, '/studio/api/%6cive', bearer),
      liveByQuery: await upgrade(tokened, `/studio/api/live?token=${TOKEN}`),
    }).toEqual({
      projects: 200,
      escapedRoute: 200,
      mcp: 200,
      metrics: 200,
      settings: 200,
      live: '101 hello',
      liveByQuery: '101 hello',
    });
  });
});

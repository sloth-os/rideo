import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutTrailingSlashes } from '@rideo/shared';
import { describe, expect, it } from 'vitest';
import {
  BUILD_TOP_LEVEL,
  loadConfig,
  MAX_BASE_PATH_LENGTH,
  normalizeBasePath,
  RESERVED_PREFIXES,
} from '../../src/config';
import { buildServer } from '../../src/http/app';
import {
  applyBasePath,
  forwardedPrefix,
  injectBase,
  KEPT_PREFIX_WARNING_EVERY_MS,
  keptPrefixWarning,
  redactUrl,
  requestBase,
} from '../../src/http/base-path';
import { DAV_PREFIX } from '../../src/storage/embedded-dav';

const req = (url: string, prefix?: string) =>
  ({
    url,
    headers: prefix !== undefined ? { 'x-forwarded-prefix': prefix } : {},
  }) as unknown as IncomingMessage;

/** The URL a request is routed with and the base its pages are written with. */
const applied = (url: string, configured: string, prefix?: string) => {
  const r = req(url, prefix);
  applyBasePath(r, configured);
  return { url: r.url, base: requestBase(r) };
};

describe('serving under a subpath (docs/design/subpath.md)', () => {
  it('accepts requests with the prefix (kept by the proxy) and without it (stripped)', () => {
    for (const [url, out] of [
      ['/rideo/api/health', '/api/health'],
      ['/rideo', '/'],
      ['/rideo/', '/'],
      ['/rideo?x=1', '/?x=1'],
      ['/api/health', '/api/health'],
      ['/rideoish/api', '/rideoish/api'],
      // once: a path that keeps a second prefix after the first is not the root's
      ['/rideo/rideo/metrics', '/rideo/metrics'],
    ] as const) {
      expect(applied(url, '/rideo'), url).toEqual({ url: out, base: '/rideo' });
    }
  });

  it('takes the proxy’s X-Forwarded-Prefix for pages and links when it is a plain path, never a host', () => {
    expect(applied('/p/prj_0123456789ab', '', '/studio')).toEqual({
      url: '/p/prj_0123456789ab',
      base: '/studio',
    });
    for (const bad of ['//evil.example', 'https://evil.example', '/a/../b', '/a b']) {
      expect(applied('/api/health', '/rideo', bad).base, bad).toBe('/rideo');
    }
    expect(applied('/', '', '/a, /b').base).toBe('/a');
  });

  it('never removes the header’s prefix from a path: a client cannot re-root the studio under a prefix of its choice', () => {
    // at the root: X-Forwarded-Prefix /x with /x/metrics is not /metrics
    expect(applied('/x/metrics', '', '/x')).toEqual({ url: '/x/metrics', base: '/x' });
    expect(applied('/x', '', '/x').url).toBe('/x');
    expect(applied('/x/api/settings?y=1', '', '/x').url).toBe('/x/api/settings?y=1');
    // under a base path: nor another prefix
    expect(applied('/x/dav/rideo/', '/rideo', '/x').url).toBe('/x/dav/rideo/');
    expect(applied('/x/api/live', '/rideo', '/x').url).toBe('/x/api/live');
  });

  it('routes a request that carries X-Forwarded-Prefix as it came: its proxy stripped the prefix already', () => {
    // behind a stripping proxy at /rideo, the client's /rideo/rideo/metrics arrives as /rideo/metrics
    expect(applied('/rideo/metrics', '/rideo', '/rideo')).toEqual({ url: '/rideo/metrics', base: '/rideo' });
    expect(applied('/api/health', '/rideo', '/rideo')).toEqual({ url: '/api/health', base: '/rideo' });
    expect(applied('/studio/api/health', '/studio', '/rideo').url).toBe('/studio/api/health');
    // nor a prefix that starts with the base path: /rideo/x/metrics is neither /metrics nor /x/metrics
    expect(applied('/rideo/x/metrics', '/rideo', '/rideo/x').url).toBe('/rideo/x/metrics');
    // whatever its value: one that is no base path is still a proxy's
    expect(applied('/rideo/metrics', '/rideo', '//evil.example')).toEqual({
      url: '/rideo/metrics',
      base: '/rideo',
    });
    expect(applied('/rideo/metrics', '/rideo', `/${'a'.repeat(MAX_BASE_PATH_LENGTH)}`).url).toBe(
      '/rideo/metrics',
    );
    // an empty header is none
    expect(applied('/rideo/api/health', '/rideo', '').url).toBe('/api/health');
  });

  it('ignores an X-Forwarded-Prefix that starts with one of the studio’s own paths', () => {
    for (const value of ['/api', '/dav/x', '/mcp', '/metrics', '/sw.js', '/assets/v2']) {
      expect(forwardedPrefix(req('/', value)), value).toBeNull();
      // still a stripping proxy's request: routed as it came, written with the configured base
      expect(applied('/api/health', '/rideo', value), value).toEqual({ url: '/api/health', base: '/rideo' });
    }
    expect(forwardedPrefix(req('/', '/api-docs'))).toBe('/api-docs');
    expect(forwardedPrefix(req('/', '/studio/api'))).toBe('/studio/api');
  });

  it('ignores an X-Forwarded-Prefix longer than 256 characters before reading it', () => {
    const longest = `/${'a'.repeat(MAX_BASE_PATH_LENGTH - 1)}`;
    expect(forwardedPrefix(req('/', longest))).toBe(longest);
    expect(forwardedPrefix(req('/', `${longest}a`))).toBeNull();
    expect(forwardedPrefix(req('/', `/a, ${'b'.repeat(MAX_BASE_PATH_LENGTH)}`))).toBeNull();
    expect(applied('/', '/rideo', `${longest}a`).base).toBe('/rideo');
  });

  it('reads base paths in time linear in their length, a run of slashes too', () => {
    // `/\/+$/` took about 17 s on each of these (quadratic in the run of slashes before the last character)
    const run = `${'/'.repeat(200_000)}x`;
    const started = performance.now();
    expect(withoutTrailingSlashes(run)).toBe(run);
    expect(withoutTrailingSlashes(`/a${run}`)).toBe(`/a${run}`);
    expect(withoutTrailingSlashes(`/a${'/'.repeat(200_000)}`)).toBe('/a');
    expect(normalizeBasePath(run)).toBeNull();
    expect(forwardedPrefix(req('/', run))).toBeNull();
    expect(applied('/api/health', '/rideo', run)).toEqual({ url: '/api/health', base: '/rideo' });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('writes the base into the page', () => {
    const html = '<!doctype html><html><head>\n<meta charset="UTF-8" />\n<base href="/" />\n</head></html>';
    expect(injectBase(html, '/rideo')).toContain('<base href="/rideo/" />');
    expect(injectBase(html, '')).toContain('<base href="/" />');
    expect(injectBase('<html><head lang="x"><title>t</title></head></html>', '/a')).toContain(
      '<head lang="x">\n    <base href="/a/" />',
    );
  });
});

/** The full paths of the routes a server registers, read from Fastify's route tree (one line per node). */
function routePaths(tree: string): string[] {
  const parents: string[] = [];
  const paths: string[] = [];
  for (const line of tree.split('\n')) {
    const node = /^((?:│ {3}| {4})*)[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line);
    if (!node) continue;
    parents.length = node[1]!.length / 4;
    parents.push(node[2]!);
    if (node[3]) paths.push(parents.join(''));
  }
  return paths;
}

/** The first segments of the paths a studio's server answers through Fastify, served with `webDist`. */
async function firstSegments(webDist: string): Promise<string[]> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rideo-own-paths-'));
  const server = await buildServer(
    loadConfig({
      RIDEO_DATA_DIR: dataDir,
      RIDEO_STORAGE: 'embedded',
      RIDEO_WEB_DIST: webDist || join(dataDir, 'no-web'),
      NODE_ENV: 'test',
      RIDEO_WATERMARK_KEY: 'unit-test-key',
    }),
    { logger: false },
  );
  try {
    await server.app.ready();
    const paths = routePaths(server.app.printRoutes({ commonPrefix: false }));
    expect(paths.length).toBeGreaterThan(10);
    return [...new Set(paths.map((path) => path.split('/')[1]!).filter(Boolean))].sort();
  } finally {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const web = fileURLToPath(new URL('../../../web/', import.meta.url));
/** The top-level entries of a directory of the web app, or null while it is not there (not built, or rebuilt now). */
const entries = (dir: string): string[] | null => {
  try {
    return readdirSync(join(web, dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};

describe('the studio’s own top-level paths (docs/design/subpath.md#the-base-path)', () => {
  it('are the first segments of the server’s routes and the embedded WebDAV server', async () => {
    const own = [...RESERVED_PREFIXES].sort();
    expect(own).toEqual(['/api', '/dav', '/mcp', '/metrics']);
    // without a web build: the routes of the API, MCP and metrics, and the WebDAV server the factory answers first
    const routes = await firstSegments('');
    expect([...routes.map((s) => `/${s}`), DAV_PREFIX].sort()).toEqual(own);
  }, 60_000);

  it('name the top of the web app’s build, which the server answers at the root', async () => {
    expect([...BUILD_TOP_LEVEL].sort()).toEqual(
      ['assets', 'icons', 'index.html', 'logo.svg', 'manifest.webmanifest', 'sw.js', 'sw.js.map'].sort(),
    );
    // the public files are copied to the top of the build
    const publicFiles = entries('public');
    expect(publicFiles).not.toBeNull();
    for (const entry of publicFiles!) expect(BUILD_TOP_LEVEL, `public/${entry}`).toContain(entry);
    const dist = entries('dist');
    if (!dist?.includes('index.html')) return;
    expect(dist).toEqual([...BUILD_TOP_LEVEL].sort());
    // served: each file of the build is a route at the root, and no route starts with anything else
    const own = [...RESERVED_PREFIXES.map((p) => p.slice(1)), ...BUILD_TOP_LEVEL];
    for (const segment of await firstSegments(join(web, 'dist'))) expect(own, segment).toContain(segment);
  }, 60_000);
});

describe('the warning about a proxy that keeps the prefix and sends X-Forwarded-Prefix', () => {
  /** A server's check with a clock the test moves, and the lines it logged. */
  const check = (configured: string) => {
    let now = 0;
    const lines: { obj: object; msg: string }[] = [];
    const warn = keptPrefixWarning({ warn: (obj, msg) => lines.push({ obj, msg }) }, configured, () => now);
    return {
      lines,
      send: (url: string, prefix?: string) => warn(req(url, prefix)),
      at: (ms: number) => {
        now = ms;
      },
    };
  };

  it('is logged at most once every 10 minutes per server, worded as a condition on the proxy', () => {
    const server = check('/rideo');
    server.send('/rideo/api/projects', '/rideo');
    expect(server.lines).toHaveLength(1);
    expect(server.lines[0]!.obj).toEqual({ base: '/rideo', url: '/rideo/api/projects' });
    const msg = server.lines[0]!.msg;
    expect(msg).toContain(
      'has a path under /rideo; such a request is routed as it came, /rideo kept on its path',
    );
    expect(msg).toContain(
      "if the proxy in front keeps the prefix in paths, it must not send X-Forwarded-Prefix and must drop a client's",
    );
    for (const directive of [
      'proxy_set_header X-Forwarded-Prefix ""',
      'header_up -X-Forwarded-Prefix',
      'RequestHeader unset X-Forwarded-Prefix',
    ])
      expect(msg).toContain(directive);
    expect(msg).toContain('docs/design/subpath.md#upgrading-from-an-earlier-version');
    // within the window: no more lines, whatever the request
    server.at(KEPT_PREFIX_WARNING_EVERY_MS - 1);
    server.send('/rideo/api/live', '/rideo');
    server.send('/rideo', '/x');
    expect(server.lines).toHaveLength(1);
    // the next window
    server.at(KEPT_PREFIX_WARNING_EVERY_MS);
    server.send('/rideo?x=1', '/x');
    expect(server.lines).toHaveLength(2);
    expect(server.lines[1]!.obj).toEqual({ base: '/rideo', url: '/rideo?x=1' });
    server.at(2 * KEPT_PREFIX_WARNING_EVERY_MS - 1);
    server.send('/rideo/metrics', '/rideo');
    expect(server.lines).toHaveLength(2);
    // per server: another one has its own window
    const other = check('/rideo');
    other.send('/rideo/metrics', '/rideo');
    expect(other.lines).toHaveLength(1);
  });

  it('is logged for a request with the header whose path starts with the configured base or the header’s', () => {
    const server = check('/rideo');
    server.send('/rideo/api/projects'); // no header: a keeping proxy's, the base is removed
    server.send('/rideo/api/projects', ''); // an empty header is none
    server.send('/api/projects', '/rideo'); // its proxy stripped the prefix
    server.send('/rideoish/api', '/rideo'); // not under the base
    expect(server.lines).toHaveLength(0);
    // at the root, the header's own base path
    const root = check('');
    root.send('/api/projects', '/studio');
    expect(root.lines).toHaveLength(0);
    root.send('/studio/api/projects', '/studio');
    expect(root.lines.map((l) => l.obj)).toEqual([{ base: '/studio', url: '/studio/api/projects' }]);
  });

  it('names a valid base path only, never the header’s text, and the URL with its token redacted', () => {
    const server = check('/rideo');
    server.send('/rideo/api/live?token=secret-tok&x=1', '//evil.example/<script>');
    expect(server.lines.map((l) => l.obj)).toEqual([
      { base: '/rideo', url: '/rideo/api/live?token=[redacted]&x=1' },
    ]);
    expect(JSON.stringify(server.lines)).not.toMatch(/evil|script|secret-tok/);
    // at the root, a header that is no base path names no base: nothing to say
    const root = check('');
    for (const prefix of ['//evil.example', '/evil/<x>', '/api', `/${'a'.repeat(MAX_BASE_PATH_LENGTH)}`])
      root.send(`${prefix}/api/projects`, prefix);
    expect(root.lines).toHaveLength(0);
  });

  it('redacts the value of each token query parameter, however its name is written', () => {
    expect(redactUrl('/api/live?token=a&TOKEN=b&%74oken=c&tokens=d&x=token%3De&y=1')).toBe(
      '/api/live?token=[redacted]&TOKEN=[redacted]&%74oken=[redacted]&tokens=d&x=token%3De&y=1',
    );
    expect(redactUrl('/api/live')).toBe('/api/live');
    expect(redactUrl('/a?token')).toBe('/a?token');
    expect(redactUrl('/a?%zz=1&token=2')).toBe('/a?%zz=1&token=[redacted]');
    // linear: a long URL is redacted at once
    const long = `/a?${'b=1&'.repeat(50_000)}token=x`;
    const started = performance.now();
    expect(redactUrl(long).endsWith('&token=[redacted]')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

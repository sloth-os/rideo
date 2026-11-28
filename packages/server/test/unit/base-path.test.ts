import { readdirSync, readFileSync } from 'node:fs';
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
  requestBase,
} from '../../src/http/base-path';
import { DAV_PREFIX } from '../../src/storage/embedded-dav';

const req = (url: string, prefix?: string, method = 'GET') =>
  ({
    url,
    method,
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

  it('takes an X-Forwarded-Prefix that starts with one of the studio’s own paths: its value is never removed from a path', () => {
    // a stripping proxy at /mcp/, /api/x/ or /assets/ (docs/design/subpath.md#the-base-path)
    for (const value of ['/mcp', '/api/x', '/assets', '/api', '/dav/x', '/metrics', '/sw.js', '/assets/v2']) {
      expect(forwardedPrefix(req('/', value)), value).toBe(value);
      // routed as it came, written with the header's base
      expect(applied('/api/health', '/rideo', value), value).toEqual({ url: '/api/health', base: value });
      expect(applied('/api/health', '', value), value).toEqual({ url: '/api/health', base: value });
    }
    // the MCP endpoint behind a stripping proxy at /mcp/: the client's /mcp/mcp arrives as /mcp and stays there
    expect(applied('/mcp', '', '/mcp')).toEqual({ url: '/mcp', base: '/mcp' });
    expect(forwardedPrefix(req('/', '/mcp/'))).toBe('/mcp');
    expect(forwardedPrefix(req('/', '/api-docs'))).toBe('/api-docs');
    expect(forwardedPrefix(req('/', '/studio/api'))).toBe('/studio/api');
    // every other rule still holds
    for (const bad of [
      '/api/../x',
      '/mcp//x',
      '//api',
      '/api/./x',
      '/api?x=1',
      'api',
      `/api/${'a'.repeat(MAX_BASE_PATH_LENGTH)}`,
    ])
      expect(forwardedPrefix(req('/', bad)), bad.slice(0, 20)).toBeNull();
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
/** The top-level entries of a directory of the web app, or null while it is not there (not built). */
const entries = (dir: string): string[] | null => {
  try {
    return readdirSync(join(web, dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};
/** Whether the web app is built (`npm run build -w @rideo/web`): the checks of its build run only then, and say so. */
const built = entries('dist')?.includes('index.html') ?? false;

describe('the studio’s own top-level paths (docs/design/subpath.md#the-base-path)', () => {
  it('are the first segments of the server’s routes and the embedded WebDAV server', async () => {
    const own = [...RESERVED_PREFIXES].sort();
    expect(own).toEqual(['/api', '/dav', '/mcp', '/metrics']);
    // without a web build: the routes of the API, MCP and metrics, and the WebDAV server the factory answers first
    const routes = await firstSegments('');
    expect([...routes.map((s) => `/${s}`), DAV_PREFIX].sort()).toEqual(own);
  }, 60_000);

  it('name the top of the web app’s build: its public files and what Vite and the service worker build add', () => {
    expect([...BUILD_TOP_LEVEL].sort()).toEqual(
      ['assets', 'icons', 'index.html', 'logo.svg', 'manifest.webmanifest', 'sw.js', 'sw.js.map'].sort(),
    );
    // the public files are copied to the top of the build
    const publicFiles = entries('public');
    expect(publicFiles).not.toBeNull();
    for (const entry of publicFiles!) expect(BUILD_TOP_LEVEL, `public/${entry}`).toContain(entry);
  });

  // skipped, and reported as skipped, while the web app is not built (docs/testing.md)
  it.skipIf(!built)(
    'are the top of the built web app, which the server answers at the root',
    async () => {
      const dist = entries('dist');
      expect(dist).toEqual([...BUILD_TOP_LEVEL].sort());
      // served: each file of the build is a route at the root, and no route starts with anything else
      const own = [...RESERVED_PREFIXES.map((p) => p.slice(1)), ...BUILD_TOP_LEVEL];
      for (const segment of await firstSegments(join(web, 'dist'))) expect(own, segment).toContain(segment);
    },
    60_000,
  );
});

describe('the shipped Apache httpd configuration (docs/design/subpath.md#a-stripping-proxy-delivers-its-header)', () => {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  /** The directives of an Apache configuration: its lines without comments and blank lines. */
  const directives = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  const shipped = directives(readFileSync(join(repo, 'deploy/httpd/rideo.conf'), 'utf8'));
  const documented = directives(
    /```apache\n([\s\S]*?)```/.exec(readFileSync(join(repo, 'docs/design/subpath.md'), 'utf8'))![1]!,
  );

  it('removes a client’s Connection that names X-Forwarded-Prefix, which mod_proxy_http would drop after setting it', () => {
    // mod_proxy_http drops the headers a client names in Connection after mod_headers has set X-Forwarded-Prefix
    const unset = `RequestHeader unset Connection "expr=req_novary('Connection') =~ /x-forwarded-prefix/i"`;
    for (const lines of [shipped, documented]) {
      expect(lines).toContain('RequestHeader set X-Forwarded-Prefix "/rideo"');
      expect(lines).toContain(unset);
    }
    // the documented block is the shipped file but for its X-Forwarded-Proto line
    expect(documented).toEqual(
      shipped.filter((line) => !line.startsWith('RequestHeader set X-Forwarded-Proto ')),
    );
  });
});

describe('the warning about a proxy that keeps the prefix and sends X-Forwarded-Prefix', () => {
  /** A server's check with a clock the test moves, and the lines it logged. */
  const check = (configured: string) => {
    let now = 0;
    const lines: { obj: object; msg: string }[] = [];
    const warn = keptPrefixWarning({ warn: (obj, msg) => lines.push({ obj, msg }) }, configured, () => now);
    return {
      lines,
      send: (url: string, prefix?: string, method?: string) => warn(req(url, prefix, method)),
      at: (ms: number) => {
        now = ms;
      },
    };
  };

  it('is logged at most once every 10 minutes per server, worded as a condition on the proxy', () => {
    const server = check('/rideo');
    server.send('/rideo/api/projects', '/rideo');
    expect(server.lines).toHaveLength(1);
    expect(server.lines[0]!.obj).toEqual({ base: '/rideo', signal: 'configured', method: 'GET' });
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
    server.send('/rideo?x=1', '/x', 'PROPFIND');
    expect(server.lines).toHaveLength(2);
    expect(server.lines[1]!.obj).toEqual({ base: '/rideo', signal: 'configured', method: 'PROPFIND' });
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
    expect(root.lines.map((l) => l.obj)).toEqual([{ base: '/studio', signal: 'header', method: 'GET' }]);
  });

  it('names a valid base path, which base it is and the method only: never the header’s text, nor anything after the base', () => {
    // a share link carries its secret in its path (docs/design/review.md), an API or agent token in `?token=`
    const secret = '/review/prj_0123456789ab.rev_0123456789ab.S3CR3T-SHARE-LINK';
    const server = check('/rideo');
    server.send(`/rideo${secret}?token=secret-tok&x=1`, '//evil.example/<script>');
    expect(server.lines.map((l) => l.obj)).toEqual([{ base: '/rideo', signal: 'configured', method: 'GET' }]);
    const root = check('');
    root.send(`/studio${secret}?token=secret-tok`, '/studio', 'POST');
    expect(root.lines.map((l) => l.obj)).toEqual([{ base: '/studio', signal: 'header', method: 'POST' }]);
    // no path segment after the base, no query, no header text: in the fields or the message
    for (const text of [JSON.stringify(server.lines), JSON.stringify(root.lines)])
      expect(text).not.toMatch(/review|prj_|rev_|S3CR3T|token|secret|evil|script/);
    // at the root, a header that is no base path names no base: nothing to say
    const none = check('');
    for (const prefix of ['//evil.example', '/evil/<x>', `/${'a'.repeat(MAX_BASE_PATH_LENGTH)}`])
      none.send(`${prefix}/api/projects`, prefix);
    expect(none.lines).toHaveLength(0);
  });

  it('takes no header base that starts with one of the studio’s own paths as a sign, so the app behind a proxy at /api/ stays quiet', () => {
    // the app's own requests behind stripping proxies at /api/, /mcp/ and /assets/, in window after window
    const root = check('');
    for (let window = 0; window < 3; window++) {
      root.at(window * KEPT_PREFIX_WARNING_EVERY_MS);
      for (const [url, prefix] of [
        ['/api/projects', '/api'],
        ['/api/live', '/api'],
        ['/api/config', '/api'],
        ['/api', '/api'],
        ['/mcp', '/mcp'],
        ['/assets/index.js', '/assets'],
        ['/api/x/projects', '/api/x'],
      ] as const)
        root.send(url, prefix);
    }
    expect(root.lines).toHaveLength(0);
    // the configured base path is still a sign: a keeping proxy at /rideo/ that passes a client's /api on
    const server = check('/rideo');
    server.send('/api/projects', '/api');
    expect(server.lines).toHaveLength(0);
    server.send('/rideo/api/projects', '/api');
    expect(server.lines.map((l) => l.obj)).toEqual([{ base: '/rideo', signal: 'configured', method: 'GET' }]);
  });
});

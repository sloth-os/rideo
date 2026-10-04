import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { applyBasePath, injectBase, requestBase } from '../../src/http/base-path';

const req = (url: string, prefix?: string) =>
  ({ url, headers: prefix ? { 'x-forwarded-prefix': prefix } : {} }) as unknown as IncomingMessage;

describe('serving under a subpath (docs/design/subpath.md)', () => {
  it('accepts requests with the prefix (kept by the proxy) and without it (stripped)', () => {
    for (const [url, out] of [
      ['/rideo/api/health', '/api/health'],
      ['/rideo', '/'],
      ['/rideo/', '/'],
      ['/rideo?x=1', '/?x=1'],
      ['/api/health', '/api/health'],
      ['/rideoish/api', '/rideoish/api'],
    ] as const) {
      const r = req(url);
      applyBasePath(r, '/rideo');
      expect(r.url, url).toBe(out);
      expect(requestBase(r)).toBe('/rideo');
    }
  });

  it('takes the proxy’s X-Forwarded-Prefix when it is a plain path, never a host', () => {
    const r = req('/studio/p/prj_0123456789ab', '/studio');
    applyBasePath(r, '');
    expect(r.url).toBe('/p/prj_0123456789ab');
    expect(requestBase(r)).toBe('/studio');
    for (const bad of ['//evil.example', 'https://evil.example', '/a/../b', '/a b']) {
      const x = req('/api/health', bad);
      applyBasePath(x, '/rideo');
      expect(requestBase(x), bad).toBe('/rideo');
    }
    const first = req('/', '/a, /b');
    applyBasePath(first, '');
    expect(requestBase(first)).toBe('/a');
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sameSiteOrAllowed } from '../../src/http/app';
import { type Stack, startStack } from '../helpers/stack';

/** A studio used by pages on other origins through the library (docs/design/embedding.md). */
let stack: Stack;
const HOST = 'https://host.example';
beforeAll(async () => {
  stack = await startStack({ env: { RIDEO_CORS_ORIGINS: `${HOST}, http://localhost:3000` } });
});
afterAll(async () => {
  await stack?.stop();
});

/** The first message (or the close) of a live connection opened from an origin. */
function live(origin: string): Promise<{ type: string } | { closed: number }> {
  return new Promise((resolve) => {
    const ws = new (WebSocket as unknown as new (url: string, init: unknown) => WebSocket)(
      `${stack.url.replace(/^http/, 'ws')}/api/live`,
      { headers: { origin } },
    );
    ws.onmessage = (e) => {
      resolve(JSON.parse(String(e.data)));
      ws.close();
    };
    ws.onclose = (e) => resolve({ closed: e.code });
  });
}

describe('embedding origins (docs/design/embedding.md#talking-to-a-server-on-another-origin)', () => {
  it('answers preflights and calls of allowed origins, and nothing for others', async () => {
    const pre = await fetch(`${stack.url}/api/projects`, {
      method: 'OPTIONS',
      headers: {
        origin: HOST,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, x-rideo-workspace',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(HOST);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-rideo-workspace');
    expect(pre.headers.get('access-control-allow-methods')).toContain('PATCH');

    const config = await fetch(`${stack.url}/api/config`, { headers: { origin: HOST } });
    expect(config.status).toBe(200);
    expect(config.headers.get('access-control-allow-origin')).toBe(HOST);
    expect(config.headers.get('access-control-expose-headers')).toContain('content-range');
    expect(config.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(config.headers.get('vary')).toContain('Origin');

    const other = await fetch(`${stack.url}/api/config`, { headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('opens the live channel for the studio itself and allowed origins only', async () => {
    expect(await live(HOST)).toMatchObject({ type: 'hello' });
    expect(await live(stack.url)).toMatchObject({ type: 'hello' });
    expect(await live('https://evil.example')).toEqual({ closed: 4003 });
  });

  it('tells the studio’s own origin from others behind proxies', () => {
    const req = (origin: string | undefined, host: string, forwarded?: string) => ({
      headers: { origin, host, ...(forwarded ? { 'x-forwarded-host': forwarded } : {}) },
    });
    expect(sameSiteOrAllowed(req(undefined, 'a.example'), [])).toBe(true);
    expect(sameSiteOrAllowed(req('https://a.example', 'a.example'), [])).toBe(true);
    expect(sameSiteOrAllowed(req('https://studio.example', '127.0.0.1:8787', 'studio.example'), [])).toBe(
      true,
    );
    expect(sameSiteOrAllowed(req('https://b.example', 'a.example'), [])).toBe(false);
    expect(sameSiteOrAllowed(req('https://b.example', 'a.example'), ['https://b.example'])).toBe(true);
    expect(sameSiteOrAllowed(req('https://b.example', 'a.example'), ['*'])).toBe(true);
    expect(sameSiteOrAllowed(req('not a url', 'a.example'), [])).toBe(false);
  });
});

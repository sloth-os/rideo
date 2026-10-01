import { createSign, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieValue, safeReturnTo } from '../../src/auth/accounts';
import { AuditLog } from '../../src/auth/audit';
import { OidcClient, pkcePair } from '../../src/auth/oidc';
import { SessionStore } from '../../src/auth/sessions';

/** Accounts (docs/design/accounts.md): ID-token checks, PKCE, sessions and the audit log. */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rideo-accounts-'));
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

const ISSUER = 'https://id.example.test';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = {
  keys: [
    { ...(rsa.publicKey.export({ format: 'jwk' }) as object), kid: 'rsa-1', alg: 'RS256' },
    { ...(ec.publicKey.export({ format: 'jwk' }) as object), kid: 'ec-1', alg: 'ES256' },
  ],
};
let jwksFetches = 0;
const http = (async (url: string) => {
  if (url.endsWith('/.well-known/openid-configuration'))
    return new Response(
      JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      }),
    );
  if (url.endsWith('/jwks')) {
    jwksFetches++;
    return new Response(JSON.stringify(jwks));
  }
  return new Response('no', { status: 404 });
}) as typeof fetch;
const client = new OidcClient(
  {
    issuer: ISSUER,
    clientId: 'rideo',
    scopes: 'openid email',
    redirectUri: 'https://rideo.test/api/auth/callback',
  },
  http,
);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(
  claims: Record<string, unknown>,
  opts: { alg?: 'RS256' | 'ES256'; kid?: string; key?: Parameters<typeof sign>[2] } = {},
) {
  const alg = opts.alg ?? 'RS256';
  const head = b64({ alg, kid: opts.kid ?? (alg === 'RS256' ? 'rsa-1' : 'ec-1') });
  const body = b64(claims);
  const data = Buffer.from(`${head}.${body}`);
  const sig =
    alg === 'ES256'
      ? sign('sha256', data, { key: opts.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' } as never)
      : createSign('RSA-SHA256')
          .update(data)
          .sign(opts.key ?? (rsa.privateKey as never));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);
const good = {
  iss: ISSUER,
  sub: 'u1',
  aud: 'rideo',
  exp: now + 300,
  iat: now,
  nonce: 'n1',
  email: 'a@b.test',
};

describe('OIDC (docs/design/accounts.md#sign-in-oidc)', () => {
  it('builds a PKCE authorization request', async () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = new URL(
      await client.authorizationUrl({ state: 's1', nonce: 'n1', challenge, loginHint: 'a@b.test' }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'rideo',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's1',
      nonce: 'n1',
      login_hint: 'a@b.test',
      redirect_uri: 'https://rideo.test/api/auth/callback',
    });
  });

  it('accepts RS256 and ES256 ID tokens from the issuer, for this client, in time, for this sign-in', async () => {
    expect((await client.verifyIdToken(jwt(good), 'n1')).sub).toBe('u1');
    expect(
      (await client.verifyIdToken(jwt({ ...good, aud: ['other', 'rideo'] }, { alg: 'ES256' }), 'n1')).email,
    ).toBe('a@b.test');
    const reject = (token: string, nonce = 'n1') =>
      expect(client.verifyIdToken(token, nonce)).rejects.toMatchObject({ code: 'unauthorized' });
    await reject(jwt(good, { key: other.privateKey as never }));
    await reject(jwt({ ...good, iss: 'https://evil.test' }));
    await reject(jwt({ ...good, aud: 'someone-else' }));
    await reject(jwt({ ...good, exp: now - 120 }));
    await reject(jwt({ ...good, iat: now + 600 }));
    await reject(jwt(good), 'other-nonce');
    await reject(`${jwt(good).split('.').slice(0, 2).join('.')}.`);
    // an unknown key: the JWKS is read again once
    const before = jwksFetches;
    await reject(jwt(good, { kid: 'rotated' }));
    expect(jwksFetches).toBe(before + 1);
  });
});

describe('sessions and the audit log', () => {
  it('keeps sessions by hash, with expiry, across a restart', async () => {
    const store = new SessionStore(join(dir, 'sessions'), 60_000);
    await store.init();
    const token = await store.create('usr_0000000000aaaa');
    expect(await store.get(token)).toBe('usr_0000000000aaaa');
    const again = new SessionStore(join(dir, 'sessions'), 60_000);
    expect(await again.get(token)).toBe('usr_0000000000aaaa');
    expect(await again.get('not-a-real-session-token-0000')).toBeNull();
    await again.delete(token);
    expect(await again.get(token)).toBeNull();
    const short = new SessionStore(join(dir, 'short'), 1);
    await short.init();
    const t2 = await short.create('usr_0000000000aaaa');
    await new Promise((r) => setTimeout(r, 5));
    expect(await short.get(t2)).toBeNull();
  });

  it('appends audit events and reads them newest first, filtered', async () => {
    const log = new AuditLog(join(dir, 'audit'));
    await log.init();
    const actor = { kind: 'user', id: 'usr_1', userId: 'usr_1', name: 'Mira' };
    await log.record({ type: 'auth.login', actor, at: '2026-10-01T08:00:00.000Z' });
    await log.record({
      type: 'auth.denied',
      actor,
      projectId: 'prj_1',
      outcome: 'denied',
      at: '2026-10-02T09:00:00.000Z',
    });
    await log.record({ type: 'project.access', actor, projectId: 'prj_2', at: '2026-10-02T10:00:00.000Z' });
    expect((await log.query()).map((e) => e.type)).toEqual(['project.access', 'auth.denied', 'auth.login']);
    expect((await log.query({ projectId: 'prj_1' })).map((e) => e.type)).toEqual(['auth.denied']);
    expect((await log.query({ since: '2026-10-02T00:00:00.000Z', limit: 1 })).map((e) => e.type)).toEqual([
      'project.access',
    ]);
    expect((await log.query({ projectIds: ['prj_2'], type: 'project.access' })).length).toBe(1);
  });

  it('reads cookies and refuses open redirects', () => {
    expect(cookieValue('a=1; rideo_session=abc%3D; b=2', 'rideo_session')).toBe('abc=');
    expect(cookieValue(undefined, 'rideo_session')).toBeNull();
    expect(safeReturnTo('/p/prj_1/clips?x=1')).toBe('/p/prj_1/clips?x=1');
    expect(safeReturnTo('//evil.test/')).toBe('/');
    expect(safeReturnTo('https://evil.test/')).toBe('/');
  });
});

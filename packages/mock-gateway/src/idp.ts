import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

/**
 * A mock OpenID Connect provider for tests (docs/design/accounts.md#testing): discovery, an authorization endpoint
 * that signs in the user named by `login_hint` (or the first) without a form, the token endpoint with PKCE and
 * client checks, and an RS256 JWKS.
 */
export interface MockIdpUser {
  sub: string;
  email: string;
  name: string;
}

export interface RunningMockIdp {
  url: string;
  clientId: string;
  clientSecret: string;
  users: MockIdpUser[];
  /** Every authorization request seen (tests check PKCE and nonce). */
  authorizations: Record<string, string>[];
  close(): Promise<void>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export async function startMockIdp(opts: {
  users: MockIdpUser[];
  clientId?: string;
  clientSecret?: string;
  port?: number;
}): Promise<RunningMockIdp> {
  const clientId = opts.clientId ?? 'rideo';
  const clientSecret = opts.clientSecret ?? 'rideo-secret';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, string>),
    kid: 'mock-1',
    alg: 'RS256',
    use: 'sig',
  };
  const codes = new Map<
    string,
    { user: MockIdpUser; nonce: string; challenge: string; redirectUri: string }
  >();
  const authorizations: Record<string, string>[] = [];
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  let url = '';
  const jwt = (claims: Record<string, unknown>) => {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'mock-1', typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    return `${head}.${body}.${b64url(sign('sha256', Buffer.from(`${head}.${body}`), privateKey))}`;
  };

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: url,
    authorization_endpoint: `${url}/authorize`,
    token_endpoint: `${url}/token`,
    jwks_uri: `${url}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  }));
  app.get('/jwks', async () => ({ keys: [jwk] }));
  app.get('/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    authorizations.push(q);
    const back = new URL(q.redirect_uri ?? '');
    back.searchParams.set('state', q.state ?? '');
    const user = q.login_hint ? opts.users.find((u) => u.email === q.login_hint) : opts.users[0];
    if (q.client_id !== clientId || q.code_challenge_method !== 'S256' || !q.code_challenge || !user) {
      back.searchParams.set('error', 'access_denied');
      return reply.redirect(back.toString());
    }
    const code = b64url(randomBytes(24));
    codes.set(code, {
      user,
      nonce: q.nonce ?? '',
      challenge: q.code_challenge,
      redirectUri: q.redirect_uri!,
    });
    back.searchParams.set('code', code);
    return reply.redirect(back.toString());
  });
  app.post('/token', async (req, reply) => {
    const f = req.body as Record<string, string>;
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const [id, secret] = basic
      ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent)
      : [f.client_id, f.client_secret];
    const entry = codes.get(f.code ?? '');
    codes.delete(f.code ?? '');
    const pkce =
      entry &&
      b64url(
        createHash('sha256')
          .update(f.code_verifier ?? '')
          .digest(),
      ) === entry.challenge;
    if (id !== clientId || secret !== clientSecret) return reply.code(401).send({ error: 'invalid_client' });
    if (f.grant_type !== 'authorization_code' || !entry || !pkce || f.redirect_uri !== entry.redirectUri)
      return reply.code(400).send({ error: 'invalid_grant' });
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: b64url(randomBytes(24)),
      token_type: 'Bearer',
      expires_in: 600,
      id_token: jwt({
        iss: url,
        sub: entry.user.sub,
        aud: clientId,
        iat: now,
        exp: now + 600,
        nonce: entry.nonce,
        email: entry.user.email,
        name: entry.user.name,
      }),
    };
  });

  await app.listen({ port: opts.port ?? 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { url, clientId, clientSecret, users: opts.users, authorizations, close: () => app.close() };
}

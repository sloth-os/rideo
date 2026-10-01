import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { AppError } from '../errors';

/**
 * OpenID Connect sign-in (docs/design/accounts.md#sign-in-oidc): the authorization code flow with PKCE and ID-token
 * verification against the issuer's JWKS, with `node:crypto` only.
 */
export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string;
  redirectUri: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

/** A public key of the issuer's JWKS. */
type JsonWebKey = { kid?: string; alg?: string; kty?: string; [k: string]: unknown };
const SKEW_SEC = 60;

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

const fail = (message: string) => new AppError('unauthorized', `sign-in failed: ${message}`);

export class OidcClient {
  private discovery: Promise<Discovery> | null = null;
  private keys: JsonWebKey[] | null = null;

  constructor(
    readonly settings: OidcSettings,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.http(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw fail(`${new URL(url).pathname} answered ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  meta(): Promise<Discovery> {
    this.discovery ??= this.json<Discovery>(
      `${this.settings.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
    ).catch((err) => {
      this.discovery = null;
      throw err;
    });
    return this.discovery;
  }

  async authorizationUrl(opts: {
    state: string;
    nonce: string;
    challenge: string;
    loginHint?: string;
  }): Promise<string> {
    const meta = await this.meta();
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUri,
      scope: this.settings.scopes,
      state: opts.state,
      nonce: opts.nonce,
      code_challenge: opts.challenge,
      code_challenge_method: 'S256',
      ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    }).toString();
    return url.toString();
  }

  /** The code for tokens at the token endpoint; returns the verified ID token's claims. */
  async exchange(code: string, verifier: string, nonce: string): Promise<IdClaims> {
    const meta = await this.meta();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.settings.redirectUri,
      code_verifier: verifier,
      client_id: this.settings.clientId,
    });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (this.settings.clientSecret)
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(this.settings.clientId)}:${encodeURIComponent(this.settings.clientSecret)}`,
      ).toString('base64')}`;
    const tokens = await this.json<{ id_token?: string }>(meta.token_endpoint, {
      method: 'POST',
      headers,
      body: form.toString(),
    });
    if (!tokens.id_token) throw fail('the token endpoint returned no ID token');
    return this.verifyIdToken(tokens.id_token, nonce);
  }

  private async key(kid: string | undefined, alg: string): Promise<JsonWebKey> {
    const find = () => this.keys?.find((k) => (kid ? k.kid === kid : true) && (!k.alg || k.alg === alg));
    let key = find();
    if (!key) {
      // Unknown key: the issuer rotated, read the JWKS again.
      this.keys = (await this.json<{ keys: JsonWebKey[] }>((await this.meta()).jwks_uri)).keys ?? [];
      key = find();
    }
    if (!key) throw fail(`no signing key ${kid ?? ''} in the issuer's JWKS`);
    return key;
  }

  async verifyIdToken(jwt: string, nonce: string, now = Date.now() / 1000): Promise<IdClaims> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw fail('malformed ID token');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as {
      alg?: string;
      kid?: string;
    };
    if (header.alg !== 'RS256' && header.alg !== 'ES256')
      throw fail(`unsupported ID token algorithm ${header.alg}`);
    const jwk = await this.key(header.kid, header.alg);
    const ok = verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      header.alg === 'ES256'
        ? { key: createPublicKey({ key: jwk as never, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }
        : createPublicKey({ key: jwk as never, format: 'jwk' }),
      Buffer.from(parts[2]!, 'base64url'),
    );
    if (!ok) throw fail('the ID token signature does not verify');
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as IdClaims;
    const meta = await this.meta();
    if (claims.iss !== meta.issuer) throw fail(`the ID token is from ${claims.iss}, not ${meta.issuer}`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.settings.clientId)) throw fail('the ID token is for another client');
    if (typeof claims.exp !== 'number' || claims.exp < now - SKEW_SEC) throw fail('the ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat > now + SKEW_SEC)
      throw fail('the ID token is from the future');
    if (claims.nonce !== nonce) throw fail('the ID token answers another sign-in (nonce)');
    if (!claims.sub) throw fail('the ID token names nobody (sub)');
    return claims;
  }
}

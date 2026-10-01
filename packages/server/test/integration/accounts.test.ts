import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type RunningMockIdp, startMockIdp } from '@rideo/mock-gateway';
import type { AuditEvent, AuthMe, ProjectSummary } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, type Stack, startStack } from '../helpers/stack';

/** Accounts, roles and teams (docs/design/accounts.md) against a mock identity provider. */
let idp: RunningMockIdp;
let stack: Stack;

beforeAll(async () => {
  idp = await startMockIdp({
    users: [
      { sub: 'u-mira', email: 'mira@studio.test', name: 'Mira' },
      { sub: 'u-ana', email: 'ana@studio.test', name: 'Ana' },
      { sub: 'u-ben', email: 'ben@studio.test', name: 'Ben' },
      { sub: 'u-cleo', email: 'cleo@studio.test', name: 'Cleo' },
      { sub: 'u-dora', email: 'dora@studio.test', name: 'Dora' },
      { sub: 'u-zoe', email: 'zoe@elsewhere.test', name: 'Zoe' },
    ],
  });
  stack = await startStack({
    env: {
      RIDEO_OIDC_ISSUER: idp.url,
      RIDEO_OIDC_CLIENT_ID: idp.clientId,
      RIDEO_OIDC_CLIENT_SECRET: idp.clientSecret,
      RIDEO_OIDC_NAME: 'Studio SSO',
      RIDEO_ADMINS: 'mira@studio.test',
      RIDEO_OIDC_ALLOWED_DOMAINS: 'studio.test',
      RIDEO_API_TOKEN: 'studio-token',
    },
  });
}, 60_000);
afterAll(async () => {
  await stack?.stop();
  await idp?.close();
});

type Auth = { cookie?: string; token?: string };

/** A REST client as someone. */
const as =
  (auth: Auth) =>
  async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {};
    if (auth.cookie) headers.cookie = auth.cookie;
    if (auth.token) headers.authorization = `Bearer ${auth.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${stack.url}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  };

/** Signs in through the mock provider; returns the session cookie. */
async function signIn(
  email: string,
  returnTo = '/p/x',
): Promise<{ cookie: string | null; location: string }> {
  let res = await fetch(
    `${stack.url}/api/auth/login?login_hint=${encodeURIComponent(email)}&returnTo=${encodeURIComponent(returnTo)}`,
    { redirect: 'manual' },
  );
  expect(res.status).toBe(302);
  res = await fetch(res.headers.get('location')!, { redirect: 'manual' });
  const callback = new URL(res.headers.get('location')!);
  res = await fetch(`${stack.url}${callback.pathname}${callback.search}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const set = res.headers.get('set-cookie');
  return {
    cookie: set && !/Max-Age=0/.test(set) ? set.split(';')[0]! : null,
    location: res.headers.get('location')!,
  };
}

async function signedIn(email: string): Promise<string> {
  const r = await signIn(email);
  expect(r.cookie).toMatch(/^rideo_session=/);
  return r.cookie!;
}

const users: Record<string, string> = {};
let pid: string;

describe('accounts', () => {
  it('signs people in with OIDC (PKCE, nonce) and keeps a session', async () => {
    const r = await signIn('mira@studio.test', '/p/abc?view=clips');
    expect(r.location).toBe('/p/abc?view=clips');
    users.mira = r.cookie!;
    const auth = idp.authorizations.at(-1)!;
    expect(auth).toMatchObject({
      code_challenge_method: 'S256',
      response_type: 'code',
      scope: 'openid profile email',
    });
    expect(auth.nonce!.length).toBeGreaterThan(10);
    const me = await as({ cookie: users.mira })<AuthMe>('GET', '/auth/me');
    expect(me).toMatchObject({
      mode: 'oidc',
      provider: 'Studio SSO',
      admin: true,
      user: { name: 'Mira', studioRole: 'admin' },
    });
    // nobody: 401, but who-am-I answers
    await expect(as({})('GET', '/projects')).rejects.toMatchObject({ status: 401 });
    expect((await as({})<AuthMe>('GET', '/auth/me')).user).toBeNull();
    // only the allowed domains join; an open redirect is refused
    const zoe = await signIn('zoe@elsewhere.test');
    expect(zoe.cookie).toBeNull();
    expect(decodeURIComponent(zoe.location)).toMatch(/^\/login\?error=.*may not join/);
    expect((await signIn('ana@studio.test', 'https://evil.test/')).location).toBe('/');
    // sign out ends the session
    const temp = await signedIn('ana@studio.test');
    await as({ cookie: temp })('POST', '/auth/logout');
    await expect(as({ cookie: temp })('GET', '/projects')).rejects.toMatchObject({ status: 401 });
  });

  it('gives projects members with roles; invitations become memberships at sign-in', async () => {
    users.ana = await signedIn('ana@studio.test');
    users.cleo = await signedIn('cleo@studio.test');
    users.dora = await signedIn('dora@studio.test');
    const ana = as({ cookie: users.ana });
    const project = await ana<any>('POST', '/projects', { kind: 'story', title: 'Ana’s film' });
    pid = project.id;
    expect(project.access.members).toHaveLength(1);
    expect(project.access.members[0].role).toBe('director');
    // Ben never signed in: invited; Cleo reviews
    const access = await ana<any>('PUT', `/projects/${pid}/access`, {
      members: [
        { email: 'ana@studio.test', role: 'director' },
        { email: 'ben@studio.test', role: 'editor' },
        { email: 'cleo@studio.test', role: 'reviewer' },
      ],
    });
    expect(access.members.map((m: any) => [m.name, m.role])).toEqual([
      ['Ana', 'director'],
      ['Cleo', 'reviewer'],
    ]);
    expect(access.invites).toEqual([
      expect.objectContaining({ email: 'ben@studio.test', role: 'editor', invitedBy: 'Ana' }),
    ]);
    users.ben = await signedIn('ben@studio.test');
    const benProjects = await as({ cookie: users.ben })<ProjectSummary[]>('GET', '/projects');
    expect(benProjects.map((p) => [p.id, p.role])).toEqual([[pid, 'editor']]);
    // a director needs to stay
    await expect(
      ana('PUT', `/projects/${pid}/access`, { members: [{ email: 'ben@studio.test', role: 'editor' }] }),
    ).rejects.toMatchObject({
      status: 422,
    });

    // what each role may do
    const ben = as({ cookie: users.ben });
    const cleo = as({ cookie: users.cleo });
    const dora = as({ cookie: users.dora });
    await ben('POST', `/projects/${pid}/characters`, { name: 'Keeper' });
    await expect(cleo('POST', `/projects/${pid}/characters`, { name: 'Ghost' })).rejects.toMatchObject({
      status: 403,
      body: { code: 'forbidden' },
    });
    expect((await cleo<any>('GET', `/projects/${pid}/state`)).docs.project.title).toBe('Ana’s film');
    await expect(ben('PATCH', `/projects/${pid}`, { title: 'Ben’s film' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      ben('POST', `/projects/${pid}/workflow/approve`, { gate: 'brief_ready' }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(dora('GET', `/projects/${pid}/state`)).rejects.toMatchObject({ status: 403 });
    expect(await dora<ProjectSummary[]>('GET', '/projects')).toEqual([]);
    // studio-visible: everyone reviews
    await ana('PUT', `/projects/${pid}/access`, { visibility: 'studio' });
    expect((await dora<ProjectSummary[]>('GET', '/projects')).map((p) => p.role)).toEqual(['reviewer']);
    await ana('PUT', `/projects/${pid}/access`, { visibility: 'private' });
    // admins direct everything
    expect(
      (await as({ cookie: users.mira })<ProjectSummary[]>('GET', '/projects')).find((p) => p.id === pid)
        ?.role,
    ).toBe('director');
    // the studio token too
    expect(
      (await as({ token: 'studio-token' })<ProjectSummary[]>('GET', '/projects')).length,
    ).toBeGreaterThan(0);
  });

  it('lets agents act for their owner within a token’s scope, over REST and MCP', async () => {
    const ben = as({ cookie: users.ben });
    const reviewerToken = await ben<any>('POST', '/tokens', {
      name: 'Reader',
      role: 'reviewer',
      projectIds: [pid],
    });
    expect(reviewerToken.secret).toMatch(/^rdo_[0-9a-z]{16}_/);
    expect(reviewerToken.token).not.toHaveProperty('hash');
    const reader = as({ token: reviewerToken.secret });
    await reader('GET', `/projects/${pid}/state`);
    await expect(reader('POST', `/projects/${pid}/characters`, { name: 'Ghost' })).rejects.toMatchObject({
      status: 403,
    });
    // tokens cannot mint tokens
    await expect(reader('POST', '/tokens', { name: 'x', role: 'reviewer' })).rejects.toMatchObject({
      status: 403,
    });

    const editorToken = await ben<any>('POST', '/tokens', { name: 'Claude Code', role: 'director' });
    const agent = as({ token: editorToken.secret });
    // capped by Ben's role (editor): a director token still cannot approve
    await expect(
      agent('POST', `/projects/${pid}/workflow/approve`, { gate: 'brief_ready' }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await agent('POST', `/projects/${pid}/characters`, { name: 'Mate' });
    const log = await ben<any[]>('GET', `/projects/${pid}/history?limit=1`);
    expect(log[0].author).toMatchObject({
      kind: 'agent',
      name: 'Claude Code',
      onBehalfOf: { kind: 'user', name: 'Ben' },
    });

    // MCP: the same permissions, the session bound to its caller
    const client = new Client({ name: 'Claude Code', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${editorToken.secret}` } },
    });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      return { error: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
    };
    expect((await call('character_create', { projectId: pid, name: 'Lighthouse cat' })).error).toBe(false);
    const denied = await call('workflow_approve', { projectId: pid, gate: 'brief_ready' });
    expect(denied).toMatchObject({ error: true, body: { code: 'forbidden' } });
    const projects = await call('project_list', {});
    expect(projects.body.map((p: ProjectSummary) => p.id)).toEqual([pid]);
    const hijack = await fetch(`${stack.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${reviewerToken.secret}`,
        'mcp-session-id': transport.sessionId!,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(hijack.status).toBe(403);
    await client.close();

    // revoked: no longer valid
    await ben('DELETE', `/tokens/${editorToken.token.id}`);
    await expect(agent('GET', '/projects')).rejects.toMatchObject({ status: 401 });
    expect((await ben<any[]>('GET', '/tokens')).map((t) => [t.name, !!t.revokedAt])).toEqual([
      ['Claude Code', true],
      ['Reader', false],
    ]);
  });

  it('lets admins manage people and read the audit log', async () => {
    const mira = as({ cookie: users.mira });
    const people = await mira<any[]>('GET', '/users');
    expect(people.map((u) => u.name)).toEqual(['Ana', 'Ben', 'Cleo', 'Dora', 'Mira']);
    await expect(as({ cookie: users.ana })('GET', '/users')).rejects.toMatchObject({ status: 403 });
    const dora = people.find((u) => u.name === 'Dora');
    await mira('PATCH', `/users/${dora.id}`, { disabled: true });
    await expect(as({ cookie: users.dora })('GET', '/projects')).rejects.toMatchObject({ status: 401 });
    expect((await signIn('dora@studio.test')).cookie).toBeNull();
    await expect(
      mira('PATCH', `/users/${people.find((u) => u.name === 'Mira')!.id}`, { disabled: true }),
    ).rejects.toMatchObject({
      status: 422,
    });
    // a gate approved by the director is audited
    await as({ cookie: users.ana })('POST', `/projects/${pid}/workflow/approve`, {
      gate: 'brief_ready',
    }).catch(() => undefined);
    const events = await mira<AuditEvent[]>('GET', '/audit?limit=200');
    const types = new Set(events.map((e) => e.type));
    for (const t of [
      'auth.login',
      'auth.logout',
      'auth.failed',
      'auth.denied',
      'token.created',
      'token.revoked',
      'user.updated',
      'project.access',
    ])
      expect(types.has(t as AuditEvent['type'])).toBe(true);
    const denied = events.find(
      (e) => e.type === 'auth.denied' && e.actor.userId === people.find((u) => u.name === 'Cleo')!.id,
    );
    expect(denied).toMatchObject({
      projectId: pid,
      outcome: 'denied',
      detail: { permission: 'project.edit', role: 'reviewer' },
    });
    // directors read their project's events; others nothing
    const ana = as({ cookie: users.ana });
    await expect(ana('GET', '/audit')).rejects.toMatchObject({ status: 403 });
    expect(
      (await ana<AuditEvent[]>('GET', `/audit?projectId=${pid}`)).every((e) => e.projectId === pid),
    ).toBe(true);
    await expect(as({ cookie: users.cleo })('GET', `/audit?projectId=${pid}`)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('keeps live updates of a project to its readers', async () => {
    const listen = (cookie: string) =>
      new Promise<string[]>((resolve) => {
        const ws = new WebSocket(`${stack.url.replace(/^http/, 'ws')}/api/live`, {
          headers: { cookie },
        } as never);
        const seen: string[] = [];
        ws.addEventListener('message', (m) => {
          const msg = JSON.parse(String(m.data));
          seen.push(msg.type === 'error' ? `error:${msg.message}` : msg.type);
          if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'subscribe', projectId: pid }));
        });
        setTimeout(() => {
          ws.close();
          resolve(seen);
        }, 800);
      });
    // the director (a new session) and an admin follow the project
    expect(await listen(await signedIn('ana@studio.test'))).not.toContainEqual(
      expect.stringMatching(/^error:forbidden/),
    );
    expect(await listen(users.mira!)).not.toContainEqual(expect.stringMatching(/^error:forbidden/));
    const ben = as({ cookie: users.ben });
    // Ben loses access: his subscription is refused
    await as({ cookie: users.ana })('PUT', `/projects/${pid}/access`, {
      members: [
        { email: 'ana@studio.test', role: 'director' },
        { email: 'cleo@studio.test', role: 'reviewer' },
      ],
    });
    expect(await listen(users.ben!)).toContainEqual(expect.stringMatching(/^error:forbidden/));
    await expect(ben('GET', `/projects/${pid}/state`)).rejects.toMatchObject({ status: 403 });
  });
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type RunningMockIdp, startMockIdp } from '@rideo/mock-gateway';
import type { ServerMessage, SessionInfo, UiCommand } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from '../helpers/stack';

/**
 * Agents steering open tabs with accounts (docs/design/realtime-sync.md#who-sees-and-steers-which-tabs): a UI command
 * reaches only the tabs on its project, which its caller may use, a session id narrows and never widens, directly or
 * from a recipe; ui_sessions lists only the tabs and projects its caller may see; a tab is present only on a project it
 * may follow. Ana directs A and A2, Dora directs D; neither is a member of the other's projects.
 */
let idp: RunningMockIdp;
let stack: Stack;

beforeAll(async () => {
  idp = await startMockIdp({
    users: [
      { sub: 'u-ana', email: 'ana@studio.test', name: 'Ana' },
      { sub: 'u-dora', email: 'dora@studio.test', name: 'Dora' },
    ],
  });
  stack = await startStack({
    env: {
      RIDEO_OIDC_ISSUER: idp.url,
      RIDEO_OIDC_CLIENT_ID: idp.clientId,
      RIDEO_OIDC_CLIENT_SECRET: idp.clientSecret,
      RIDEO_OIDC_NAME: 'Studio SSO',
      RIDEO_OIDC_ALLOWED_DOMAINS: 'studio.test',
      RIDEO_API_TOKEN: 'studio-token',
    },
  });
}, 60_000);

const clients: Client[] = [];
const tabs: Tab[] = [];
afterAll(async () => {
  for (const t of tabs) t.close();
  for (const c of clients) await c.close().catch(() => undefined);
  await stack?.stop();
  await idp?.close();
});

async function signedIn(email: string): Promise<string> {
  let res = await fetch(`${stack.url}/api/auth/login?login_hint=${encodeURIComponent(email)}&returnTo=%2F`, {
    redirect: 'manual',
  });
  res = await fetch(res.headers.get('location')!, { redirect: 'manual' });
  const callback = new URL(res.headers.get('location')!);
  res = await fetch(`${stack.url}${callback.pathname}${callback.search}`, { redirect: 'manual' });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toMatch(/^rideo_session=/);
  return cookie!;
}

/** A REST call as someone (a session cookie). */
async function rest<T = any>(cookie: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${stack.url}/api${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** An MCP client as someone: a session cookie or an agent token. */
async function agent(name: string, auth: { cookie: string } | { token: string }) {
  const client = new Client({ name, version: '1.0.0' });
  clients.push(client);
  const headers: Record<string, string> =
    'cookie' in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.token}` };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`), { requestInit: { headers } }),
  );
  return async <T = any>(tool: string, args: Record<string, unknown>): Promise<T> => {
    const r = await client.callTool({ name: tool, arguments: args });
    const body = JSON.parse((r.content as { text: string }[])[0]!.text);
    if (r.isError) throw Object.assign(new Error(`${tool}: ${body.code}`), { body });
    return body as T;
  };
}

interface Tab {
  id: string;
  got: ServerMessage[];
  send(msg: object): void;
  /** The UI commands this tab received (it acknowledges each, as the web app does). */
  commands(): UiCommand[];
  errors(): string[];
  close(): void;
}

/** A browser tab's live socket, signed in as someone. */
async function openTab(cookie: string): Promise<Tab> {
  const ws = new WebSocket(`${stack.url.replace(/^http/, 'ws')}/api/live`, { headers: { cookie } } as never);
  const got: ServerMessage[] = [];
  const id = await new Promise<string>((resolve, reject) => {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as ServerMessage;
      got.push(msg);
      if (msg.type === 'hello') resolve(msg.sessionId);
      if (msg.type === 'ui') ws.send(JSON.stringify({ type: 'ui-ack', commandId: msg.command.id, ok: true }));
    });
    ws.addEventListener('error', () => reject(new Error('the live socket failed')));
  });
  const tab: Tab = {
    id,
    got,
    send: (msg) => ws.send(JSON.stringify(msg)),
    commands: () => got.flatMap((m) => (m.type === 'ui' ? [m.command] : [])),
    errors: () => got.flatMap((m) => (m.type === 'error' ? [m.message] : [])),
    close: () => ws.close(),
  };
  tabs.push(tab);
  return tab;
}

/** What a tab on a project sends: it follows the project and is present on one of its views. */
function show(tab: Tab, projectId: string, view = 'story') {
  tab.send({ type: 'subscribe', projectId });
  tab.send({ type: 'presence', projectId, route: `/p/${projectId}/${view}`, selection: null });
}

const settle = () => new Promise((r) => setTimeout(r, 300));

/** Asks again until the answer passes (outside a test, where expect.poll is not available). */
async function until<T>(ask: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await ask();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

let ana: string;
let dora: string;
let A: string;
let A2: string;
let D: string;
let anaTab: Tab;
let doraTab: Tab;
let doraHome: Tab;
let doraOnD: Tab;
let asAna: Awaited<ReturnType<typeof agent>>;
let asDora: Awaited<ReturnType<typeof agent>>;

describe('live UI sessions with accounts', () => {
  beforeAll(async () => {
    ana = await signedIn('ana@studio.test');
    dora = await signedIn('dora@studio.test');
    A = (await rest(ana, 'POST', '/projects', { kind: 'story', title: 'Ana film' })).id;
    A2 = (await rest(ana, 'POST', '/projects', { kind: 'story', title: 'Ana second film' })).id;
    D = (await rest(dora, 'POST', '/projects', { kind: 'story', title: 'Dora film' })).id;
    asAna = await agent('Ana agent', { cookie: ana });
    asDora = await agent('Dora agent', { cookie: dora });
    // Ana's tab on A; a tab of Dora's claiming A; one of hers on no project; one on D
    anaTab = await openTab(ana);
    show(anaTab, A, 'cast');
    doraTab = await openTab(dora);
    show(doraTab, A);
    doraHome = await openTab(dora);
    doraHome.send({ type: 'presence', projectId: null, route: '/', selection: null });
    doraOnD = await openTab(dora);
    show(doraOnD, D);
    const on = async (as: typeof asAna, projectId: string) =>
      (await as<SessionInfo[]>('ui_sessions', { projectId }))
        .filter((s) => s.presence?.projectId === projectId)
        .map((s) => s.sessionId);
    await until(
      () => on(asAna, A),
      (ids) => ids.includes(anaTab.id),
    );
    await until(
      () => on(asDora, D),
      (ids) => ids.includes(doraOnD.id),
    );
    await settle();
  }, 60_000);

  it('keeps a tab present only on a project its person may follow, and its commands to the tabs on it', async () => {
    // Dora's tab claimed Ana's project: the follow and the presence are both refused
    expect(doraTab.errors()).toEqual([
      `forbidden: you may not follow ${A}`,
      `forbidden: you may not follow ${A}`,
    ]);
    expect((await asAna<SessionInfo[]>('ui_sessions', { projectId: A })).map((s) => s.sessionId)).toEqual([
      anaTab.id,
    ]);
    // Ana's agent tells her project: only her tab hears it
    const told = await asAna('ui_notify', { projectId: A, message: 'Ana project secret' });
    expect(told.delivered).toEqual([anaTab.id]);
    expect(told.acked).toEqual([{ sessionId: anaTab.id, ok: true }]);
    await settle();
    expect(doraTab.commands()).toEqual([]);
    expect(anaTab.commands().map((c) => c.params.message)).toEqual(['Ana project secret']);
  });

  it('lists to each caller only its own tabs and those on projects it may read, with those projects alone', async () => {
    // Dora sees her own tabs; none of Ana's
    const mine = await asDora<SessionInfo[]>('ui_sessions', {});
    expect(mine.map((s) => s.sessionId).sort()).toEqual([doraTab.id, doraHome.id, doraOnD.id].sort());
    expect(mine.find((s) => s.sessionId === doraTab.id)).toMatchObject({ projectIds: [], presence: null });
    expect(mine.find((s) => s.sessionId === doraHome.id)?.presence).toMatchObject({
      projectId: null,
      route: '/',
    });
    expect((await asAna<SessionInfo[]>('ui_sessions', {})).map((s) => s.sessionId)).toEqual([anaTab.id]);
    await expect(asDora('ui_sessions', { projectId: A })).rejects.toMatchObject({
      body: { code: 'forbidden' },
    });

    // Ana's tab follows A2 too and is present there; A becomes readable by the studio
    show(anaTab, A2, 'clips');
    await rest(ana, 'PUT', `/projects/${A}/access`, { visibility: 'studio' });
    await expect
      .poll(async () => (await asAna<SessionInfo[]>('ui_sessions', {}))[0]?.presence?.projectId)
      .toBe(A2);
    expect((await asAna<SessionInfo[]>('ui_sessions', {}))[0]!.projectIds.sort()).toEqual([A, A2].sort());
    // Dora reads A, not A2: Ana's tab with A alone, and not where it is (on A2)
    const seen = await asDora<SessionInfo[]>('ui_sessions', {});
    expect(seen.find((s) => s.sessionId === anaTab.id)).toMatchObject({ projectIds: [A], presence: null });
    const onA = await asDora<SessionInfo[]>('ui_sessions', { projectId: A });
    expect(onA).toEqual([expect.objectContaining({ sessionId: anaTab.id, projectIds: [A], presence: null })]);
    // back on A: its presence shows on A
    anaTab.send({ type: 'presence', projectId: A, route: `/p/${A}/cast`, selection: null });
    await expect
      .poll(async () => (await asDora<SessionInfo[]>('ui_sessions', { projectId: A }))[0]?.presence?.route)
      .toBe(`/p/${A}/cast`);
    await rest(ana, 'PUT', `/projects/${A}/access`, { visibility: 'private' });
    expect((await asDora<SessionInfo[]>('ui_sessions', {})).map((s) => s.sessionId)).not.toContain(anaTab.id);
  });

  it('never lets a session id take a command to a tab on another project, directly or from a recipe', async () => {
    const heardByAna = anaTab.commands().length;
    // Dora's agent names Ana's tab: with her project, without a project, to navigate
    for (const args of [
      { projectId: D, sessionId: anaTab.id, message: 'Spoofed by Dora' },
      { sessionId: anaTab.id, message: 'Spoofed without a project' },
    ])
      expect(await asDora('ui_notify', args)).toMatchObject({ delivered: [], acked: [] });
    expect(await asDora('ui_navigate', { projectId: D, view: 'cast', sessionId: anaTab.id })).toMatchObject({
      delivered: [],
    });
    // her own tab on D, by its id
    expect(
      await asDora('ui_notify', { projectId: D, sessionId: doraOnD.id, message: 'Yours' }),
    ).toMatchObject({
      delivered: [doraOnD.id],
    });
    // without a project: her own tabs only, also through an agent token of hers
    const mine = [doraTab.id, doraHome.id, doraOnD.id].sort();
    expect((await asDora('ui_notify', { message: 'To my tabs' })).delivered.sort()).toEqual(mine);
    const token = await rest(dora, 'POST', '/tokens', { name: 'Dora token agent', role: 'director' });
    const asToken = await agent('Dora token agent', { token: token.secret });
    expect((await asToken('ui_notify', { message: 'From the token' })).delivered.sort()).toEqual(mine);
    expect((await asToken<SessionInfo[]>('ui_sessions', {})).map((s) => s.sessionId).sort()).toEqual(mine);

    // a recipe Dora runs on D, given Ana's tab, and then her own
    const recipe = await rest(dora, 'POST', '/recipes', {
      name: 'Tell a tab',
      params: [{ name: 'session', type: 'string', required: true }],
      steps: [
        {
          tool: 'ui_notify',
          args: { projectId: '{{projectId}}', sessionId: '{{session}}', message: 'From a recipe' },
        },
      ],
    });
    for (const session of [anaTab.id, doraOnD.id]) {
      const job = await rest(dora, 'POST', `/projects/${D}/recipes/${recipe.id}/run`, {
        params: { session },
      });
      const done = await asDora('job_wait', { projectId: D, jobId: job.id, timeoutSec: 30 });
      expect(done.status).toBe('succeeded');
    }
    await settle();
    expect(anaTab.commands().slice(heardByAna)).toEqual([]);
    expect(doraOnD.commands().map((c) => c.params.message)).toEqual([
      'Yours',
      'To my tabs',
      'From the token',
      'From a recipe',
    ]);
  });
});

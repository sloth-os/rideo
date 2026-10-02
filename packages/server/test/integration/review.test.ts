import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type RunningMockIdp, startMockIdp } from '@rideo/mock-gateway';
import type { Clip, CommentThread, Job, Notification, Review } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Review and approvals (docs/design/review.md): members, guests of share links, gates, notifications, MCP. */
let idp: RunningMockIdp;
let stack: Stack;

beforeAll(async () => {
  idp = await startMockIdp({
    users: [
      { sub: 'u-mira', email: 'mira@studio.test', name: 'Mira Okafor' },
      { sub: 'u-ben', email: 'ben@studio.test', name: 'Ben' },
      { sub: 'u-cleo', email: 'cleo@studio.test', name: 'Cleo' },
      { sub: 'u-dora', email: 'dora@studio.test', name: 'Dora' },
    ],
  });
  stack = await startStack({
    env: {
      RIDEO_OIDC_ISSUER: idp.url,
      RIDEO_OIDC_CLIENT_ID: idp.clientId,
      RIDEO_OIDC_CLIENT_SECRET: idp.clientSecret,
      RIDEO_OIDC_ALLOWED_DOMAINS: 'studio.test',
      RIDEO_API_TOKEN: 'studio-token',
    },
  });
}, 60_000);
afterAll(async () => {
  await stack?.stop();
  await idp?.close();
});

type Call = <T = any>(method: string, path: string, body?: unknown) => Promise<T>;

const client =
  (headers: Record<string, string>): Call =>
  async (method, path, body) => {
    const res = await fetch(`${stack.url}/api${path}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  };
/** Nobody signed in: a guest of a share link. */
const guest = client({});

async function signIn(email: string): Promise<Call> {
  let res = await fetch(`${stack.url}/api/auth/login?login_hint=${encodeURIComponent(email)}`, {
    redirect: 'manual',
  });
  res = await fetch(res.headers.get('location')!, { redirect: 'manual' });
  const callback = new URL(res.headers.get('location')!);
  res = await fetch(`${stack.url}${callback.pathname}${callback.search}`, { redirect: 'manual' });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return client({ cookie });
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: ApiError) => `${err.status} ${err.body?.code}`,
  );

let pid: string;
let pilot: Clip;
let mira: Call;
let ben: Call;
let cleo: Call;
let dora: Call;
let users: Record<string, string>;
const takeTarget = () => {
  const shot = [...pilot.shots].sort((a, b) => a.index - b.index)[0]!;
  return { kind: 'take' as const, clipId: pilot.id, shotId: shot.id, takeId: shot.selectedTakeId! };
};
const notes = async (who: Call) =>
  who<{ notifications: Notification[]; unread: number }>('GET', '/notifications');

describe('review and approvals', () => {
  beforeAll(async () => {
    const signedIn = await Promise.all(
      ['mira', 'ben', 'cleo', 'dora'].map((n) => signIn(`${n}@studio.test`)),
    );
    [mira, ben, cleo, dora] = signedIn as [Call, Call, Call, Call];
    const ready = await readyStoryProject(stack, { storyboard: { enabled: false } });
    pid = ready.projectId;
    await stack.api('PUT', `/projects/${pid}/access`, {
      members: [
        { email: 'mira@studio.test', role: 'director' },
        { email: 'ben@studio.test', role: 'editor' },
        { email: 'cleo@studio.test', role: 'reviewer' },
      ],
    });
    for (const gate of ['screenplay_approved', 'cast_locked', 'resources_ready', 'storyboard_approved'])
      await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate });
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: ready.state.docs.screenplay.scenes[0].id,
      generate: true,
    });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    await stack.waitIdle(pid);
    const state = await stack.api<any>('GET', `/projects/${pid}/state`);
    pilot = Object.values<Clip>(state.docs.clips).sort((a, b) => a.index - b.index)[0]!;
    const access = await stack.api<any>('GET', `/projects/${pid}/access`);
    users = Object.fromEntries(access.members.map((m: any) => [m.email.split('@')[0], m.userId]));
  }, 240_000);

  it('comments with drawings, mentions, replies and resolving follow the roles', async () => {
    const target = takeTarget();
    const thread = await cleo<CommentThread>('POST', `/projects/${pid}/comments`, {
      target,
      at: 0.5,
      annotation: { shapes: [{ kind: 'box', from: [0.1, 0.1], to: [0.4, 0.5], color: '#FF6B3D' }] },
      body: '@Ben the lamp flickers here; @Mira Okafor fine with the framing?',
    });
    expect(thread).toMatchObject({
      target,
      at: 0.5,
      author: { kind: 'user', id: users.cleo, name: 'Cleo' },
      mentions: [users.mira, users.ben],
      status: 'open',
      reviewId: null,
    });
    // Invalid input, unknown targets and people outside the project are refused
    expect(await code(cleo('POST', `/projects/${pid}/comments`, { target, body: '' }))).toBe(
      '422 validation_error',
    );
    expect(
      await code(
        cleo('POST', `/projects/${pid}/comments`, {
          target: { ...target, takeId: 'tak_000000000000' },
          body: 'x',
        }),
      ),
    ).toBe('404 not_found');
    expect(await code(dora('POST', `/projects/${pid}/comments`, { target, body: 'hi' }))).toBe(
      '403 forbidden',
    );

    // Mentions notify; nobody hears of their own comment
    const benNotes = await notes(ben);
    expect(benNotes.unread).toBe(1);
    expect(benNotes.notifications[0]).toMatchObject({
      kind: 'mention',
      projectId: pid,
      title: 'Cleo mentioned you',
      link: `/p/${pid}/clips?take=${target.takeId}&comment=${thread.id}`,
    });
    expect((await notes(mira)).notifications.map((n) => n.kind)).toEqual(['mention']);
    expect((await notes(cleo)).notifications).toEqual([]);

    // A reply reaches the thread; a mention in it replaces the reply notification for that person
    const replied = await ben<CommentThread>('POST', `/projects/${pid}/comments/${thread.id}/replies`, {
      body: 'Regenerating it now @Cleo',
    });
    expect(replied.replies).toMatchObject([
      { author: { name: 'Ben' }, body: 'Regenerating it now @Cleo', mentions: [users.cleo] },
    ]);
    expect((await notes(cleo)).notifications.map((n) => n.kind)).toEqual(['mention']);

    // Reviewers resolve their own threads; editors resolve any
    const bens = await ben<CommentThread>('POST', `/projects/${pid}/comments`, {
      target,
      body: 'Note to self: trim the tail',
    });
    expect(await code(cleo('PATCH', `/projects/${pid}/comments/${bens.id}`, { status: 'resolved' }))).toBe(
      '403 forbidden',
    );
    const resolved = await cleo<CommentThread>('PATCH', `/projects/${pid}/comments/${thread.id}`, {
      status: 'resolved',
    });
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: { name: 'Cleo' } });
    expect(
      (await ben<CommentThread>('PATCH', `/projects/${pid}/comments/${bens.id}`, { status: 'resolved' }))
        .status,
    ).toBe('resolved');

    // Lists filter by status and target; the history names who commented
    const open = await cleo<CommentThread[]>('GET', `/projects/${pid}/comments?status=open`);
    expect(open).toEqual([]);
    const onTake = await cleo<CommentThread[]>(
      'GET',
      `/projects/${pid}/comments?target=take:${target.clipId}:${target.shotId}:${target.takeId}`,
    );
    expect(onTake.map((c) => c.id)).toEqual([thread.id, bens.id]);
    const log = await ben<any[]>('GET', `/projects/${pid}/history?path=comments/${thread.id}.json`);
    expect(log.map((c) => c.author.name)).toEqual(['Cleo', 'Ben', 'Cleo']);

    // Notifications are marked read
    expect((await ben<{ unread: number }>('POST', '/notifications/read', {})).unread).toBe(0);
  });

  it('a share link shows only the review; guests comment and decide, and the review approves the pilot gate', async () => {
    // Only directors ask for reviews
    expect(
      await code(
        ben('POST', `/projects/${pid}/reviews`, { title: 'x', target: { kind: 'clip', clipId: pilot.id } }),
      ),
    ).toBe('403 forbidden');
    expect(
      await code(
        mira('POST', `/projects/${pid}/reviews`, {
          title: 'x',
          target: { kind: 'clip', clipId: pilot.id },
          gate: 'no_such_gate',
        }),
      ),
    ).toBe('422 validation_error');
    const created = await mira<{ review: Review; url: string }>('POST', `/projects/${pid}/reviews`, {
      title: 'Pilot for the client',
      target: { kind: 'clip', clipId: pilot.id },
      gate: 'pilot_approved',
      link: { expiresInDays: 7 },
    });
    expect(created.review).toMatchObject({
      title: 'Pilot for the client',
      gate: 'pilot_approved',
      required: 1,
      status: 'open',
      createdBy: { kind: 'user', id: users.mira },
    });
    expect(created.review.link!.hash).toMatch(/^[0-9a-f]{64}$/);
    const token = new URL(created.url).pathname.replace('/review/', '');
    expect(created.url).toMatch(/\/review\/prj_[0-9a-z]+\.rev_[0-9a-z]+\.[\w-]{20,}$/);
    expect(JSON.stringify(created.review)).not.toContain(token.split('.')[2]);

    // The guest view: the clip's selected takes and their comments, nothing else of the project
    const view = await guest<any>('GET', `/review/${token}`);
    expect(Object.keys(view).sort()).toEqual(['comments', 'items', 'project', 'projectId', 'review']);
    expect(view.review.link).toBeUndefined();
    expect(view.items.length).toBe(pilot.shots.length);
    expect(view.items[0].target).toEqual(takeTarget());
    expect(view.comments.length).toBe(2);
    const media = await fetch(`${stack.url}/api/review/${token}/media/${view.items[0].media.path}`, {
      headers: { range: 'bytes=0-99' },
    });
    expect(media.status).toBe(206);
    expect((await media.arrayBuffer()).byteLength).toBe(100);
    // Media that is not part of the review, the project's own routes, and wrong or malformed tokens: nothing
    const state = await stack.api<any>('GET', `/projects/${pid}/state`);
    const refPath = Object.values<any>(state.docs.characters)[0].references[0].media.path;
    expect((await fetch(`${stack.url}/api/review/${token}/media/${refPath}`)).status).toBe(404);
    expect((await fetch(`${stack.url}/api/projects/${pid}/state`)).status).toBe(401);
    expect(await code(guest('GET', `/review/${token.slice(0, -2)}xx`))).toBe('404 not_found');
    expect(await code(guest('GET', '/review/not-a-token'))).toBe('404 not_found');

    // Guests comment on what the review shows, under their name; the director hears of it
    const before = (await notes(mira)).notifications.length;
    const gc = await guest<CommentThread>('POST', `/review/${token}/comments`, {
      name: 'Ana from Northwind',
      target: view.items[0].target,
      at: 1.25,
      annotation: { shapes: [{ kind: 'arrow', from: [0.2, 0.8], to: [0.5, 0.5], color: '#FF6B3D' }] },
      body: 'Can the logo be bigger here?',
    });
    expect(gc).toMatchObject({
      author: { kind: 'guest', name: 'Ana from Northwind', id: `${created.review.id}:ana-from-northwind` },
      reviewId: created.review.id,
    });
    expect(
      await code(
        guest('POST', `/review/${token}/comments`, {
          name: 'Ana',
          target: { kind: 'export', exportId: 'exp_000000000000' },
          body: 'x',
        }),
      ),
    ).toBe('403 forbidden');
    expect(
      await code(guest('POST', `/review/${token}/comments`, { target: view.items[0].target, body: 'x' })),
    ).toBe('422 validation_error');
    const reply = await guest<CommentThread>('POST', `/review/${token}/comments/${gc.id}/replies`, {
      name: 'Ana from Northwind',
      body: 'Also at the end card',
    });
    expect(reply.replies[0]!.author.kind).toBe('guest');
    const afterComment = (await notes(mira)).notifications;
    expect(afterComment.length).toBe(before + 1);
    expect(afterComment[0]).toMatchObject({
      kind: 'comment',
      title: 'Ana from Northwind commented on “Pilot for the client”',
    });

    // Changes requested; then approved — but the pilot clip is not approved yet, so the gate stays as it is
    expect(
      (
        await guest<any>('POST', `/review/${token}/decisions`, {
          name: 'Ana from Northwind',
          decision: 'changes',
          note: 'Logo',
        })
      ).status,
    ).toBe('changes_requested');
    const approvedEarly = await guest<any>('POST', `/review/${token}/decisions`, {
      name: 'Ana from Northwind',
      decision: 'approve',
    });
    expect(approvedEarly).toMatchObject({ status: 'approved', gateApprovedAt: null });
    expect(approvedEarly.link).toBeUndefined();
    const miraNotes = (await notes(mira)).notifications;
    expect(miraNotes[0]).toMatchObject({
      kind: 'gate',
      title: '“Pilot for the client” is approved, but pilot_approved cannot be yet',
    });
    expect(miraNotes[0]!.body).toContain('Approve the pilot clip');
    expect(miraNotes.filter((n) => n.kind === 'decision').length).toBe(2);
    expect(
      (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.project.workflow.approvals.pilot_approved,
    ).toBeUndefined();

    // The director approves the clip; the next approval approves the gate in the director's name
    await mira('POST', `/projects/${pid}/clips/${pilot.id}/approve`);
    const decided = await cleo<Review>('POST', `/projects/${pid}/reviews/${created.review.id}/decisions`, {
      decision: 'approve',
      note: 'Good to go',
    });
    expect(decided.gateApprovedAt).toEqual(expect.any(String));
    const project = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.project;
    expect(project.workflow.stage).toBe('production');
    expect(project.workflow.approvals.pilot_approved.actor).toMatchObject({
      kind: 'user',
      id: users.mira,
      name: 'Mira Okafor via review “Pilot for the client”',
    });
    expect((await notes(mira)).notifications[0]).toMatchObject({
      kind: 'gate',
      title: 'pilot_approved approved through “Pilot for the client”',
    });
    const audit = await stack.api<any[]>('GET', `/audit?projectId=${pid}&type=project.approval`);
    expect(audit.some((e) => e.detail.via === 'review' && e.detail.gate === 'pilot_approved')).toBe(true);

    // Revoked: the link opens nothing
    expect(await code(cleo('DELETE', `/projects/${pid}/reviews/${created.review.id}/link`))).toBe(
      '403 forbidden',
    );
    const revoked = await mira<Review>('DELETE', `/projects/${pid}/reviews/${created.review.id}/link`);
    expect(revoked.link!.revokedAt).toEqual(expect.any(String));
    expect(await code(guest('GET', `/review/${token}`))).toBe('404 not_found');
    expect((await fetch(`${stack.url}/api/review/${token}/media/${view.items[0].media.path}`)).status).toBe(
      404,
    );

    // Metrics count comments, decisions and link opens
    const metrics = await (
      await fetch(`${stack.url}/metrics`, { headers: { authorization: 'Bearer studio-token' } })
    ).text();
    expect(metrics).toMatch(/rideo_review_total\{event="link_open"\} [1-9]/);
    expect(metrics).toMatch(/rideo_review_total\{event="approve"\} [1-9]/);
  });

  it('agents address review notes over MCP with the same permissions', async () => {
    const editorToken = await ben<any>('POST', '/tokens', { name: 'Claude Code', role: 'editor' });
    const mcp = new Client({ name: 'Claude Code', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${editorToken.secret}` } },
    });
    await mcp.connect(transport);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await mcp.callTool({ name, arguments: args });
        return { error: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
      };
      const note = await cleo<CommentThread>('POST', `/projects/${pid}/comments`, {
        target: takeTarget(),
        at: 2,
        body: 'Warmer light, please',
      });
      const open = await call('comments_list', { projectId: pid, status: 'open' });
      expect(open.body.map((c: CommentThread) => c.id)).toContain(note.id);
      const replied = await call('comment_reply', {
        projectId: pid,
        commentId: note.id,
        body: 'Relit in take 3',
      });
      expect(replied.body.replies.at(-1).author).toMatchObject({
        kind: 'agent',
        name: 'Claude Code (for Ben)',
      });
      expect((await call('comment_resolve', { projectId: pid, commentId: note.id })).body.status).toBe(
        'resolved',
      );
      const reviews = await call('reviews_list', { projectId: pid });
      expect(reviews.body[0]).toMatchObject({ title: 'Pilot for the client', hasLink: true });
      expect(reviews.body[0].link).toBeUndefined();
      const denied = await call('review_create', {
        projectId: pid,
        title: 'x',
        target: { kind: 'clip', clipId: pilot.id },
      });
      expect(denied).toMatchObject({ error: true, body: { code: 'forbidden' } });
      // The thread's author hears of the agent's reply
      expect((await notes(cleo)).notifications[0]).toMatchObject({
        kind: 'reply',
        title: 'Claude Code (for Ben) replied',
      });
      const own = await call('notifications_list', {});
      expect(own.body).toHaveProperty('unread');
    } finally {
      await mcp.close();
    }
  });
});

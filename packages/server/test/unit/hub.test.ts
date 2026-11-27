import type { ServerMessage } from '@rideo/shared';
import { describe, expect, it } from 'vitest';
import { LiveHub, type LiveSocket, type UiReach } from '../../src/live/hub';

class FakeSocket implements LiveSocket {
  readyState = 1;
  sent: ServerMessage[] = [];
  private handlers: Record<string, ((arg?: any) => void)[]> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    for (const h of this.handlers.close ?? []) h();
  }
  on(event: string, fn: (arg?: any) => void) {
    this.handlers[event] = [...(this.handlers[event] ?? []), fn];
  }
  receive(msg: object) {
    for (const h of this.handlers.message ?? []) h(Buffer.from(JSON.stringify(msg)));
  }
}

const actor = { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code' };

describe('live hub', () => {
  it('fans out project events with increasing sequence numbers', () => {
    const hub = new LiveHub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.attach(a);
    hub.attach(b);
    a.receive({ type: 'subscribe', projectId: 'p1' });
    b.receive({ type: 'subscribe', projectId: 'p2' });
    hub.activity('p1', actor, 'lock', 'Locked Mira');
    hub.activity('p1', actor, 'lock', 'Locked Jonah');
    const events = a.sent.filter((m) => m.type === 'event');
    expect(events.map((m) => (m as { seq: number }).seq)).toEqual([1, 2]);
    expect(b.sent.filter((m) => m.type === 'event')).toHaveLength(0);
    expect(a.sent[0]).toMatchObject({ type: 'hello', instanceId: hub.instanceId });
    hub.close();
  });

  it('replays missed events and asks for resync when too far behind', () => {
    const hub = new LiveHub();
    for (let i = 0; i < 5; i++) hub.activity('p1', actor, 'x', `event ${i}`);
    const s = new FakeSocket();
    hub.attach(s);
    s.receive({ type: 'subscribe', projectId: 'p1', lastSeq: 3 });
    expect(s.sent.filter((m) => m.type === 'event').map((m) => (m as { seq: number }).seq)).toEqual([4, 5]);
    for (let i = 0; i < 1100; i++) hub.activity('p2', actor, 'x', 'y');
    const late = new FakeSocket();
    hub.attach(late);
    late.receive({ type: 'subscribe', projectId: 'p2', lastSeq: 2 });
    expect(late.sent.slice(-2)).toMatchObject([
      { type: 'resync', projectId: 'p2' },
      { type: 'subscribed', projectId: 'p2' },
    ]);
    hub.close();
  });

  // docs/design/realtime-sync.md#server--client, docs/design/editor.md#editor-jobs
  it('answers a subscribe once it follows the project, after the events it replays, with its ref', async () => {
    const hub = new LiveHub();
    for (let i = 0; i < 3; i++) hub.activity('p1', actor, 'x', `event ${i}`);
    const gates = new Map<string, () => void>();
    const authorize = (projectId: string) =>
      new Promise<boolean>((resolve) => gates.set(projectId, () => resolve(projectId !== 'p-closed')));
    const tab = new FakeSocket();
    const id = hub.attach(tab, undefined, { userId: 'u1', authorize });
    // what a claim would find when the answer is sent: the answer never comes before the session follows the project
    const followedAtAnswer: boolean[] = [];
    const send = tab.send.bind(tab);
    tab.send = (data: string) => {
      if (JSON.parse(data).type === 'subscribed') followedAtAnswer.push(hub.isSubscribed(id, 'p1'));
      send(data);
    };
    const tick = () => new Promise((r) => setTimeout(r, 5));
    tab.receive({ type: 'subscribe', projectId: 'p1', lastSeq: 1, ref: 7 });
    await tick();
    // still asking whether the tab may follow: no answer, and a claim would be refused
    expect(tab.sent.filter((m) => m.type === 'subscribed')).toEqual([]);
    expect(hub.isSubscribed(id, 'p1')).toBe(false);
    gates.get('p1')!();
    await tick();
    expect(tab.sent.slice(1).map((m) => (m.type === 'event' ? m.seq : m))).toEqual([
      2,
      3,
      { type: 'subscribed', projectId: 'p1', ref: 7 },
    ]);
    expect(followedAtAnswer).toEqual([true]);
    // a refused subscribe gets the error, not the answer
    tab.receive({ type: 'subscribe', projectId: 'p-closed', ref: 8 });
    await tick();
    gates.get('p-closed')!();
    await tick();
    expect(tab.sent.at(-1)).toEqual({ type: 'error', message: 'forbidden: you may not follow p-closed' });
    expect(tab.sent.filter((m) => m.type === 'subscribed')).toHaveLength(1);
    // a subscribe without a ref gets an answer without one
    const plain = new FakeSocket();
    hub.attach(plain);
    plain.receive({ type: 'subscribe', projectId: 'p1' });
    expect(plain.sent.at(-1)).toEqual({ type: 'subscribed', projectId: 'p1' });
    hub.close();
  });

  it('tracks presence and relays UI commands with acknowledgements', async () => {
    const hub = new LiveHub();
    const s = new FakeSocket();
    const id = hub.attach(s);
    s.receive({
      type: 'presence',
      projectId: 'p1',
      route: '/p/p1/cast',
      viewport: { width: 412, height: 915 },
    });
    expect(hub.sessionsFor('p1')[0]).toMatchObject({ sessionId: id, presence: { route: '/p/p1/cast' } });
    const pending = hub.sendUi(
      { issuedBy: actor, projectId: 'p1', action: 'navigate', params: { view: 'clips' } },
      { timeoutMs: 1000 },
    );
    await new Promise((r) => setTimeout(r, 5));
    const ui = s.sent.find((m) => m.type === 'ui') as Extract<ServerMessage, { type: 'ui' }>;
    expect(ui.command.params.view).toBe('clips');
    s.receive({ type: 'ui-ack', commandId: ui.command.id, ok: true });
    const res = await pending;
    expect(res.acked).toEqual([{ sessionId: id, ok: true }]);
    const none = await hub.sendUi(
      { issuedBy: actor, projectId: 'nobody', action: 'notify', params: { message: 'hi' } },
      { timeoutMs: 50 },
    );
    expect(none.delivered).toEqual([]);
    s.receive({ type: 'ping' });
    expect(s.sent.at(-1)).toEqual({ type: 'pong' });
    s.close();
    expect(hub.sessionsFor()).toHaveLength(0);
    hub.close();
  });

  // docs/design/realtime-sync.md#who-sees-and-steers-which-tabs
  it('keeps a tab present only on a project it may follow, deciding claims in the order they come', async () => {
    const hub = new LiveHub();
    const asked: string[] = [];
    const gates = new Map<string, () => void>();
    const authorize = async (projectId: string) => {
      asked.push(projectId);
      if (projectId === 'p-slow') await new Promise<void>((r) => gates.set(projectId, r));
      return projectId !== 'p-closed';
    };
    const tab = new FakeSocket();
    const id = hub.attach(tab, undefined, { userId: 'u1', authorize });
    const presence = (projectId: string | null) =>
      tab.receive({ type: 'presence', projectId, route: projectId ? `/p/${projectId}/story` : '/' });
    const where = () => hub.sessionsFor().find((s) => s.sessionId === id)?.presence?.projectId;
    const tick = () => new Promise((r) => setTimeout(r, 5));

    // a slow answer for an older claim never replaces the newer one
    presence('p-slow');
    presence('p-open');
    await tick();
    expect(where()).toBe('p-open');
    gates.get('p-slow')!();
    await tick();
    expect(where()).toBe('p-open');
    // refused like a follow: present nowhere, and the project's commands do not reach it
    presence('p-closed');
    await tick();
    expect(tab.sent.at(-1)).toEqual({ type: 'error', message: 'forbidden: you may not follow p-closed' });
    expect(where()).toBeUndefined();
    expect(hub.isSubscribed(id, 'p-closed')).toBe(false);
    const sent = await hub.sendUi(
      { issuedBy: actor, projectId: 'p-closed', action: 'notify', params: { message: 'secret' } },
      { timeoutMs: 20 },
    );
    expect(sent.delivered).toEqual([]);
    // no project, or one it follows: nothing to ask
    presence(null);
    expect(hub.sessionsFor()[0]?.presence).toMatchObject({ projectId: null, route: '/' });
    tab.receive({ type: 'subscribe', projectId: 'p-followed' });
    await tick();
    const before = asked.length;
    presence('p-followed');
    expect(where()).toBe('p-followed');
    expect(asked.length).toBe(before);
    hub.close();
  });

  it('sends a UI command to the tabs on its project, a session id only narrowing; without accounts as before', async () => {
    const hub = new LiveHub();
    const tabs = ['u1', 'u1', 'u2'].map((userId) => {
      const socket = new FakeSocket();
      return { socket, id: hub.attach(socket, undefined, { userId }) };
    });
    const [mine, mineHome, theirs] = tabs as [(typeof tabs)[0], (typeof tabs)[0], (typeof tabs)[0]];
    mine.socket.receive({ type: 'subscribe', projectId: 'p1' });
    theirs.socket.receive({ type: 'presence', projectId: 'p2', route: '/p/p2/cast' });
    const send = (cmd: { projectId?: string; sessionId?: string }, reach?: UiReach) =>
      hub
        .sendUi(
          { issuedBy: actor, action: 'notify', params: { message: 'x' }, ...cmd },
          { reach, timeoutMs: 5 },
        )
        .then((r) => r.delivered.sort());

    // a person's command: the tabs on its project, or without a project the person's own
    expect(await send({ projectId: 'p1' }, { userId: 'u1' })).toEqual([mine.id]);
    expect(await send({ projectId: 'p1', sessionId: theirs.id }, { userId: 'u1' })).toEqual([]);
    expect(await send({ projectId: 'p2', sessionId: theirs.id }, { userId: 'u1' })).toEqual([theirs.id]);
    expect(await send({}, { userId: 'u1' })).toEqual([mine.id, mineHome.id].sort());
    expect(await send({ sessionId: theirs.id }, { userId: 'u1' })).toEqual([]);
    expect(await send({ sessionId: mineHome.id }, { userId: 'u1' })).toEqual([mineHome.id]);
    // nobody named: no tab without a project
    expect(await send({})).toEqual([]);
    expect(await send({}, { userId: null })).toEqual([]);
    // auth mode none: a session id reaches its tab wherever it is, no project every tab
    expect(await send({ projectId: 'p1', sessionId: theirs.id }, { everyone: true })).toEqual([theirs.id]);
    expect(await send({}, { everyone: true })).toEqual(tabs.map((t) => t.id).sort());
    expect(await send({ projectId: 'p2' }, { everyone: true })).toEqual([theirs.id]);
    hub.close();
  });

  it('strips oversized commit documents so clients refetch them', () => {
    const hub = new LiveHub();
    const s = new FakeSocket();
    hub.attach(s);
    s.receive({ type: 'subscribe', projectId: 'p1' });
    hub.publish('p1', {
      kind: 'commit',
      commit: {
        id: 'c',
        parents: [],
        author: actor,
        message: 'big',
        timestamp: new Date().toISOString(),
        changes: [],
      },
      docs: { 'timeline.json': { blob: 'x'.repeat(600_000) } },
    });
    const ev = s.sent.find((m) => m.type === 'event') as Extract<ServerMessage, { type: 'event' }>;
    expect(ev.event.kind === 'commit' && ev.event.docs).toBeNull();
    hub.close();
  });

  it('answers job heartbeats on the live channel for the session holding the lease', () => {
    const hub = new LiveHub();
    const tab = new FakeSocket();
    hub.attach(tab);
    const sessionId = (tab.sent[0] as { sessionId: string }).sessionId;
    const beats: unknown[] = [];
    hub.jobHeartbeat = (session, jobId, progress) => {
      beats.push([session, jobId, progress]);
      if (jobId === 'job_lost') throw Object.assign(new Error('not leased'), { code: 'lease_lost' });
      return {
        cancelled: jobId === 'job_cancelled',
        leaseExpiresAt: jobId === 'job_cancelled' ? null : 'soon',
      };
    };
    tab.receive({
      type: 'job-heartbeat',
      jobId: 'job_a',
      progress: { done: 1, total: 4, message: 'chunk 1/3' },
    });
    tab.receive({ type: 'job-heartbeat', jobId: 'job_lost' });
    tab.receive({ type: 'job-heartbeat', jobId: 'job_cancelled' });
    expect(beats[0]).toEqual([sessionId, 'job_a', { done: 1, total: 4, message: 'chunk 1/3' }]);
    expect(tab.sent.filter((m) => m.type === 'job-heartbeat')).toEqual([
      { type: 'job-heartbeat', jobId: 'job_a', leased: true, cancelled: false, leaseExpiresAt: 'soon' },
      { type: 'job-heartbeat', jobId: 'job_lost', leased: false, cancelled: false, leaseExpiresAt: null },
      { type: 'job-heartbeat', jobId: 'job_cancelled', leased: true, cancelled: true, leaseExpiresAt: null },
    ]);
  });
});

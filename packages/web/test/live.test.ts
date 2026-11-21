import type { ServerMessage } from '@rideo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EditorApi, EditorWorker } from '../src/engine/worker';
import { ApiError } from '../src/lib/api';
import { LiveClient } from '../src/lib/live';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe('LiveClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subscribes from a snapshot seq, drops duplicates and acks UI commands', async () => {
    const events: number[] = [];
    const ui = vi.fn();
    const client = new LiveClient({
      onEvent: (_p, seq) => events.push(seq),
      onResync: vi.fn(),
      onUi: ui,
      onStatus: vi.fn(),
    });
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive({ type: 'hello', sessionId: 's1', instanceId: 'i1', serverTime: 'now' });
    client.subscribe('prj_a', 5);
    expect(ws.sent.at(-1)).toEqual({ type: 'subscribe', projectId: 'prj_a', lastSeq: 5, ref: 1 });
    const activity = {
      kind: 'activity' as const,
      actor: { kind: 'agent' as const, id: 'a' },
      action: 'x',
      summary: 'y',
      at: '2026-09-30T10:00:00.000Z',
    };
    ws.receive({ type: 'event', projectId: 'prj_a', seq: 5, event: activity });
    ws.receive({ type: 'event', projectId: 'prj_a', seq: 6, event: activity });
    ws.receive({ type: 'event', projectId: 'prj_b', seq: 1, event: activity });
    expect(events).toEqual([6]);
    ws.receive({
      type: 'ui',
      command: {
        id: 'cmd_1',
        issuedBy: { kind: 'agent', id: 'a' },
        action: 'notify',
        params: { message: 'hi' },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(ui).toHaveBeenCalledOnce();
    expect(ws.sent.at(-1)).toEqual({ type: 'ui-ack', commandId: 'cmd_1', ok: true });
    client.close();
  });

  it('hands notifications to their handler (docs/design/review.md#notifications)', () => {
    const onNotification = vi.fn();
    const client = new LiveClient({
      onEvent: vi.fn(),
      onResync: vi.fn(),
      onUi: vi.fn(),
      onStatus: vi.fn(),
      onNotification,
    });
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    const notification = {
      id: 'ntf_000000000001',
      at: '2026-10-01T10:00:00.000Z',
      kind: 'mention' as const,
      projectId: 'prj_000000000001',
      title: 'Cleo mentioned you',
      body: '@Ben the lamp',
      link: '/p/prj_000000000001/clips?comment=cmt_000000000001',
      read: false,
    };
    ws.receive({ type: 'notification', notification });
    expect(onNotification).toHaveBeenCalledWith(notification);
    client.close();
  });

  it('resyncs subscriptions when the server restarted', () => {
    const onResync = vi.fn();
    const client = new LiveClient({ onEvent: vi.fn(), onResync, onUi: vi.fn(), onStatus: vi.fn() });
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive({ type: 'hello', sessionId: 's1', instanceId: 'i1', serverTime: 'now' });
    client.subscribe('prj_a', 3);
    ws.receive({ type: 'hello', sessionId: 's2', instanceId: 'i2', serverTime: 'now' });
    expect(onResync).toHaveBeenCalledWith('prj_a', 'server restarted');
    expect(ws.sent.at(-1)).toEqual({ type: 'subscribe', projectId: 'prj_a', ref: 2 });
    // the restarted server's session follows the project only once it answers the resubscription
    expect(client.follows('prj_a')).toBe(false);
    ws.receive({ type: 'subscribed', projectId: 'prj_a', ref: 2 });
    expect(client.follows('prj_a')).toBe(true);
    expect(client.sessionId).toBe('s2');
    client.close();
  });

  // docs/design/realtime-sync.md#server--client: the tab claims editor jobs only through a session that follows the project
  it("follows a project only once the server answers the session's latest subscribe, again after every reconnect", () => {
    const answered: string[] = [];
    const client = new LiveClient({
      onEvent: vi.fn(),
      onResync: vi.fn(),
      onUi: vi.fn(),
      onStatus: vi.fn(),
      onSubscribed: (projectId) => answered.push(projectId),
    });
    // subscribed before the socket opened: sent on hello, with a ref of its own
    client.subscribe('prj_a', 4);
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive({ type: 'hello', sessionId: 's1', instanceId: 'i1', serverTime: 'now' });
    const first = ws.sent.find((m) => m.type === 'subscribe');
    expect(first).toEqual({ type: 'subscribe', projectId: 'prj_a', lastSeq: 4, ref: expect.any(Number) });
    expect(client.follows('prj_a')).toBe(false);
    // an answer to another subscribe (an older ref) or another project does not count
    ws.receive({ type: 'subscribed', projectId: 'prj_a', ref: first.ref - 1 });
    ws.receive({ type: 'subscribed', projectId: 'prj_b', ref: first.ref });
    expect(client.follows('prj_a')).toBe(false);
    expect(answered).toEqual([]);
    ws.receive({ type: 'subscribed', projectId: 'prj_a', ref: first.ref });
    expect(client.follows('prj_a')).toBe(true);
    expect(answered).toEqual(['prj_a']);
    // left and subscribed again: the answer to the first subscribe, arriving late, does not count
    client.unsubscribe('prj_a');
    expect(client.follows('prj_a')).toBe(false);
    client.subscribe('prj_a', 6);
    const again = ws.sent.at(-1);
    ws.receive({ type: 'subscribed', projectId: 'prj_a', ref: first.ref });
    expect(client.follows('prj_a')).toBe(false);
    ws.receive({ type: 'subscribed', projectId: 'prj_a', ref: again.ref });
    expect(client.follows('prj_a')).toBe(true);
    // the socket drops: the new session follows nothing until the server answers its resubscription
    ws.close();
    expect(client.follows('prj_a')).toBe(false);
    client.connect(); // the reconnect (its timer is cleared by close() below)
    const ws2 = FakeWebSocket.instances.at(-1)!;
    ws2.open();
    ws2.receive({ type: 'hello', sessionId: 's2', instanceId: 'i1', serverTime: 'now' });
    const resubscribe = ws2.sent.find((m) => m.type === 'subscribe');
    expect(resubscribe).toEqual({
      type: 'subscribe',
      projectId: 'prj_a',
      lastSeq: 6,
      ref: expect.any(Number),
    });
    expect(client.follows('prj_a')).toBe(false);
    ws2.receive({ type: 'subscribed', projectId: 'prj_a', ref: again.ref });
    expect(client.follows('prj_a')).toBe(false);
    ws2.receive({ type: 'subscribed', projectId: 'prj_a', ref: resubscribe.ref });
    expect(client.follows('prj_a')).toBe(true);
    expect(client.sessionId).toBe('s2');
    expect(answered).toEqual(['prj_a', 'prj_a', 'prj_a']);
    client.close();
  });

  it('sends job heartbeats when open and hands their answers on', () => {
    const answers: unknown[] = [];
    const client = new LiveClient({
      onEvent: vi.fn(),
      onResync: vi.fn(),
      onUi: vi.fn(),
      onStatus: vi.fn(),
      onJobHeartbeat: (r) => answers.push(r),
    });
    expect(client.jobHeartbeat('job_a')).toBe(false);
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    expect(client.jobHeartbeat('job_a')).toBe(false); // no session yet
    ws.receive({ type: 'hello', sessionId: 's1', instanceId: 'i1', serverTime: 'now' });
    expect(client.jobHeartbeat('job_a', { done: 1, total: 2 })).toBe(true);
    expect(ws.sent.at(-1)).toEqual({
      type: 'job-heartbeat',
      jobId: 'job_a',
      progress: { done: 1, total: 2 },
    });
    ws.receive({
      type: 'job-heartbeat',
      jobId: 'job_a',
      leased: false,
      cancelled: false,
      leaseExpiresAt: null,
    });
    expect(answers).toEqual([
      { type: 'job-heartbeat', jobId: 'job_a', leased: false, cancelled: false, leaseExpiresAt: null },
    ]);
  });
});

/**
 * The tab's editor jobs claimed over a live session that follows the project (docs/design/editor.md#editor-jobs): the
 * claim goes over HTTP, the subscription over the WebSocket, so the claim waits for the server's answer to the
 * subscription. Wired as LiveBridge wires them; the fake server refuses a claim of a session that does not follow the
 * project, as the studio does (409 conflict, "subscribe first").
 */
describe('editor-job claims after the live subscription', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const P = 'prj_01m3s0000000000000';
  const idle = () => new Promise((r) => setTimeout(r, 20));

  it('claims nothing before the subscription is answered, once after it, and again after a reconnect resubscribes', async () => {
    const followed = new Set<string>();
    const claims: { sessionId: string; status: number }[] = [];
    const api: EditorApi = {
      editorClaim: vi.fn(async (sessionId: string, projectId: string) => {
        const ok = followed.has(`${sessionId} ${projectId}`);
        claims.push({ sessionId, status: ok ? 200 : 409 });
        if (!ok)
          throw new ApiError(409, {
            type: '',
            title: '',
            status: 409,
            detail: 'this live session does not follow the project; subscribe first',
            code: 'conflict',
          });
        return { job: null };
      }),
      editorHeartbeat: vi.fn(async () => ({ cancelled: false, leaseExpiresAt: null })),
      editorUpload: vi.fn(async () => undefined),
      editorComplete: vi.fn(async () => undefined),
      editorFail: vi.fn(async () => undefined),
    };
    const worker = new EditorWorker({
      api,
      pollMs: 60_000,
      handlers: {
        'export.render': async () => ({}),
        'media.process': async () => ({}),
        'analysis.signals': async () => ({}),
      },
    });
    const client = new LiveClient({
      onEvent: vi.fn(),
      onResync: vi.fn(),
      onUi: vi.fn(),
      onStatus: vi.fn(),
      onSubscribed: () => void worker.poke(),
    });
    worker.setSession((projectId) => (client.follows(projectId) ? client.sessionId : null));
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive({ type: 'hello', sessionId: 's1', instanceId: 'i1', serverTime: 'now' });
    // the project opens: the worker is told at once, the subscription goes once the snapshot is loaded
    worker.setProject(P);
    client.subscribe(P, 0);
    const subscribe = ws.sent.find((m) => m.type === 'subscribe');
    // the server's answer is late (its authorization takes a while); the worker is poked meanwhile (a job event)
    await idle();
    await worker.poke();
    await idle();
    expect(claims).toEqual([]);
    // the server follows the project, then answers: one claim, accepted
    followed.add(`s1 ${P}`);
    ws.receive({ type: 'subscribed', projectId: P, ref: subscribe.ref });
    await idle();
    expect(claims).toEqual([{ sessionId: 's1', status: 200 }]);
    // the socket drops; the new session resubscribes and claims only once the server answers
    ws.close();
    client.connect(); // the reconnect (its timer is cleared by close() below)
    const ws2 = FakeWebSocket.instances.at(-1)!;
    ws2.open();
    ws2.receive({ type: 'hello', sessionId: 's2', instanceId: 'i1', serverTime: 'now' });
    await worker.poke();
    await idle();
    expect(claims).toEqual([{ sessionId: 's1', status: 200 }]);
    const resubscribe = ws2.sent.find((m) => m.type === 'subscribe');
    followed.add(`s2 ${P}`);
    ws2.receive({ type: 'subscribed', projectId: P, ref: resubscribe.ref });
    await idle();
    expect(claims).toEqual([
      { sessionId: 's1', status: 200 },
      { sessionId: 's2', status: 200 },
    ]);
    worker.setProject(null);
    client.close();
  });
});

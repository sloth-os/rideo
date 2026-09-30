import type { ServerMessage } from '@rideo/shared';
import { describe, expect, it } from 'vitest';
import { LiveHub, type LiveSocket } from '../../src/live/hub';

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
    expect(late.sent.at(-1)).toMatchObject({ type: 'resync', projectId: 'p2' });
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
      1000,
    );
    await new Promise((r) => setTimeout(r, 5));
    const ui = s.sent.find((m) => m.type === 'ui') as Extract<ServerMessage, { type: 'ui' }>;
    expect(ui.command.params.view).toBe('clips');
    s.receive({ type: 'ui-ack', commandId: ui.command.id, ok: true });
    const res = await pending;
    expect(res.acked).toEqual([{ sessionId: id, ok: true }]);
    const none = await hub.sendUi(
      { issuedBy: actor, projectId: 'nobody', action: 'notify', params: { message: 'hi' } },
      50,
    );
    expect(none.delivered).toEqual([]);
    s.receive({ type: 'ping' });
    expect(s.sent.at(-1)).toEqual({ type: 'pong' });
    s.close();
    expect(hub.sessionsFor()).toHaveLength(0);
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
});

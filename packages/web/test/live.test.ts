import type { ServerMessage } from '@rideo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(ws.sent.at(-1)).toEqual({ type: 'subscribe', projectId: 'prj_a', lastSeq: 5 });
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
    expect(ws.sent.at(-1)).toEqual({ type: 'subscribe', projectId: 'prj_a' });
    client.close();
  });
});

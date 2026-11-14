import {
  DESK_HELLO_TIMEOUT_MS,
  DESK_STATE_WRITE_INTERVAL_MS,
  type DeskBrief,
  type DeskResultMessage,
  type DeskState,
} from '@rideo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskBridge, type DeskStatus, type StoredDeskState } from '../src/features/desk/bridge';

/**
 * The studio's side of the desk embed protocol (docs/design/director-desk.md#the-protocol), driven with a fake host
 * window, a fake desk window and fake ports.
 */
const DESK_URL = 'https://desk.example.com/app/desk.html';
const ORIGIN = 'https://desk.example.com';
const SCENE = 'clp_0000000000000001';
const SHOT = 'sht_0000000000000001';

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (data: ArrayBuffer) => new TextDecoder().decode(data);

const brief = (): DeskBrief => ({
  id: SCENE,
  name: 'Scene 1',
  fps: 24,
  width: 1280,
  height: 720,
  set: { description: '', interior: null, timeOfDay: null },
  cast: [],
  elements: [],
  shots: [
    {
      id: SHOT,
      index: 0,
      durationSec: 3,
      description: 'Mira climbs the stairs.',
      action: '',
      castIds: [],
      elementIds: [],
      framing: 'wide',
      movement: 'static',
      move: null,
      lensMm: null,
      continuity: 'cut',
      layout: [],
    },
  ],
});

const READY = {
  type: 'ready',
  deskVersion: '0.2.0',
  protocol: 1,
  capabilities: {
    export: {
      available: true,
      reason: null,
      container: 'mp4',
      videoCodec: 'avc1',
      modes: ['motion', 'pose', 'camera'],
    },
    offline: true,
  },
};
const state = (content: string, id?: string) => ({
  type: 'state',
  ...(id ? { id } : {}),
  sceneId: SCENE,
  state: { format: '3d-editor.desk-state', version: 1, data: bytes(content) },
  shots: 1,
});
const RESULT = (): DeskResultMessage => ({
  type: 'result',
  id: 'desk-1',
  sceneId: SCENE,
  fps: 24,
  width: 1280,
  height: 720,
  shots: [
    {
      shotId: SHOT,
      frames: 72,
      durationSec: 3,
      references: { camera: `${SHOT}.camera.mp4` },
      still: null,
      camera: { lensMm: 35, move: null },
      line: '',
      moves: null,
      planAgrees: null,
      issues: [],
    },
  ],
  files: [{ name: `${SHOT}.camera.mp4`, mime: 'video/mp4', data: bytes('mp4') }],
});

function harness(
  opts: {
    stored?: StoredDeskState | null;
    load?: () => Promise<StoredDeskState | null>;
    sha256?: (data: ArrayBuffer) => Promise<string>;
  } = {},
) {
  let listener: ((e: MessageEvent) => void) | null = null;
  const host = {
    addEventListener: vi.fn((_type: 'message', fn: (e: MessageEvent) => void) => {
      listener = fn;
    }),
    removeEventListener: vi.fn(() => {
      listener = null;
    }),
  };
  const deskWindow = { postMessage: vi.fn() };
  const otherWindow = { postMessage: vi.fn() };
  const port = {
    postMessage: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
    close: vi.fn(),
  };
  const port2 = { second: true } as unknown as Transferable;
  const statuses: DeskStatus[] = [];
  const events: string[] = [];
  const stores: string[] = [];
  const toasts: [string, string][] = [];
  let closed = 0;
  const bridge = new DeskBridge({
    url: DESK_URL,
    host,
    frame: () => deskWindow,
    brief,
    options: () => ({
      hostName: 'Rideo',
      modes: ['camera', 'motion', 'pose'],
      defaultMode: 'camera',
      readOnly: false,
    }),
    load: opts.load ?? (async () => opts.stored ?? null),
    store: async (s: DeskState) => {
      events.push(`store ${text(s.data)}`);
      stores.push(text(s.data));
      return text(s.data);
    },
    applyResult: async (r) => {
      events.push(`apply ${r.id}`);
      return { ok: true, message: 'Attached 1 reference.', shots: [{ shotId: SHOT, ok: true }] };
    },
    onStatus: (s) => statuses.push(s),
    onToast: (message, level) => toasts.push([message, level]),
    onClosed: () => {
      closed++;
    },
    channel: () => ({ port1: port, port2 }),
    // the fake states are text: their "hash" is the text
    sha256: opts.sha256 ?? (async (data) => text(data)),
  });
  return {
    bridge,
    host,
    deskWindow,
    otherWindow,
    port,
    port2,
    statuses,
    events,
    stores,
    toasts,
    closed: () => closed,
    last: () => statuses.at(-1)!,
    hello: (
      data: unknown = { protocol: '3d-desk', type: 'hello', versions: [1] },
      source: unknown = deskWindow,
      origin = ORIGIN,
    ) => listener?.({ data, source, origin } as MessageEvent),
    desk: (data: unknown) => port.onmessage?.({ data } as MessageEvent),
    posted: () => port.postMessage.mock.calls.map((c) => c[0] as { type: string }),
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** A bridge connected and opened. */
async function opened(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  h.bridge.start();
  h.bridge.frameLoaded();
  h.hello();
  h.desk(READY);
  await flush();
  h.desk({ type: 'opened', sceneId: SCENE, source: 'brief', changes: null });
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the desk bridge: connecting (docs/design/director-desk.md#the-protocol)', () => {
  it("accepts a hello only from the iframe's window, from the desk's origin, offering version 1", () => {
    const h = harness();
    h.bridge.start();
    h.hello(undefined, h.otherWindow);
    h.hello(undefined, h.deskWindow, 'https://evil.example.com');
    h.hello({ protocol: '3d-desk', type: 'hello' });
    h.hello({ protocol: 'other', type: 'hello', versions: [1] });
    expect(h.deskWindow.postMessage).not.toHaveBeenCalled();
    h.hello();
    expect(h.deskWindow.postMessage).toHaveBeenCalledWith(
      { protocol: '3d-desk', type: 'connect', version: 1 },
      ORIGIN,
      [h.port2],
    );
    expect(h.last().phase).toBe('opening');
  });

  it('names the protocol versions when the desk speaks none of this studio', () => {
    const h = harness();
    h.bridge.start();
    h.hello({ protocol: '3d-desk', type: 'hello', versions: [2, 3] });
    expect(h.deskWindow.postMessage).not.toHaveBeenCalled();
    expect(h.last()).toMatchObject({
      phase: 'failed',
      failure: 'This desk speaks protocol versions 2, 3; this studio speaks 1',
    });
  });

  it("gives up 15 seconds after the iframe's load without a hello, and Close still works", async () => {
    const h = harness();
    h.bridge.start();
    h.bridge.frameLoaded();
    await vi.advanceTimersByTimeAsync(DESK_HELLO_TIMEOUT_MS - 1);
    expect(h.last().failure).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.last()).toMatchObject({
      phase: 'failed',
      failure:
        'The desk at https://desk.example.com did not answer. Check that it is served with the headers it needs',
    });
    await h.bridge.close();
    expect(h.closed()).toBe(1);
    expect(h.port.postMessage).not.toHaveBeenCalled();
    expect(h.host.removeEventListener).toHaveBeenCalled();
  });
});

describe('the desk bridge: the scene and its state', () => {
  it('opens with the brief, the stored state and the options after ready, the bytes transferred', async () => {
    const stored = { format: '3d-editor.desk-state', version: 1, sha256: 'stored', data: bytes('stored') };
    const h = await opened({ stored });
    const open = h.port.postMessage.mock.calls.find((c) => (c[0] as { type: string }).type === 'open')!;
    expect(open[0]).toEqual({
      type: 'open',
      scene: brief(),
      state: { format: '3d-editor.desk-state', version: 1, data: stored.data },
      options: {
        hostName: 'Rideo',
        modes: ['camera', 'motion', 'pose'],
        defaultMode: 'camera',
        readOnly: false,
      },
    });
    expect(open[1]).toEqual([stored.data]);
    expect(h.last()).toMatchObject({ phase: 'open', line: 'Opened from the brief' });
    // once per connection
    h.desk(READY);
    await flush();
    expect(h.posted().filter((m) => m.type === 'open')).toHaveLength(1);
  });

  it('opens with no state when none is stored', async () => {
    const h = await opened();
    expect(h.posted().find((m) => m.type === 'open')).toMatchObject({ state: null });
  });

  it('keeps the newest state and stores it at most every 10 minutes while the desk is open, when it changed', async () => {
    const h = await opened({
      stored: { format: '3d-editor.desk-state', version: 1, sha256: 'b', data: bytes('b') },
    });
    h.desk(state('a'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.stores).toEqual([]);
    h.desk(state('b'));
    h.desk(state('c'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS - 60_000);
    expect(h.stores).toEqual(['c']);
    // the stored bytes again: no write
    h.desk(state('c'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.stores).toEqual(['c']);
    // 10 minutes after the last write the next change is stored at once, the one after it 10 minutes later
    h.desk(state('d'));
    await flush();
    expect(h.stores).toEqual(['c', 'd']);
    h.desk(state('e'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS - 1);
    expect(h.stores).toEqual(['c', 'd']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.stores).toEqual(['c', 'd', 'e']);
  });

  it('skips the write when the sha256 is the stored one', async () => {
    const h = await opened({
      stored: { format: '3d-editor.desk-state', version: 1, sha256: 'same', data: bytes('same') },
    });
    h.desk(state('same'));
    h.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(h.stores).toEqual([]);
    expect(h.closed()).toBe(1);
  });

  it('stores the state when this page cannot hash it (the server keeps the same bytes once)', async () => {
    const h = await opened({
      stored: { format: '3d-editor.desk-state', version: 1, sha256: 'same', data: bytes('same') },
      sha256: async () => {
        throw new Error('crypto.subtle is not available');
      },
    });
    h.desk(state('same'));
    h.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(h.stores).toEqual(['same']);
    expect(h.toasts).toEqual([]);
    expect(h.closed()).toBe(1);
  });

  it('Close asks the desk for its state, stores it and closes the panel', async () => {
    const h = await opened();
    h.desk(state('working'));
    const closing = h.bridge.close();
    expect(h.posted().at(-1)).toEqual({ type: 'save', id: 'save-1' });
    expect(h.last().phase).toBe('closing');
    h.desk(state('final', 'save-1'));
    await closing;
    expect(h.stores).toEqual(['final']);
    expect(h.closed()).toBe(1);
    expect(h.port.close).toHaveBeenCalled();
    expect(h.host.removeEventListener).toHaveBeenCalled();
  });

  it("closes with the newest state when the desk does not answer save, and on the desk's own close", async () => {
    const h = await opened();
    h.desk(state('newest'));
    const closing = h.bridge.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    expect(h.stores).toEqual(['newest']);
    const d = await opened();
    d.desk(state('done'));
    d.desk({ type: 'close', reason: 'cancel' });
    await flush();
    expect(d.stores).toEqual(['done']);
    expect(d.closed()).toBe(1);
  });
});

describe('the desk bridge: messages', () => {
  it('answers bad_message for an invalid message with an id; ignores unknown types and invalid ones without', async () => {
    const h = await opened();
    const before = h.port.postMessage.mock.calls.length;
    h.desk({ type: 'progress', id: 'exp-1', phase: 'render', done: -1, total: 10 });
    expect(h.port.postMessage.mock.calls.length).toBe(before + 1);
    expect(h.posted().at(-1)).toMatchObject({ type: 'error', id: 'exp-1', code: 'bad_message' });
    expect((h.posted().at(-1) as unknown as { message: string }).message).toMatch(/^progress: done/);
    h.desk({ type: 'wobble', id: 'x-1' });
    h.desk({ type: 'opened', sceneId: 'has space', source: 'brief', changes: null });
    h.desk('not an object');
    expect(h.port.postMessage.mock.calls.length).toBe(before + 1);
  });

  it("stores the newest state before a result, applies it and answers result-ack, with the summary's toast", async () => {
    const h = await opened();
    h.desk(state('staged'));
    h.desk(RESULT());
    await flush();
    expect(h.events).toEqual(['store staged', 'apply desk-1']);
    expect(h.posted().at(-1)).toEqual({
      type: 'result-ack',
      id: 'desk-1',
      ok: true,
      message: 'Attached 1 reference.',
      shots: [{ shotId: SHOT, ok: true }],
    });
    expect(h.toasts).toContainEqual(['Attached 1 reference.', 'success']);
  });

  it("says why the browser cannot render the clips, and shows the desk's errors and progress", async () => {
    const h = harness();
    h.bridge.start();
    h.hello();
    h.desk({
      ...READY,
      capabilities: {
        ...READY.capabilities,
        export: { ...READY.capabilities.export, available: false, reason: 'No WebCodecs.' },
      },
    });
    await flush();
    expect(h.last().exportUnavailable).toBe('This browser cannot render the reference clips: No WebCodecs.');
    h.desk({ type: 'progress', id: 'desk-2', phase: 'encode', done: 12, total: 72 });
    expect(h.last().line).toBe('Rendering the clips: encoding 12 of 72');
    h.desk({ type: 'error', code: 'state_unreadable', message: 'another scene' });
    expect(h.last().line).toBe('The stored desk could not be read; the scene was staged from the brief');
    h.desk({ type: 'error', id: 'exp-1', code: 'export_failed', message: 'The encoder stopped.' });
    expect(h.last().line).toBe('The encoder stopped.');
  });

  it('ignores the states of another scene', async () => {
    const h = await opened();
    h.desk({ ...state('other'), sceneId: 'clp_0000000000000002' });
    h.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(h.stores).toEqual([]);
  });
});

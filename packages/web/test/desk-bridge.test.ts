import {
  DESK_CLOSE_STORE_TIMEOUT_MS,
  DESK_HELLO_TIMEOUT_MS,
  DESK_STATE_WRITE_INTERVAL_MS,
  DESK_STORE_RETRY_MS,
  type DeskBrief,
  type DeskResultMessage,
  type DeskState,
} from '@rideo/shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeskBridge, type DeskStatus, type StoredDeskState, sha256Hex } from '../src/features/desk/bridge';
import type { DeskAck } from '../src/features/desk/results';
import { ApiError, api } from '../src/lib/api';

/**
 * The studio's side of the desk embed protocol (docs/design/director-desk.md#the-protocol), driven with a fake host
 * window, a fake desk window and fake ports (a new one per connection).
 */
const DESK_URL = 'https://desk.example.com/app/desk.html';
const ORIGIN = 'https://desk.example.com';
const SCENE = 'clp_0000000000000001';
const SHOT = 'sht_0000000000000001';
const FORMAT = '3d-editor.desk-state';

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (data: ArrayBuffer) => new TextDecoder().decode(data);
const stored = (content: string, sha256 = content): StoredDeskState => ({
  format: FORMAT,
  version: 1,
  sha256,
  data: bytes(content),
});

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
const OPENED = { type: 'opened', sceneId: SCENE, source: 'brief', changes: null };
const state = (content: string, id?: string) => ({
  type: 'state',
  ...(id ? { id } : {}),
  sceneId: SCENE,
  state: { format: FORMAT, version: 1, data: bytes(content) },
  shots: 1,
});
const RESULT = (id = 'desk-1'): DeskResultMessage => ({
  type: 'result',
  id,
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

interface FakePort {
  postMessage: Mock;
  onmessage: ((e: MessageEvent) => void) | null;
  close: Mock;
}

/** A store that answers only when aborted, the way a fetch whose server stalls does. */
const stalled = (_state: DeskState, signal?: AbortSignal) =>
  new Promise<string>((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason));
  });

function harness(
  opts: {
    stored?: StoredDeskState | null;
    load?: () => Promise<StoredDeskState | null>;
    /** null: the bridge's own sha256 (crypto.subtle); by default the fake states' "hash" is their text */
    sha256?: ((data: ArrayBuffer) => Promise<string>) | null;
    /** what a write does after it was counted; by default it succeeds with the text as the sha256 */
    store?: (state: DeskState, signal?: AbortSignal) => Promise<string>;
    applyResult?: (result: DeskResultMessage) => Promise<DeskAck>;
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
  const ports: FakePort[] = [];
  const port2 = { second: true } as unknown as Transferable;
  const statuses: DeskStatus[] = [];
  const events: string[] = [];
  /** Every write attempt's state, in order (successful or not). */
  const stores: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
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
    store: async (s, signal) => {
      events.push(`store ${text(s.data)}`);
      stores.push(text(s.data));
      signals.push(signal);
      return opts.store ? opts.store(s, signal) : text(s.data);
    },
    applyResult:
      opts.applyResult ??
      (async (r) => {
        events.push(`apply ${r.id}`);
        return { ok: true, message: 'Attached 1 reference.', shots: [{ shotId: SHOT, ok: true }] };
      }),
    onStatus: (s) => statuses.push(s),
    onToast: (message, level) => toasts.push([message, level]),
    onClosed: () => {
      closed++;
    },
    channel: () => {
      const port: FakePort = { postMessage: vi.fn(), onmessage: null, close: vi.fn() };
      ports.push(port);
      return { port1: port, port2 };
    },
    ...(opts.sha256 === null ? {} : { sha256: opts.sha256 ?? (async (data) => text(data)) }),
  });
  return {
    bridge,
    host,
    deskWindow,
    otherWindow,
    ports,
    /** The newest connection's port. */
    get port() {
      return ports.at(-1) as FakePort;
    },
    port2,
    statuses,
    events,
    stores,
    signals,
    toasts,
    closed: () => closed,
    last: () => statuses.at(-1) as DeskStatus,
    hello: (
      data: unknown = { protocol: '3d-desk', type: 'hello', versions: [1] },
      source: unknown = deskWindow,
      origin = ORIGIN,
    ) => listener?.({ data, source, origin } as MessageEvent),
    desk: (data: unknown, port = ports.at(-1)) => port?.onmessage?.({ data } as MessageEvent),
    posted: (port = ports.at(-1)) =>
      (port?.postMessage.mock.calls ?? []).map((c) => c[0] as { type: string; [key: string]: unknown }),
    /** Every `open` sent, on every connection. */
    opens: () =>
      ports.flatMap((p) =>
        p.postMessage.mock.calls
          .filter((c) => (c[0] as { type: string }).type === 'open')
          .map((c) => ({ message: c[0] as { state: DeskState | null }, transfer: c[1] as ArrayBuffer[] })),
      ),
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** A bridge connected and opened (the iframe's `load` first, then the desk's `hello`). */
async function opened(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  h.bridge.start();
  h.bridge.frameLoaded();
  h.hello();
  h.desk(READY);
  await flush();
  h.desk(OPENED);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

  it('names the protocol versions when the desk speaks none of this studio, cut to 300 characters', () => {
    const h = harness();
    h.bridge.start();
    h.hello({ protocol: '3d-desk', type: 'hello', versions: [2, 3] });
    expect(h.deskWindow.postMessage).not.toHaveBeenCalled();
    expect(h.last()).toMatchObject({
      phase: 'failed',
      failure: 'This desk speaks protocol versions 2, 3; this studio speaks 1',
      remedy: null,
    });
    const many = harness();
    many.bridge.start();
    many.hello({
      protocol: '3d-desk',
      type: 'hello',
      versions: Array.from({ length: 5000 }, (_, i) => i + 2),
    });
    const failure = many.last().failure as string;
    expect(failure).toMatch(/^This desk speaks protocol versions 2, 3, 4, .*…; this studio speaks 1$/);
    expect(failure.length).toBeLessThanOrEqual(300 + 60);
  });

  it('gives up 15 seconds after a load of the iframe no hello answered, and Close still works', async () => {
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
      remedy: 'headers',
    });
    await h.bridge.close();
    expect(h.closed()).toBe(1);
    expect(h.ports).toHaveLength(0);
    expect(h.host.removeEventListener).toHaveBeenCalled();
  });

  it("connects a hello that arrives before the iframe's load event, and that load starts no timeout", async () => {
    const h = harness();
    h.bridge.start();
    h.hello();
    h.bridge.frameLoaded();
    await vi.advanceTimersByTimeAsync(DESK_HELLO_TIMEOUT_MS * 2);
    expect(h.statuses.some((s) => s.phase === 'failed')).toBe(false);
    expect(h.last().phase).toBe('opening');
    expect(h.ports).toHaveLength(1);
    expect(h.port.close).not.toHaveBeenCalled();
  });

  it('connects a desk page that loads again, and gives a page that loads without a hello 15 seconds', async () => {
    const h = await opened();
    const first = h.port;
    // the desk page loads again: its hello first, then the iframe's load event
    h.hello();
    h.bridge.frameLoaded();
    expect(first.close).toHaveBeenCalled();
    expect(h.ports).toHaveLength(2);
    expect(h.last().phase).toBe('opening');
    h.desk(READY);
    await flush();
    h.desk(OPENED);
    expect(h.posted().filter((m) => m.type === 'open')).toHaveLength(1);
    // the page loads again, the load event first, then its hello
    h.bridge.frameLoaded();
    expect(h.last()).toMatchObject({ phase: 'connecting', line: `Connecting to the desk at ${ORIGIN}…` });
    h.hello();
    expect(h.ports).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(DESK_HELLO_TIMEOUT_MS);
    expect(h.last().phase).toBe('opening');
    h.desk(READY);
    await flush();
    h.desk(OPENED);
    // the page loads again into the browser's error page: no hello, the connection to the page that is gone dropped
    h.bridge.frameLoaded();
    expect(h.ports[2]?.close).toHaveBeenCalled();
    expect(h.last()).toMatchObject({ phase: 'connecting', failure: null });
    await vi.advanceTimersByTimeAsync(DESK_HELLO_TIMEOUT_MS - 1);
    expect(h.last().phase).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.last()).toMatchObject({ phase: 'failed', remedy: 'headers' });
  });
});

describe('the desk bridge: the scene and its state', () => {
  it('opens with the brief, a copy of the stored state and the options after ready; the panel keeps the original', async () => {
    const original = stored('stored');
    const h = await opened({ stored: original });
    const [open] = h.opens();
    expect(open?.message).toEqual({
      type: 'open',
      scene: brief(),
      state: { format: FORMAT, version: 1, data: bytes('stored') },
      options: {
        hostName: 'Rideo',
        modes: ['camera', 'motion', 'pose'],
        defaultMode: 'camera',
        readOnly: false,
      },
    });
    // the copy is transferred, not the stored bytes
    expect(open?.transfer).toEqual([open?.message.state?.data]);
    expect(open?.message.state?.data).not.toBe(original.data);
    expect(text(original.data)).toBe('stored');
    expect(h.last()).toMatchObject({ phase: 'open', line: 'Opened from the brief' });
    // once per connection
    h.desk(READY);
    await flush();
    expect(h.opens()).toHaveLength(1);
  });

  it('opens with no state when none is stored', async () => {
    const h = await opened();
    expect(h.opens()[0]?.message).toMatchObject({ state: null });
  });

  it('gives a desk that loads again before its first state the stored state again, after it the newest', async () => {
    const h = await opened({ stored: stored('stored') });
    h.hello();
    h.bridge.frameLoaded();
    h.desk(READY);
    await flush();
    h.desk(OPENED);
    expect(h.opens().map((o) => text(o.message.state?.data as ArrayBuffer))).toEqual(['stored', 'stored']);
    h.desk(state('staged'));
    h.hello();
    h.bridge.frameLoaded();
    h.desk(READY);
    await flush();
    expect(h.opens().map((o) => text(o.message.state?.data as ArrayBuffer))).toEqual([
      'stored',
      'stored',
      'staged',
    ]);
    // the panel keeps its newest state: the copy sent does not take it
    h.desk(OPENED);
    h.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(h.stores).toEqual(['staged']);
  });

  it.each([
    [
      'an error answer (503)',
      async () => {
        throw new ApiError(503, {
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          detail: 'the stored desk state of scene 1 could not be read: storage answered 404',
          code: 'storage_error',
        });
      },
      'The stored desk could not be loaded: the stored desk state of scene 1 could not be read: storage answered 404',
    ],
    [
      'a network failure',
      async () => {
        throw new TypeError('Failed to fetch');
      },
      'The stored desk could not be loaded: Failed to fetch',
    ],
    [
      'a format rideo does not know',
      async () => ({ ...stored('x'), format: 'another-desk.state' }),
      'The stored desk could not be loaded: it is in a format this studio does not read (another-desk.state, version 1)',
    ],
    [
      'a version rideo does not know',
      async () => ({ ...stored('x'), version: 2 }),
      'The stored desk could not be loaded: it is in a format this studio does not read (3d-editor.desk-state, version 2)',
    ],
  ])(
    'fails the panel with Retry when the stored state cannot be loaded (%s): nothing opened or stored',
    async (_case, failing, line) => {
      let fails = true;
      const h = harness({ load: async () => (fails ? failing() : stored('good')) });
      h.bridge.start();
      await flush();
      // a hello after the failure keeps it
      h.bridge.frameLoaded();
      h.hello();
      h.desk(READY);
      await flush();
      expect(h.last()).toMatchObject({ phase: 'failed', failure: line, line, remedy: 'retry' });
      expect(h.opens()).toEqual([]);
      // nothing the desk sends is kept or stored in that panel
      h.desk(state('staged without it'));
      await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
      expect(h.stores).toEqual([]);
      // Retry loads it again and opens the desk with it
      fails = false;
      h.bridge.retry();
      expect(h.last()).toMatchObject({ phase: 'opening', failure: null, remedy: null });
      await flush();
      expect(h.opens().map((o) => text(o.message.state?.data as ArrayBuffer))).toEqual(['good']);
      h.desk({ ...OPENED, source: 'state' });
      expect(h.last()).toMatchObject({ phase: 'open', line: 'Opened from the stored desk' });
    },
  );

  it('a load that fails again keeps Retry; Close stores nothing and asks the desk for nothing', async () => {
    const h = harness({
      load: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    h.bridge.start();
    h.bridge.frameLoaded();
    h.hello();
    h.desk(READY);
    await flush();
    h.bridge.retry();
    await flush();
    expect(h.last()).toMatchObject({ phase: 'failed', remedy: 'retry' });
    h.desk(state('staged without it'));
    await h.bridge.close();
    expect(h.stores).toEqual([]);
    expect(h.posted().map((m) => m.type)).toEqual([]);
    expect(h.closed()).toBe(1);
  });

  it('a load that fails while the desk page has not said hello keeps its 15 seconds, after Retry too', async () => {
    let fails = true;
    const h = harness({
      load: async () => {
        if (fails) throw new TypeError('Failed to fetch');
        return null;
      },
    });
    h.bridge.start();
    h.bridge.frameLoaded();
    await flush();
    expect(h.last()).toMatchObject({ phase: 'failed', remedy: 'retry' });
    fails = false;
    h.bridge.retry();
    await flush();
    expect(h.last()).toMatchObject({ phase: 'connecting', failure: null, remedy: null });
    await vi.advanceTimersByTimeAsync(DESK_HELLO_TIMEOUT_MS);
    expect(h.last()).toMatchObject({ phase: 'failed', remedy: 'headers' });
  });

  it('keeps the newest state and stores it at most every 10 minutes while the desk is open, when it changed', async () => {
    const h = await opened({ stored: stored('b') });
    h.desk(state('a'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.stores).toEqual([]);
    h.desk(state('b'));
    h.desk(state('c'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS - 60_000);
    expect(h.stores).toEqual(['c']);
    expect(h.last().line).toBe('Desk stored');
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

  it('starts the 10 minutes again at the write before a result', async () => {
    const h = await opened();
    h.desk(state('a'));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    h.desk(RESULT());
    await flush();
    expect(h.stores).toEqual(['a']);
    h.desk(state('b'));
    // where the first 10 minutes ended: no write
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    expect(h.stores).toEqual(['a']);
    // 10 minutes after the write before the result
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(h.stores).toEqual(['a', 'b']);
  });

  it('a state that comes while a write is stored waits 10 minutes from that write', async () => {
    let release = () => {};
    const h = await opened({
      store: (s) =>
        new Promise<string>((resolve) => {
          release = () => resolve(text(s.data));
        }),
    });
    h.desk(state('a'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.stores).toEqual(['a']);
    // the desk sends a state while 'a' is stored; the write ends 2 seconds later
    h.desk(state('b'));
    await vi.advanceTimersByTimeAsync(2_000);
    release();
    await flush();
    expect(h.last().line).toBe('Desk stored');
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS - 1);
    expect(h.stores).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.stores).toEqual(['a', 'b']);
  });

  it('tries a failing write again after 30 seconds, 1, 2, 4, 8 and 10 minutes, with one toast until it succeeds', async () => {
    let failing = true;
    const h = await opened({
      store: async (s) => {
        if (failing) throw new Error('the server went away');
        return text(s.data);
      },
    });
    h.desk(state('a'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.stores).toEqual(['a']);
    expect(h.toasts).toEqual([['The desk could not be stored: the server went away', 'error']]);
    expect(h.last().line).toBe('The desk could not be stored: the server went away; trying again in 30 s');
    // the desk keeps sending states (every 5 seconds while the person edits): no write per state
    for (let i = 1; i <= 5; i++) {
      h.desk(state(`b${i}`));
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(h.stores).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(DESK_STORE_RETRY_MS - 25_000);
    expect(h.stores).toEqual(['a', 'b5']);
    const waits = ['1 min', '2 min', '4 min', '8 min', '10 min', '10 min'];
    const delays = [60_000, 120_000, 240_000, 480_000, 600_000, 600_000];
    for (const [i, wait] of waits.entries()) {
      expect(h.last().line).toBe(
        `The desk could not be stored: the server went away; trying again in ${wait}`,
      );
      await vi.advanceTimersByTimeAsync((delays[i] as number) - 1);
      expect(h.stores).toHaveLength(2 + i);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.stores).toHaveLength(3 + i);
    }
    expect(h.toasts).toHaveLength(1);
    // it succeeds: the backoff ends, and a later failure says so again
    failing = false;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.last().line).toBe('Desk stored');
    const writes = h.stores.length;
    failing = true;
    h.desk(state('c'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.stores).toHaveLength(writes + 1);
    expect(h.toasts).toHaveLength(2);
  });

  it('skips the write when the sha256 is the stored one', async () => {
    const h = await opened({ stored: stored('same') });
    h.desk(state('same'));
    h.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(h.stores).toEqual([]);
    expect(h.closed()).toBe(1);
  });

  it('stores the state when this page cannot hash it (the server keeps the same bytes once)', async () => {
    const h = await opened({
      stored: stored('same'),
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
    const alone = await opened();
    alone.desk({ type: 'close', reason: 'cancel' });
    await flush();
    expect(alone.stores).toEqual([]);
    expect(alone.closed()).toBe(1);
  });

  it("closes without waiting for a result's uploads; their toast still says what was attached", async () => {
    let attach!: (ack: DeskAck) => void;
    const h = await opened({
      applyResult: () =>
        new Promise((resolve) => {
          attach = resolve;
        }),
    });
    h.desk(state('staged'));
    h.desk(RESULT());
    await flush();
    expect(h.stores).toEqual(['staged']);
    const closing = h.bridge.close();
    h.desk(state('final', 'save-1'));
    await closing;
    expect(h.closed()).toBe(1);
    expect(h.stores).toEqual(['staged', 'final']);
    const statuses = h.statuses.length;
    attach({ ok: true, message: 'Attached 1 reference.', shots: [{ shotId: SHOT, ok: true }] });
    await flush();
    expect(h.toasts).toContainEqual(['Attached 1 reference.', 'success']);
    // the port is closed: no result-ack, and a closed panel reports no status
    expect(h.posted().filter((m) => m.type === 'result-ack')).toEqual([]);
    expect(h.statuses).toHaveLength(statuses);
  });

  it('waits at most 10 seconds for the last write, then aborts it and says so', async () => {
    const h = await opened({ store: stalled });
    h.desk(state('staged'));
    const closing = h.bridge.close();
    // no answer to save: after 5 seconds the newest state, which stalls
    await vi.advanceTimersByTimeAsync(5_000 + DESK_CLOSE_STORE_TIMEOUT_MS - 1);
    expect(h.closed()).toBe(0);
    expect(h.last()).toMatchObject({ phase: 'closing', line: 'Storing the desk…' });
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(h.closed()).toBe(1);
    expect(h.stores).toEqual(['staged']);
    expect(h.signals[0]?.aborted).toBe(true);
    await flush();
    expect(h.toasts).toEqual([['The desk could not be stored: it took longer than 10 seconds', 'error']]);
    expect(h.last().phase).toBe('closed');
  });

  it('stores the newest state when the panel goes away without Close, and does not wait for it', async () => {
    let finish!: (sha: string) => void;
    const h = await opened({
      store: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    h.desk(state('unsent'));
    const statuses = h.statuses.length;
    h.bridge.flush();
    h.bridge.dispose();
    await flush();
    expect(h.stores).toEqual(['unsent']);
    // it outlives the panel: nothing aborts it
    expect(h.signals[0]).toBeUndefined();
    finish('unsent');
    await flush();
    expect(h.statuses).toHaveLength(statuses);
    expect(h.closed()).toBe(0);
    expect(h.port.close).toHaveBeenCalled();
  });

  it('stores nothing on the way out when the newest state is stored already', async () => {
    const h = await opened({ stored: stored('same') });
    h.desk(state('same'));
    h.bridge.flush();
    h.bridge.dispose();
    await flush();
    expect(h.stores).toEqual([]);
  });

  it('a disposed bridge reports no status', async () => {
    let reject!: (err: Error) => void;
    const h = harness({
      load: () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    });
    h.bridge.start();
    await flush();
    const statuses = h.statuses.length;
    h.bridge.dispose();
    reject(new Error('Failed to fetch'));
    await flush();
    h.bridge.frameLoaded();
    h.bridge.retry();
    expect(h.statuses).toHaveLength(statuses);
  });
});

describe('the desk bridge with the real sha256 and api.deskState', () => {
  async function withServer(storedContent: string, etag: (hash: string) => string) {
    const data = bytes(storedContent);
    const hash = await sha256Hex(data);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const fetch = vi.fn(
      async () =>
        new Response(data.slice(0), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            etag: etag(hash),
            'x-desk-state-format': FORMAT,
            'x-desk-state-version': '1',
          },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const h = harness({ load: () => api.deskState('prj_0000000000000001', SCENE), sha256: null });
    h.bridge.start();
    h.bridge.frameLoaded();
    h.hello();
    h.desk(READY);
    await vi.waitFor(() => expect(h.opens()).toHaveLength(1));
    h.desk({ ...OPENED, source: 'state' });
    return { h, fetch };
  }

  it.each([
    ['a strong ETag', (hash: string) => `"${hash}"`],
    ['a weak ETag', (hash: string) => `W/"${hash}"`],
  ])('stores nothing for a desk opened and closed without an edit (%s)', async (_case, etag) => {
    const { h, fetch } = await withServer('the same scene', etag);
    expect(text(h.opens()[0]?.message.state?.data as ArrayBuffer)).toBe('the same scene');
    // the desk sends the same bytes again for an unchanged scene
    h.desk(state('the same scene'));
    const closing = h.bridge.close();
    h.desk(state('the same scene', 'save-1'));
    await closing;
    expect(h.stores).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.closed()).toBe(1);
  });

  it('stores an edited scene', async () => {
    const { h } = await withServer('the scene', (hash) => `"${hash}"`);
    h.desk(state('the scene, edited'));
    const closing = h.bridge.close();
    h.desk(state('the scene, edited', 'save-1'));
    await closing;
    expect(h.stores).toEqual(['the scene, edited']);
  });
});

describe('the desk bridge: messages', () => {
  it('answers bad_message for an invalid message with an id; ignores unknown types and invalid ones without', async () => {
    const h = await opened();
    const before = h.port.postMessage.mock.calls.length;
    h.desk({ type: 'progress', id: 'exp-1', phase: 'render', done: -1, total: 10 });
    expect(h.port.postMessage.mock.calls.length).toBe(before + 1);
    expect(h.posted().at(-1)).toMatchObject({ type: 'error', id: 'exp-1', code: 'bad_message' });
    expect(h.posted().at(-1)?.message).toMatch(/^progress: done/);
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

  it('applies results one at a time, and a result that throws does not stop the next', async () => {
    let calls = 0;
    const h = await opened({
      applyResult: async (r) => {
        calls++;
        if (r.id === 'desk-1') throw new Error('the upload failed');
        return { ok: true, message: 'Attached 1 reference.', shots: [{ shotId: SHOT, ok: true }] };
      },
    });
    h.desk(RESULT('desk-1'));
    h.desk(RESULT('desk-2'));
    await flush();
    expect(calls).toBe(2);
    expect(h.posted().filter((m) => m.type === 'result-ack')).toEqual([
      {
        type: 'result-ack',
        id: 'desk-1',
        ok: false,
        message: 'The result was not applied: the upload failed',
        shots: [],
      },
      {
        type: 'result-ack',
        id: 'desk-2',
        ok: true,
        message: 'Attached 1 reference.',
        shots: [{ shotId: SHOT, ok: true }],
      },
    ]);
  });

  it("says why the browser cannot render the clips, and shows the desk's progress and errors (as toasts too)", async () => {
    const h = harness();
    h.bridge.start();
    h.bridge.frameLoaded();
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
    // the stored state the desk could not read: the line until opened follows at once, the toast stays
    h.desk({ type: 'error', code: 'state_unreadable', message: 'the state is of another scene' });
    expect(h.last().line).toBe('The stored desk could not be read: the state is of another scene');
    h.desk(OPENED);
    expect(h.last()).toMatchObject({ phase: 'open', line: 'Opened from the brief' });
    expect(h.toasts).toEqual([
      ['The stored desk could not be read: the state is of another scene', 'warning'],
    ]);
    h.desk({ type: 'progress', id: 'desk-2', phase: 'encode', done: 12, total: 72 });
    expect(h.last().line).toBe('Rendering the clips: encoding 12 of 72');
    // a shot the desk could not render, named after the result
    h.desk({
      type: 'error',
      id: 'desk-2',
      code: 'export_failed',
      message: 'S2 was not rendered: the encoder stopped.',
    });
    expect(h.last().line).toBe('S2 was not rendered: the encoder stopped.');
    expect(h.toasts.at(-1)).toEqual(['S2 was not rendered: the encoder stopped.', 'warning']);
  });

  it('cuts the text the desk supplies to 300 characters in the status line and toasts', async () => {
    const h = harness();
    h.bridge.start();
    h.bridge.frameLoaded();
    h.hello();
    h.desk({
      ...READY,
      capabilities: {
        ...READY.capabilities,
        export: { ...READY.capabilities.export, available: false, reason: 'r'.repeat(5000) },
      },
    });
    await flush();
    const unavailable = h.last().exportUnavailable as string;
    expect(unavailable.startsWith('This browser cannot render the reference clips: rrr')).toBe(true);
    expect(unavailable.length).toBe('This browser cannot render the reference clips: '.length + 300);
    expect(unavailable.endsWith('…')).toBe(true);
    h.desk({ type: 'error', code: 'export_failed', message: 'm'.repeat(5000) });
    expect(h.last().line).toHaveLength(300);
    expect(h.toasts.at(-1)?.[0]).toHaveLength(300);
  });

  it('ignores the states of another scene', async () => {
    const h = await opened();
    h.desk({ ...state('other'), sceneId: 'clp_0000000000000002' });
    h.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(h.stores).toEqual([]);
  });
});

import {
  DESK_CLOSE_STORE_TIMEOUT_MS,
  DESK_HELLO_TIMEOUT_MS,
  DESK_STATE_WRITE_INTERVAL_MS,
  DESK_STORE_RETRY_MS,
  type DeskBrief,
  type DeskBriefOptions,
  type DeskResultMessage,
  type DeskState,
  type DeskStateUnitUse,
  type DeskUnitPublishMessage,
  formatDeskStateUnits,
  HostToDeskMessageSchema,
  parseDeskStateUnits,
} from '@rideo/shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  DESK_CLEARED_NOTICE,
  DESK_CONFLICT_NOTICE,
  DESK_SAVE_TIMEOUT_MS,
  DeskBridge,
  type DeskOpenedWith,
  type DeskSentState,
  DeskStateConflict,
  type DeskStatus,
  type DeskStorePrecondition,
  type DeskUnitPublishOutcome,
  type DeskUnitsHost,
  deskUnreadableNotice,
  type StoredDeskState,
  sha256Hex,
} from '../src/features/desk/bridge';
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
    store?: (
      state: DeskState,
      signal?: AbortSignal,
      precondition?: DeskStorePrecondition,
      units?: readonly DeskStateUnitUse[] | null,
    ) => Promise<string>;
    /** what Start over's DELETE does; by default it succeeds */
    clear?: () => Promise<void>;
    applyResult?: (result: DeskResultMessage, opened: DeskOpenedWith) => Promise<DeskAck>;
    /** the states this tab sent for the clip, shared by the clip's panels (`deskStatesSent`) */
    sent?: Map<string, DeskSentState>;
    /** the clip's brief (by default `brief()`), given the brief options of the open */
    brief?: (options?: DeskBriefOptions) => DeskBrief;
    /** library units: the studio offers them */
    units?: DeskUnitsHost;
    readOnly?: boolean;
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
  /** The state each write named as the one it replaces. */
  const preconditions: DeskStorePrecondition[] = [];
  /** What each write said the state uses (`X-Desk-State-Units`). */
  const unitsStored: (readonly DeskStateUnitUse[] | null | undefined)[] = [];
  const toasts: [string, string][] = [];
  let closed = 0;
  const bridge = new DeskBridge({
    url: DESK_URL,
    host,
    frame: () => deskWindow,
    brief: opts.brief ?? brief,
    options: () => ({
      hostName: 'Rideo',
      modes: ['camera', 'motion', 'pose'],
      defaultMode: 'camera',
      readOnly: opts.readOnly ?? false,
    }),
    load: opts.load ?? (async () => opts.stored ?? null),
    store: async (s, precondition, signal, units) => {
      events.push(`store ${text(s.data)}`);
      stores.push(text(s.data));
      signals.push(signal);
      preconditions.push(precondition);
      unitsStored.push(units);
      return opts.store ? opts.store(s, signal, precondition, units) : text(s.data);
    },
    clear: async () => {
      events.push('clear');
      return opts.clear?.();
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
    ...(opts.sent ? { sent: opts.sent } : {}),
    ...(opts.units ? { units: opts.units } : {}),
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
    preconditions,
    unitsStored,
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

/**
 * A server that applies the desk-state route's precondition rules (docs/design/director-desk.md#the-routes): the same
 * bytes accepted whatever the precondition, `If-Match` holding only for the stored state (`*` for any), `If-None-Match:
 * *` only when none is stored; a `412` names the stored state. Its "ETag" is the state's text, as the harness hashes.
 */
function deskServer(initial: string | null) {
  const server = {
    stored: initial,
    store: async (s: DeskState, pre?: DeskStorePrecondition): Promise<string> => {
      const data = text(s.data);
      if (data === server.stored) return data;
      const holds = !pre
        ? true
        : 'ifMatch' in pre
          ? server.stored !== null && (pre.ifMatch === '*' || pre.ifMatch === server.stored)
          : server.stored === null;
      if (!holds) throw new DeskStateConflict(server.stored);
      server.stored = data;
      return data;
    },
  };
  return server;
}

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
    // state_unreadable when rideo handed over no state: nothing stored to keep, the line until opened, the toast stays
    expect(h.opens()[0]?.message.state).toBeNull();
    h.desk({ type: 'error', code: 'state_unreadable', message: 'the state is of another scene' });
    expect(h.last()).toMatchObject({
      line: 'The desk could not read the state: the state is of another scene',
    });
    h.desk(OPENED);
    expect(h.last()).toMatchObject({ phase: 'open', line: 'Opened from the brief', kept: null });
    expect(h.toasts).toEqual([
      ['The desk could not read the state: the state is of another scene', 'warning'],
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

describe('the desk bridge: a stored state that is kept (docs/design/director-desk.md#when-rideo-stores-it)', () => {
  const UNREADABLE = deskUnreadableNotice('saved by a newer desk');

  /**
   * A desk that cannot read the state handed over: `state_unreadable`, `opened` from the brief, and (an older desk)
   * its staging at once; the desk of the fix round sends no state until the person edits (`staging: false`).
   */
  async function unreadable(opts: Parameters<typeof harness>[0] = {}, staging = true) {
    const h = harness({ stored: stored('S-newer-desk-format'), ...opts });
    h.bridge.start();
    h.bridge.frameLoaded();
    h.hello();
    h.desk(READY);
    await flush();
    expect(text(h.opens()[0]?.message.state?.data as ArrayBuffer)).toBe('S-newer-desk-format');
    h.desk({ type: 'error', code: 'state_unreadable', message: 'saved by a newer desk' });
    h.desk(OPENED);
    if (staging) h.desk(state('staged from the brief'));
    return h;
  }

  it('says the stored state was kept, and stores nothing after 10 minutes, before a result or on the way out', async () => {
    const h = await unreadable();
    expect(h.last()).toMatchObject({
      phase: 'open',
      line: 'Opened from the brief',
      kept: { reason: 'unreadable', notice: UNREADABLE },
    });
    expect(h.toasts).toEqual([[UNREADABLE, 'warning']]);
    h.desk(state('edited'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS * 3);
    // a result is applied all the same, without the write before it
    h.desk(RESULT());
    await flush();
    expect(h.events).toEqual(['apply desk-1']);
    h.bridge.flush();
    h.bridge.dispose();
    await flush();
    expect(h.stores).toEqual([]);
  });

  it('Close closes without asking the desk for its state and without a write; so does the desk own close', async () => {
    const h = await unreadable();
    h.desk(state('edited'));
    await h.bridge.close();
    expect(h.posted().map((m) => m.type)).not.toContain('save');
    expect(h.stores).toEqual([]);
    expect(h.closed()).toBe(1);
    const done = await unreadable();
    done.desk(state('edited'));
    done.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(done.stores).toEqual([]);
    expect(done.closed()).toBe(1);
  });

  it('Replace stores the newest state over the loaded one, and later states as usual', async () => {
    const h = await unreadable();
    h.desk(state('edited'));
    h.bridge.replace();
    await flush();
    expect(h.last().kept).toBeNull();
    expect(h.stores).toEqual(['edited']);
    // the write names the state it replaces, the one the panel loaded, and is marked as a Replace
    expect(h.preconditions).toEqual([{ ifMatch: 'S-newer-desk-format', replace: true }]);
    h.desk(state('later'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.stores).toEqual(['edited', 'later']);
    const closing = h.bridge.close();
    h.desk(state('final', 'save-1'));
    await closing;
    expect(h.stores).toEqual(['edited', 'later', 'final']);
    // later writes as usual: no Replace
    expect(h.preconditions.slice(1)).toEqual([{ ifMatch: 'edited' }, { ifMatch: 'later' }]);
  });

  it('Replace asks a desk that sent no state yet for the one it holds, and stores that', async () => {
    const h = await unreadable({}, false);
    expect(h.last().kept).toMatchObject({ reason: 'unreadable' });
    // nothing to store yet: the desk sends no state after it could not read the one handed over
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.stores).toEqual([]);
    h.bridge.replace();
    expect(h.posted().at(-1)).toEqual({ type: 'save', id: 'save-1' });
    await flush();
    expect(h.stores).toEqual([]);
    h.desk(state('staged from the brief', 'save-1'));
    await flush();
    expect(h.stores).toEqual(['staged from the brief']);
    expect(h.preconditions).toEqual([{ ifMatch: 'S-newer-desk-format', replace: true }]);
    expect(h.last().kept).toBeNull();
    // a desk that answers Replace's save with an error: nothing stored, the next state stored as usual
    const refused = await unreadable({}, false);
    refused.bridge.replace();
    refused.desk({ type: 'error', id: 'save-1', code: 'not_open', message: 'No scene is open yet' });
    await flush();
    expect(refused.stores).toEqual([]);
    expect(refused.toasts.map(([t]) => t)).not.toContain('No scene is open yet');
    refused.desk(state('edited'));
    const closing = refused.bridge.close();
    expect(refused.posted().at(-1)).toEqual({ type: 'save', id: 'save-2' });
    refused.desk(state('edited', 'save-2'));
    await closing;
    expect(refused.stores).toEqual(['edited']);
  });

  it('keeps nothing for state_unreadable after an open that handed over no state', async () => {
    const h = await opened();
    h.desk({ type: 'error', code: 'state_unreadable', message: 'odd' });
    h.desk(state('staged'));
    h.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(h.last().kept).toBeNull();
    expect(h.stores).toEqual(['staged']);
  });

  it('names the state each write replaces: none stored, the ETag loaded or stored, the bytes when the ETag is missing', async () => {
    const none = await opened();
    none.desk(state('a'));
    none.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(none.preconditions).toEqual([{ ifNoneMatch: '*' }]);
    const loaded = await opened({ stored: stored('b') });
    loaded.desk(state('c'));
    loaded.desk(RESULT());
    await flush();
    loaded.desk(state('d'));
    loaded.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(loaded.preconditions).toEqual([{ ifMatch: 'b' }, { ifMatch: 'c' }]);
    // an answer without an ETag: the loaded bytes' own sha256, else any stored state
    const bare = await opened({ stored: stored('e', '') });
    bare.desk(state('f'));
    bare.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(bare.preconditions).toEqual([{ ifMatch: 'e' }]);
    const blind = await opened({
      stored: stored('e', ''),
      sha256: async () => {
        throw new Error('crypto.subtle is not available');
      },
    });
    blind.desk(state('f'));
    blind.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(blind.preconditions).toEqual([{ ifMatch: '*' }]);
  });

  it('a write refused because another session stored a newer state keeps it: no retry, no write on Close', async () => {
    const h = await opened({
      stored: stored('mine'),
      store: async () => {
        throw new DeskStateConflict('theirs');
      },
    });
    h.desk(state('edit'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.stores).toEqual(['edit']);
    expect(h.last()).toMatchObject({
      line: 'The desk was not stored',
      kept: { reason: 'conflict', notice: DESK_CONFLICT_NOTICE },
    });
    expect(h.toasts).toEqual([[DESK_CONFLICT_NOTICE, 'warning']]);
    // not tried again: no backoff, no 10 minutes, nothing before a result
    h.desk(state('edit 2'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS * 3);
    h.desk(RESULT());
    await flush();
    expect(h.stores).toEqual(['edit']);
    await h.bridge.close();
    expect(h.stores).toEqual(['edit']);
    expect(h.closed()).toBe(1);
  });

  it('Replace names the ETag the conflict gave: a state a third session stored meanwhile is refused again', async () => {
    // the server's state: rideo's write holds only when it names it
    let server: string | null = 'theirs';
    const h = await opened({
      stored: stored('mine'),
      store: async (s, _signal, pre) => {
        const named = pre && 'ifMatch' in pre ? pre.ifMatch : null;
        if (named !== server) throw new DeskStateConflict(server);
        server = text(s.data);
        return server;
      },
    });
    h.desk(state('edit'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.last().kept?.reason).toBe('conflict');
    server = 'third';
    h.bridge.replace();
    await flush();
    expect(h.last().kept?.reason).toBe('conflict');
    h.bridge.replace();
    await flush();
    expect(h.last().kept).toBeNull();
    expect(server).toBe('edit');
    expect(h.preconditions).toEqual([
      { ifMatch: 'mine' },
      { ifMatch: 'theirs', replace: true },
      { ifMatch: 'third', replace: true },
    ]);
    expect(h.toasts).toEqual([
      [DESK_CONFLICT_NOTICE, 'warning'],
      [DESK_CONFLICT_NOTICE, 'warning'],
    ]);
  });

  it("a Close whose last write meets another session's state keeps the panel open; Close again closes", async () => {
    const h = await opened({
      stored: stored('mine'),
      store: async () => {
        throw new DeskStateConflict('theirs');
      },
    });
    h.desk(state('edit'));
    const closing = h.bridge.close();
    h.desk(state('final', 'save-1'));
    await closing;
    expect(h.closed()).toBe(0);
    expect(h.last()).toMatchObject({
      phase: 'open',
      line: 'The desk was not stored',
      kept: { reason: 'conflict' },
    });
    expect(h.port.close).not.toHaveBeenCalled();
    await h.bridge.close();
    expect(h.stores).toEqual(['final']);
    expect(h.closed()).toBe(1);
    // the desk's own Done too
    const done = await opened({
      stored: stored('mine'),
      store: async () => {
        throw new DeskStateConflict(null);
      },
    });
    done.desk(state('last'));
    done.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(done.closed()).toBe(0);
    expect(done.last().kept).toEqual({ reason: 'cleared', notice: DESK_CLEARED_NOTICE });
  });

  it('a conflict on the way out of the panel is said in a toast', async () => {
    const h = await opened({
      stored: stored('mine'),
      store: async () => {
        throw new DeskStateConflict('theirs');
      },
    });
    h.desk(state('edit'));
    h.bridge.flush();
    h.bridge.dispose();
    await flush();
    expect(h.stores).toEqual(['edit']);
    expect(h.toasts).toEqual([[DESK_CONFLICT_NOTICE, 'warning']]);
  });

  it("shows the desk's own message as a sentence of its own, and toasts it once however often a desk page that loads again says it", async () => {
    // the real desk's message is a whole sentence: no nested parentheses
    expect(
      deskUnreadableNotice(
        'The stored desk state was not applied (it was written by version 2 of the desk); the scene was staged from the brief.',
      ),
    ).toBe(
      'The stored desk state was kept. The stored desk state was not applied (it was written by version 2 of the desk); the scene was staged from the brief. Changes made here are not stored until you replace it.',
    );
    expect(UNREADABLE).toBe(
      'The stored desk state was kept. Saved by a newer desk. Changes made here are not stored until you replace it.',
    );
    const h = await unreadable({}, false);
    expect(h.last().kept).toEqual({ reason: 'unreadable', notice: UNREADABLE });
    expect(h.toasts).toEqual([[UNREADABLE, 'warning']]);
    // the desk page loads again: connected again, handed the stored state again, and it says so again
    h.bridge.frameLoaded();
    h.hello();
    h.desk(READY);
    await flush();
    expect(h.opens().map((o) => text(o.message.state?.data as ArrayBuffer))).toEqual([
      'S-newer-desk-format',
      'S-newer-desk-format',
    ]);
    h.desk({ type: 'error', code: 'state_unreadable', message: 'saved by a newer desk' });
    h.desk(OPENED);
    expect(h.last().kept).toEqual({ reason: 'unreadable', notice: UNREADABLE });
    expect(h.toasts).toEqual([[UNREADABLE, 'warning']]);
  });

  it('a 412 without an ETag says another session cleared the stored state; Replace stores over none', async () => {
    const server = deskServer('mine');
    const h = await opened({ stored: stored('mine'), store: (s, _signal, pre) => server.store(s, pre) });
    server.stored = null;
    h.desk(state('edit'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.last().kept).toEqual({ reason: 'cleared', notice: DESK_CLEARED_NOTICE });
    expect(DESK_CLEARED_NOTICE).toBe(
      'Another session cleared the stored desk state of this clip: changes made here are not stored until you replace it.',
    );
    expect(h.toasts).toEqual([[DESK_CLEARED_NOTICE, 'warning']]);
    // a 412 that names a state: changed, never "newer" (a restore can be the cause)
    expect(DESK_CONFLICT_NOTICE).not.toMatch(/newer/);
    expect(DESK_CONFLICT_NOTICE).toContain('changes made here are not stored until you replace it');
    expect(DESK_CONFLICT_NOTICE).toContain(
      "If it is another staging of the scene, the desk drops this browser's copy the next time it opens unless you replace it.",
    );
    h.bridge.replace();
    await flush();
    expect(server.stored).toBe('edit');
    expect(h.preconditions).toEqual([{ ifMatch: 'mine' }, { ifNoneMatch: '*', replace: true }]);
  });

  it("a Close holds the panel when a write already on its way meets another session's state; Close again closes", async () => {
    let refuse!: (err: unknown) => void;
    const h = await opened({
      stored: stored('mine'),
      store: () =>
        new Promise<string>((_resolve, reject) => {
          refuse = reject;
        }),
    });
    h.desk(state('edit'));
    // the 10 minutes' write is uploading when the person presses Close
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.stores).toEqual(['edit']);
    const closing = h.bridge.close();
    h.desk(state('final', 'save-1'));
    await flush();
    refuse(new DeskStateConflict('theirs'));
    await closing;
    // the last write stored nothing (the stored state is kept now), and the person decides
    expect(h.stores).toEqual(['edit']);
    expect(h.closed()).toBe(0);
    expect(h.last()).toMatchObject({
      phase: 'open',
      line: 'The desk was not stored',
      kept: { reason: 'conflict', notice: DESK_CONFLICT_NOTICE },
    });
    await h.bridge.close();
    expect(h.stores).toEqual(['edit']);
    expect(h.closed()).toBe(1);
  });

  it("Replace waits for the desk's answer to its save however long it takes, and stores it at once", async () => {
    const h = await unreadable({}, false);
    h.bridge.replace();
    expect(h.posted().at(-1)).toEqual({ type: 'save', id: 'save-1' });
    // a large scene: the desk answers after twice the 5 seconds Close would wait
    await vi.advanceTimersByTimeAsync(DESK_SAVE_TIMEOUT_MS * 2);
    expect(h.stores).toEqual([]);
    h.desk(state('staged from the brief', 'save-1'));
    await flush();
    expect(h.stores).toEqual(['staged from the brief']);
    expect(h.preconditions).toEqual([{ ifMatch: 'S-newer-desk-format', replace: true }]);
    // a state the desk sends before it answers is the first after Replace: stored at once too
    const first = await unreadable({}, false);
    first.bridge.replace();
    first.desk(state('edited'));
    await flush();
    expect(first.stores).toEqual(['edited']);
    first.desk(state('edited', 'save-1'));
    await flush();
    expect(first.stores).toEqual(['edited']);
  });
});

describe("the desk bridge: a 412 of this tab's own (docs/design/director-desk.md#when-rideo-stores-it)", () => {
  it('the lost answer: a write that reached the server unanswered is taken as the stored state, no conflict', async () => {
    const server = deskServer('S1');
    let lose = true;
    const h = await opened({
      stored: stored('S1'),
      store: async (s, _signal, pre) => {
        const got = await server.store(s, pre);
        // the 10 minutes' write lands, and its answer is lost on the way back (a dropped network, a proxy's 504)
        if (lose) {
          lose = false;
          throw new TypeError('Failed to fetch');
        }
        return got;
      },
    });
    h.desk(state('A'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(server.stored).toBe('A');
    h.desk(state('B'));
    // tried again 30 seconds later naming S1: the 412 names A, which this panel sent
    await vi.advanceTimersByTimeAsync(DESK_STORE_RETRY_MS);
    expect(server.stored).toBe('B');
    expect(h.preconditions).toEqual([{ ifMatch: 'S1' }, { ifMatch: 'S1' }, { ifMatch: 'A' }]);
    expect(h.last().kept).toBeNull();
    expect(h.toasts).toEqual([['The desk could not be stored: Failed to fetch', 'error']]);
    // and later states name B as usual
    h.desk(state('C'));
    h.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(server.stored).toBe('C');
    expect(h.preconditions.at(-1)).toEqual({ ifMatch: 'B' });
    expect(h.closed()).toBe(1);
  });

  it("a panel opened again while the last one's write on the way out was uploading: that write lands first, the new panel's Close stores over it", async () => {
    const server = deskServer('S1');
    const sent = new Map<string, DeskSentState>();
    let land!: () => Promise<void>;
    // panel A: an edit, then the person leaves the Storyboard view; its write on the way out uploads slowly
    const a = await opened({
      stored: stored('S1'),
      sent,
      store: (s, _signal, pre) =>
        new Promise<string>((resolve, reject) => {
          land = () => server.store(s, pre).then(resolve, reject);
        }),
    });
    a.desk(state('A'));
    a.bridge.flush();
    a.bridge.dispose();
    await flush();
    // the person comes back: panel B loads S1, then A's write lands
    const b = await opened({ stored: stored('S1'), sent, store: (s, _signal, pre) => server.store(s, pre) });
    await land();
    expect(server.stored).toBe('A');
    b.desk(state('B'));
    const closing = b.bridge.close();
    b.desk(state('B', 'save-1'));
    await closing;
    // the 412 named A, which this tab sent: no conflict, B stored over it and the panel closed
    expect(server.stored).toBe('B');
    expect(b.preconditions).toEqual([{ ifMatch: 'S1' }, { ifMatch: 'A' }]);
    expect(b.closed()).toBe(1);
    expect(b.last().kept).toBeNull();
    expect([...a.toasts, ...b.toasts]).toEqual([]);
  });

  it("a write sent after the next panel's load went out stays its own though that load names an older state: it lands late, and the next panel stores over it", async () => {
    const server = deskServer('S1');
    const sent = new Map<string, DeskSentState>();
    let land!: () => Promise<void>;
    // panel A: Q stored, then X over Q on the way out, which uploads slowly
    const a = await opened({
      stored: stored('S1'),
      sent,
      store: (s, _signal, pre) =>
        text(s.data) === 'X'
          ? new Promise<string>((resolve, reject) => {
              land = () => server.store(s, pre).then(resolve, reject);
            })
          : server.store(s, pre),
    });
    // panel B of the clip starts first: its load reads S1, and its answer comes late
    let answer!: () => void;
    const b = harness({
      sent,
      store: (s, _signal, pre) => server.store(s, pre),
      load: async () => {
        const held = server.stored;
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return held === null ? null : stored(held);
      },
    });
    b.bridge.start();
    await flush();
    a.desk(state('Q'));
    a.bridge.flush();
    await flush();
    expect(server.stored).toBe('Q');
    a.desk(state('X'));
    a.bridge.flush();
    a.bridge.dispose();
    await flush();
    // B learns of S1, which the server held before Q: X, sent after B's load went out, may still land, and does
    answer();
    await flush();
    await land();
    expect(server.stored).toBe('X');
    b.bridge.frameLoaded();
    b.hello();
    b.desk(READY);
    await flush();
    b.desk(OPENED);
    b.desk(state('W'));
    const closing = b.bridge.close();
    b.desk(state('W', 'save-1'));
    await closing;
    // the 412 named X, which this tab sent: no conflict, W stored over it
    expect(server.stored).toBe('W');
    expect(b.preconditions).toEqual([{ ifMatch: 'S1' }, { ifMatch: 'X' }]);
    expect(b.last().kept).toBeNull();
    expect(b.closed()).toBe(1);
    expect([...a.toasts, ...b.toasts]).toEqual([]);
  });

  it("a panel opened again while the last one's write on the way out was uploading: the new panel's write lands first, the old one is dropped without a toast", async () => {
    const server = deskServer('S1');
    const sent = new Map<string, DeskSentState>();
    let land!: () => Promise<void>;
    const a = await opened({
      stored: stored('S1'),
      sent,
      store: (s, _signal, pre) =>
        new Promise<string>((resolve, reject) => {
          land = () => server.store(s, pre).then(resolve, reject);
        }),
    });
    a.desk(state('A'));
    a.bridge.flush();
    a.bridge.dispose();
    await flush();
    const b = await opened({ stored: stored('S1'), sent, store: (s, _signal, pre) => server.store(s, pre) });
    b.desk(state('B'));
    const closing = b.bridge.close();
    b.desk(state('B', 'save-1'));
    await closing;
    expect(server.stored).toBe('B');
    // A's write lands now: its 412 names B, which the later panel sent; A's older state never replaces it
    await land().catch(() => undefined);
    await flush();
    expect(server.stored).toBe('B');
    expect(a.preconditions).toEqual([{ ifMatch: 'S1' }]);
    expect([...a.toasts, ...b.toasts]).toEqual([]);
  });

  it('a 412 naming a state of its own is tried once: another such 412 keeps the stored state', async () => {
    // states an earlier panel of the clip sent, whose answers it never got: X over S1, then Y over X
    const sent = new Map<string, DeskSentState>([
      ['X', { generation: 0, sentAt: 0, answeredAt: null, over: 'S1' }],
      ['Y', { generation: 0, sentAt: 0, answeredAt: null, over: 'X' }],
    ]);
    const answers = ['X', 'Y'];
    const h = await opened({
      stored: stored('S1'),
      sent,
      store: async () => {
        throw new DeskStateConflict(answers.shift() ?? 'Z');
      },
    });
    h.desk(state('B'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.preconditions).toEqual([{ ifMatch: 'S1' }, { ifMatch: 'X' }]);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
  });
});

describe('the desk bridge: a state this tab sent that the server moved past (docs/design/director-desk.md#when-rideo-stores-it)', () => {
  const through =
    (server: ReturnType<typeof deskServer>) =>
    (s: DeskState, _signal?: AbortSignal, pre?: DeskStorePrecondition) =>
      server.store(s, pre);

  it("is no longer its own once a later write of this tab stored another: another session's restore of it is a conflict", async () => {
    const server = deskServer('S1');
    const h = await opened({ stored: stored('S1'), store: through(server) });
    h.desk(state('X'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    h.desk(state('Z'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(server.stored).toBe('Z');
    // another session restores the clip's history to the commit that named X, while this panel is open
    server.stored = 'X';
    h.desk(state('W'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    // the restore is kept and said, never stored over unseen
    expect(server.stored).toBe('X');
    expect(h.preconditions).toEqual([{ ifMatch: 'S1' }, { ifMatch: 'X' }, { ifMatch: 'Z' }]);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
    expect(h.toasts).toEqual([[DESK_CONFLICT_NOTICE, 'warning']]);
  });

  it("is no longer its own once a later panel's load found another state stored: a restore of it is a conflict", async () => {
    const server = deskServer('S1');
    const sent = new Map<string, DeskSentState>();
    // panel A stores X on Close
    const a = await opened({ stored: stored('S1'), sent, store: through(server) });
    a.desk(state('X'));
    const closing = a.bridge.close();
    a.desk(state('X', 'save-1'));
    await closing;
    expect(server.stored).toBe('X');
    // another session stores Y, and the clip's next panel in this tab opens on it
    server.stored = 'Y';
    const b = await opened({ stored: stored('Y'), sent, store: through(server) });
    // then another session restores the clip to X: B's next write meets it
    server.stored = 'X';
    b.desk(state('W'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(server.stored).toBe('X');
    expect(b.preconditions).toEqual([{ ifMatch: 'Y' }]);
    expect(b.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
  });

  it("is no longer its own once a later panel's Start over cleared the stored state: a restore of it is a conflict", async () => {
    const server = deskServer('S1');
    const sent = new Map<string, DeskSentState>();
    const a = await opened({ stored: stored('S1'), sent, store: through(server) });
    a.desk(state('X'));
    const closing = a.bridge.close();
    a.desk(state('X', 'save-1'));
    await closing;
    expect(server.stored).toBe('X');
    // the clip's next panel cannot load the stored state and starts over
    const b = harness({
      sent,
      store: through(server),
      load: async () => {
        throw new TypeError('the stored desk state of scene 1 could not be read: storage answered 404');
      },
      clear: async () => {
        server.stored = null;
      },
    });
    b.bridge.start();
    b.bridge.frameLoaded();
    b.hello();
    b.desk(READY);
    await flush();
    b.bridge.startOver();
    await flush();
    b.desk(OPENED);
    // another session restores the clip to X before B's first write
    server.stored = 'X';
    b.desk(state('W'));
    b.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(server.stored).toBe('X');
    expect(b.preconditions).toEqual([{ ifNoneMatch: '*' }]);
    expect(b.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
    expect(b.closed()).toBe(0);
  });

  it('is no longer its own once a 412 named another state: Replace meeting a restore of it refuses again', async () => {
    const server = deskServer('S1');
    const h = await opened({ stored: stored('S1'), store: through(server) });
    h.desk(state('S'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(server.stored).toBe('S');
    // another session stores E: this panel's next write is refused and E kept
    server.stored = 'E';
    h.desk(state('W'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
    // a third session restores S before the person replaces E: Replace names E and meets S, refused again
    server.stored = 'S';
    h.bridge.replace();
    await flush();
    expect(server.stored).toBe('S');
    expect(h.preconditions).toEqual([{ ifMatch: 'S1' }, { ifMatch: 'S' }, { ifMatch: 'E', replace: true }]);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
  });

  it('a state whose write was refused is not its own: the same bytes stored later by another session are a conflict', async () => {
    const server = deskServer('S1');
    const h = await opened({ stored: stored('S1'), store: through(server) });
    // another session stores Y: this panel's X is refused and the stored state kept
    server.stored = 'Y';
    h.desk(state('X'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
    // the person edits and replaces Y with Z
    h.desk(state('Z'));
    h.bridge.replace();
    await flush();
    expect(server.stored).toBe('Z');
    // X, which never landed from this tab, comes from another session: a conflict, not this tab's own
    server.stored = 'X';
    h.desk(state('W'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(server.stored).toBe('X');
    expect(h.preconditions).toEqual([{ ifMatch: 'S1' }, { ifMatch: 'Y', replace: true }, { ifMatch: 'Z' }]);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
  });

  it('a state whose write was refused is forgotten at once: the same bytes another session stored before Replace are refused again', async () => {
    const server = deskServer('S1');
    const h = await opened({ stored: stored('S1'), store: through(server) });
    // another session stores Y: this panel's X is refused and Y kept
    server.stored = 'Y';
    h.desk(state('X'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
    // a third session stores the same bytes X before the person replaces Y with Z
    server.stored = 'X';
    h.desk(state('Z'));
    h.bridge.replace();
    await flush();
    // the Replace named Y and met X, which never landed from this tab: refused again, X kept
    expect(server.stored).toBe('X');
    expect(h.preconditions).toEqual([{ ifMatch: 'S1' }, { ifMatch: 'Y', replace: true }]);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
  });

  it('a state whose write went unanswered is forgotten once an answer names another state than the one it replaces: Replace meeting its restore is refused again', async () => {
    const server = deskServer('S1');
    let lose = true;
    const h = await opened({
      stored: stored('S1'),
      store: async (s, _signal, pre) => {
        const got = await server.store(s, pre);
        if (lose) {
          lose = false;
          throw new TypeError('Failed to fetch');
        }
        return got;
      },
    });
    // A lands over S1, and its answer is lost
    h.desk(state('A'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(server.stored).toBe('A');
    // another session stores E before the write is tried again: B naming S1 meets E, a conflict
    server.stored = 'E';
    h.desk(state('B'));
    await vi.advanceTimersByTimeAsync(DESK_STORE_RETRY_MS);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
    // a third session restores A before the person replaces E: the Replace names E and meets A, refused again
    server.stored = 'A';
    h.bridge.replace();
    await flush();
    expect(server.stored).toBe('A');
    expect(h.preconditions).toEqual([{ ifMatch: 'S1' }, { ifMatch: 'S1' }, { ifMatch: 'E', replace: true }]);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
  });

  it('stays its own while its answer was lost: the lost write met later is taken, and forgotten once stored past', async () => {
    const server = deskServer('S1');
    let lose = true;
    const h = await opened({
      stored: stored('S1'),
      store: async (s, _signal, pre) => {
        const got = await server.store(s, pre);
        if (lose) {
          lose = false;
          throw new TypeError('Failed to fetch');
        }
        return got;
      },
    });
    h.desk(state('A'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    h.desk(state('B'));
    await vi.advanceTimersByTimeAsync(DESK_STORE_RETRY_MS);
    // the 412 named A, whose answer was lost: taken, and B stored over it
    expect(server.stored).toBe('B');
    expect(h.last().kept).toBeNull();
    // B was stored after A landed: A coming back now is a restore, and a conflict
    server.stored = 'A';
    h.desk(state('C'));
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(server.stored).toBe('A');
    expect(h.preconditions).toEqual([
      { ifMatch: 'S1' },
      { ifMatch: 'S1' },
      { ifMatch: 'A' },
      { ifMatch: 'B' },
    ]);
    expect(h.last().kept).toEqual({ reason: 'conflict', notice: DESK_CONFLICT_NOTICE });
  });
});

describe('the desk bridge: Start over (docs/design/director-desk.md#the-desk)', () => {
  it('clears a stored state that cannot be loaded and opens the desk without it', async () => {
    const h = harness({
      load: async () => {
        throw new TypeError('the stored desk state of scene 1 could not be read: storage answered 404');
      },
    });
    h.bridge.start();
    h.bridge.frameLoaded();
    h.hello();
    h.desk(READY);
    await flush();
    expect(h.last()).toMatchObject({ phase: 'failed', remedy: 'retry' });
    expect(h.opens()).toEqual([]);
    h.bridge.startOver();
    expect(h.last()).toMatchObject({ failure: null, remedy: null, line: 'Clearing the stored desk state…' });
    await flush();
    expect(h.events).toEqual(['clear']);
    expect(h.opens().map((o) => o.message.state)).toEqual([null]);
    h.desk(OPENED);
    expect(h.last()).toMatchObject({ phase: 'open', line: 'Opened from the brief' });
    // none is stored now: the next write says so
    h.desk(state('fresh'));
    h.desk({ type: 'close', reason: 'done' });
    await flush();
    expect(h.preconditions).toEqual([{ ifNoneMatch: '*' }]);
  });

  it('a clear that fails keeps the panel failed with Retry and Start over; nothing opened', async () => {
    const h = harness({
      load: async () => {
        throw new TypeError('Failed to fetch');
      },
      clear: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    h.bridge.start();
    h.bridge.frameLoaded();
    h.hello();
    h.desk(READY);
    await flush();
    h.bridge.startOver();
    await flush();
    expect(h.last()).toMatchObject({
      phase: 'failed',
      remedy: 'retry',
      failure: 'The stored desk state could not be cleared: Failed to fetch',
    });
    expect(h.opens()).toEqual([]);
  });

  it('offers nothing to start over once the desk is open', async () => {
    const h = await opened({ stored: stored('kept') });
    h.bridge.startOver();
    await flush();
    expect(h.events).toEqual([]);
  });
});

describe("the desk bridge: the desk's errors (docs/design/director-desk.md#the-protocol)", () => {
  it("toasts only the errors meant for the person; its answers to rideo's own requests go to the status line", async () => {
    const h = await opened();
    for (const code of ['not_open', 'bad_message', 'unsupported_version', 'busy', 'cancelled'])
      h.desk({ type: 'error', code, message: `${code} said` });
    expect(h.toasts).toEqual([]);
    expect(h.last().line).toBe('cancelled said');
    for (const code of ['export_failed', 'export_unavailable', 'out_of_memory', 'invalid_scene'])
      h.desk({ type: 'error', code, message: `${code} said` });
    expect(h.toasts).toEqual(
      ['export_failed', 'export_unavailable', 'out_of_memory', 'invalid_scene'].map((c) => [
        `${c} said`,
        'warning',
      ]),
    );
  });

  it('a Close while the desk still stages: its not_open answer to save is no toast', async () => {
    const h = harness();
    h.bridge.start();
    h.bridge.frameLoaded();
    h.hello();
    h.desk(READY);
    await flush();
    const closing = h.bridge.close();
    expect(h.posted().at(-1)).toEqual({ type: 'save', id: 'save-1' });
    h.desk({
      type: 'error',
      id: 'save-1',
      code: 'not_open',
      message: 'No scene is open yet: send open first.',
    });
    await closing;
    expect(h.toasts).toEqual([]);
    expect(h.closed()).toBe(1);
  });

  it('applies a result with the brief the desk was opened with and the shots its opened said the brief retimed', async () => {
    const applied: DeskOpenedWith[] = [];
    const h = harness({
      applyResult: async (_r, o) => {
        applied.push(o);
        return { ok: true, message: 'Attached 1 camera reference.', shots: [{ shotId: SHOT, ok: true }] };
      },
    });
    h.bridge.start();
    h.bridge.frameLoaded();
    h.hello();
    h.desk(READY);
    await flush();
    const changes = { added: [], removed: [], retimed: [SHOT], recast: [], cast: { added: [], removed: [] } };
    h.desk({ ...OPENED, source: 'state', changes });
    h.desk(RESULT());
    await flush();
    // the desk page loads again: its new opened says nothing was retimed (the person pressed Update shots)
    h.bridge.frameLoaded();
    h.hello();
    h.desk(READY);
    await flush();
    h.desk(OPENED);
    h.desk(RESULT('desk-2'));
    await flush();
    expect(applied).toEqual([
      { brief: brief(), retimed: [SHOT] },
      { brief: brief(), retimed: [] },
    ]);
  });
});

describe('the desk bridge: library units (docs/design/director-desk.md#library-units)', () => {
  const pin = (c: string, ref: string, version: number) => ({ ref, version, sha256: c.repeat(64) });
  const PINS = {
    set: pin('a', 'lib_000000000set1', 3),
    mira: pin('b', 'lib_00000000mira1', 2),
    lamp: pin('c', 'lib_00000000lamp1', 1),
  };
  /** The brief deskBrief makes: with the pins of the kinds announced when the open has units, without them else. */
  const pinned = (options?: DeskBriefOptions): DeskBrief => {
    const base = brief();
    const kinds = new Set(options?.units?.kinds ?? []);
    return {
      ...base,
      set: { ...base.set, ...(kinds.has('set') ? { unit: PINS.set } : {}) },
      cast: [
        {
          id: 'chr_mira',
          name: 'Mira',
          description: '',
          kind: null,
          heightM: null,
          ...(kinds.has('figure') ? { unit: PINS.mira } : {}),
        },
      ],
      elements: [
        {
          id: 'ele_lamp',
          name: 'Oil lamp',
          description: '',
          kind: 'prop',
          ...(kinds.has('prop') ? { unit: PINS.lamp } : {}),
        },
      ],
    };
  };
  const CAPABILITY = { versions: [1], kinds: ['set', 'prop', 'figure'], maxBytes: 33554432, publish: true };
  const READY_UNITS = { ...READY, capabilities: { ...READY.capabilities, units: CAPABILITY } };
  const ROW = (slot: string, p: { ref: string; version: number; sha256: string }, staged = 'unit') => ({
    slot,
    ...p,
    staged,
    local: false,
    ...(staged === 'pending' ? { why: 'missing' } : {}),
  });
  const PUBLISH = (id: string, over: Record<string, unknown> = {}) => ({
    type: 'unit-publish',
    id,
    kind: 'set',
    name: 'Harbor',
    from: { castId: null, elementId: null, set: true },
    unit: { format: '3d-editor.desk-unit', version: 1, data: bytes(`unit ${id}`) },
    sha256: 'd'.repeat(64),
    thumbnail: null,
    meta: {
      dimensionsM: [24, 18, 9.5],
      objects: 14,
      triangles: 5120,
      actor: null,
      credits: [],
      deskVersion: '0.2.0',
      digest: 'e'.repeat(64),
    },
    ...over,
  });
  const outcome = (m: DeskUnitPublishMessage, linked = true): DeskUnitPublishOutcome => ({
    ack: { type: 'unit-ack', id: m.id, ok: true, ref: 'lib_0000000harbor', version: 1, linked },
    notice: `Saved Harbor v1 to the library; ${linked ? "linked to the scene's place (Harbor)" : 'not linked'}`,
    level: linked ? 'success' : 'info',
  });

  /** The studio's side of units, recording what the bridge asks of it. */
  function studio(over: Partial<DeskUnitsHost> = {}) {
    const fetches: { slots: string[]; signal: AbortSignal }[] = [];
    const publishes: [DeskUnitPublishMessage, { readOnly: boolean }][] = [];
    const host: DeskUnitsHost = {
      mayPublish: () => true,
      storedUses: () => null,
      fetch: async (pins, progress, signal) => {
        fetches.push({ slots: pins.map((p) => p.slot), signal });
        pins.forEach((_, i) => {
          progress(i + 1, pins.length);
        });
        return {
          units: pins.map((p) => ({
            ref: p.pin.ref,
            version: p.pin.version,
            sha256: p.pin.sha256,
            unit: { format: '3d-editor.desk-unit', version: 1, data: bytes(`file of ${p.pin.ref}`) },
          })),
          left: [],
        };
      },
      publish: async (m, opened) => {
        publishes.push([m, opened]);
        return outcome(m);
      },
      ...over,
    };
    return { host, fetches, publishes };
  }

  /** Connected, and `ready` given (the desk's own capability), without its `opened` yet. */
  async function ready(opts: Parameters<typeof harness>[0], readyMessage: unknown = READY_UNITS) {
    const h = harness({ brief: pinned, ...opts });
    h.bridge.start();
    h.bridge.frameLoaded();
    h.hello();
    h.desk(readyMessage);
    await flush();
    return h;
  }

  it('gives a desk without the capability no options.units, no pins and no open.units: the open of before', async () => {
    const s = studio();
    const plain = await ready({ units: s.host, stored: stored('kept') }, READY);
    const [open] = plain.opens();
    expect(open!.message).not.toHaveProperty('units');
    expect((open!.message as unknown as { options: object }).options).not.toHaveProperty('units');
    expect(JSON.stringify((open!.message as unknown as { scene: unknown }).scene)).not.toContain('"unit"');
    // only the state's copy is transferred
    expect(open!.transfer).toHaveLength(1);
    // a capability rideo cannot use (only a newer version) reads as none, and ready still opens
    const newer = await ready(
      { units: s.host },
      { ...READY, capabilities: { ...READY.capabilities, units: { ...CAPABILITY, versions: [2] } } },
    );
    expect((newer.opens()[0]!.message as unknown as { options: object }).options).not.toHaveProperty('units');
    // a studio without units gives a desk with them none either
    const none = await ready({});
    expect(none.opens()[0]!.message).not.toHaveProperty('units');
    expect((none.opens()[0]!.message as unknown as { options: object }).options).not.toHaveProperty('units');
    expect(s.fetches).toEqual([]);
  });

  it('gives a desk with units options.units with publish, the pins, then the files in slot order, transferred', async () => {
    const s = studio();
    const h = await ready({ units: s.host, stored: stored('kept') });
    const [open] = h.opens();
    const message = open!.message as unknown as {
      options: { units: unknown };
      scene: DeskBrief;
      units: { ref: string; version: number; unit: { data: ArrayBuffer } }[];
    };
    expect(message.options.units).toEqual({ version: 1, publish: true });
    expect(message.scene.set.unit).toEqual(PINS.set);
    expect(message.scene.cast[0]!.unit).toEqual(PINS.mira);
    expect(message.scene.elements[0]!.unit).toEqual(PINS.lamp);
    expect(s.fetches[0]!.slots).toEqual(['set', 'cast:chr_mira', 'el:ele_lamp']);
    expect(message.units.map((u) => [u.ref, u.version])).toEqual([
      [PINS.set.ref, 3],
      [PINS.mira.ref, 2],
      [PINS.lamp.ref, 1],
    ]);
    // the state's copy and every file are transferred
    expect(open!.transfer).toEqual([
      (message as unknown as { state: DeskState }).state.data,
      ...message.units.map((u) => u.unit.data),
    ]);
    expect(HostToDeskMessageSchema.safeParse(open!.message).success).toBe(true);
    // the status line counted them as they came
    const lines = h.statuses.map((st) => st.line);
    expect(lines).toContain("Getting the scene's library units (0 of 3)…");
    expect(lines).toContain("Getting the scene's library units (3 of 3)…");
    // a person who may not publish: no Save to library in the desk
    const reader = await ready({ units: studio({ mayPublish: () => false }).host });
    expect((reader.opens()[0]!.message as unknown as { options: { units: unknown } }).options.units).toEqual({
      version: 1,
      publish: false,
    });
  });

  it('sends no file for a pin the state handed over already uses: the stored rows, then the desk newest state rows', async () => {
    const s = studio({
      storedUses: (sha) =>
        (sha === 'kept' ? [ROW('set', PINS.set)].map(({ sha256: _s, ...u }) => u) : null) as never,
    });
    const h = await ready({ units: s.host, stored: stored('kept') });
    expect(s.fetches[0]!.slots).toEqual(['cast:chr_mira', 'el:ele_lamp']);
    h.desk(OPENED);
    // the desk's newest state uses the set and the figure; the prop waits
    h.desk({
      ...state('edited'),
      units: [
        ROW('set', PINS.set),
        ROW('cast:chr_mira', PINS.mira),
        ROW('el:ele_lamp', PINS.lamp, 'pending'),
      ],
    });
    // the desk page loads again: its newest state goes back with the one file it still needs
    h.hello();
    h.bridge.frameLoaded();
    h.desk(READY_UNITS);
    await flush();
    expect(s.fetches[1]!.slots).toEqual(['el:ele_lamp']);
    const again = h.opens()[1]!.message as unknown as { units: { ref: string }[] };
    expect(again.units.map((u) => u.ref)).toEqual([PINS.lamp.ref]);
    // nothing to send: no units field at all
    const all = studio({
      storedUses: () =>
        [ROW('set', PINS.set), ROW('cast:chr_mira', PINS.mira), ROW('el:ele_lamp', PINS.lamp)].map(
          ({ sha256: _s, ...u }) => u,
        ) as never,
    });
    const quiet = await ready({ units: all.host, stored: stored('kept') });
    expect(all.fetches).toEqual([]);
    expect(quiet.opens()[0]!.message).not.toHaveProperty('units');
  });

  it('opens without the files that did not come, and Close while they come stops them and sends no open', async () => {
    const left = studio({
      fetch: async () => ({ units: [], left: [{ slot: 'set', why: 'failed' }] }),
    });
    const h = await ready({ units: left.host });
    expect(h.opens()).toHaveLength(1);
    expect(h.opens()[0]!.message).not.toHaveProperty('units');

    let signal: AbortSignal | null = null;
    const slow = studio({
      fetch: (_pins, _progress, s) =>
        new Promise((resolve) => {
          signal = s;
          s.addEventListener('abort', () => resolve({ units: [], left: [] }));
        }),
    });
    const closing = await ready({ units: slow.host });
    expect(closing.last().line).toBe("Getting the scene's library units (0 of 3)…");
    await closing.bridge.close();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(closing.opens()).toEqual([]);
    expect(closing.closed()).toBe(1);
  });

  it('publishes one at a time in the order they come, each acked on its connection with a notice', async () => {
    const waits: (() => void)[] = [];
    const s = studio({
      publish: (m, opened) =>
        new Promise((resolve) => {
          waits.push(() => resolve(outcome(m, !opened.readOnly)));
        }),
    });
    const h = await ready({ units: s.host });
    h.desk(OPENED);
    h.desk(PUBLISH('pub-1'));
    h.desk(PUBLISH('pub-2'));
    await flush();
    expect(waits).toHaveLength(1);
    expect(h.last().line).toBe('Saving Harbor to the library…');
    waits[0]!();
    await flush();
    expect(waits).toHaveLength(2);
    const acks = () => h.posted().filter((m) => m.type === 'unit-ack');
    expect(acks().map((a) => [a.id, a.ok, a.linked])).toEqual([['pub-1', true, true]]);
    expect(h.toasts.at(-1)).toEqual([
      "Saved Harbor v1 to the library; linked to the scene's place (Harbor)",
      'success',
    ]);
    waits[1]!();
    await flush();
    expect(acks().map((a) => a.id)).toEqual(['pub-1', 'pub-2']);
    // a publish that throws is answered failed, and the next goes on
    const failing = studio({
      publish: async () => {
        throw new Error('the studio went away');
      },
    });
    const f = await ready({ units: failing.host });
    f.desk(OPENED);
    f.desk(PUBLISH('pub-9'));
    await flush();
    expect(f.posted().filter((m) => m.type === 'unit-ack')).toEqual([
      { type: 'unit-ack', id: 'pub-9', ok: false, code: 'failed', message: 'the studio went away' },
    ]);
  });

  it('tells the publish the open was read-only (an approved clip): it is never linked', async () => {
    const s = studio();
    const h = await ready({ units: s.host, readOnly: true });
    h.desk(OPENED);
    h.desk(PUBLISH('pub-1'));
    await flush();
    expect(s.publishes[0]![1]).toEqual({ readOnly: true });
  });

  it('refuses a unit-publish at once on an open without units or without publish', async () => {
    for (const [h, says] of [
      [await ready({ units: studio().host }, READY), 'this open has no library units'],
      [await ready({}), 'this open has no library units'],
      [
        await ready({ units: studio({ mayPublish: () => false }).host }),
        'you may not publish to the library',
      ],
    ] as const) {
      h.desk(OPENED);
      h.desk(PUBLISH('pub-1'));
      // synchronous: the desk never waits out its timeout
      expect(h.posted().filter((m) => m.type === 'unit-ack')).toEqual([
        { type: 'unit-ack', id: 'pub-1', ok: false, code: 'refused', message: says },
      ]);
    }
  });

  it("sends each state's units with its write, and none when the desk sent none", async () => {
    const s = studio();
    const h = await ready({ units: s.host });
    h.desk(OPENED);
    const rows = [ROW('set', PINS.set), ROW('el:ele_lamp', PINS.lamp, 'pending')];
    h.desk({ ...state('edited'), units: rows });
    const close = h.bridge.close();
    await flush();
    // the answer to Close's save is a state like any other: its own units with it
    h.desk({ ...state('with units', h.posted().find((m) => m.type === 'save')?.id as string), units: rows });
    await close;
    expect(h.unitsStored).toEqual([
      [
        { slot: 'set', ref: PINS.set.ref, version: 3, staged: 'unit', local: false },
        {
          slot: 'el:ele_lamp',
          ref: PINS.lamp.ref,
          version: 1,
          staged: 'pending',
          local: false,
          why: 'missing',
        },
      ],
    ]);
    // a desk from before units: no rows, the write says nothing of them
    const old = await opened({});
    old.desk(state('old'));
    const done = old.bridge.close();
    await flush();
    old.desk(state('old', old.posted().find((m) => m.type === 'save')?.id as string));
    await done;
    expect(old.unitsStored).toEqual([null]);
  });

  it('stores a state whose units name a slot twice with its units not known: no header the server refuses', async () => {
    // the write as DeskPanel and the server make it: the units' header, refused when it does not parse
    const h = await ready({
      units: studio().host,
      store: async (s, _signal, _precondition, units) => {
        parseDeskStateUnits(formatDeskStateUnits(units));
        return text(s.data);
      },
    });
    h.desk(OPENED);
    h.desk({ ...state('edited'), units: [ROW('set', PINS.set), ROW('set', { ...PINS.set, version: 4 })] });
    await vi.advanceTimersByTimeAsync(DESK_STATE_WRITE_INTERVAL_MS);
    expect(h.stores).toEqual(['edited']);
    expect(h.unitsStored).toEqual([null]);
    expect(h.toasts).toEqual([]);
    expect(h.last().line).toBe('Desk stored');
  });

  it('answers a unit-publish it cannot read with bad_message and a unit-ack invalid at once, and says so', async () => {
    const s = studio();
    const h = await ready({ units: s.host });
    h.desk(OPENED);
    const before = h.posted().length;
    // a newer desk's unit format: the desk reads no error of the host, and would wait out its timeout
    h.desk(PUBLISH('pub-9', { unit: { format: '3d-editor.desk-unit', version: 2, data: bytes('unit v2') } }));
    const answers = h.posted().slice(before);
    expect(answers.map((m) => [m.type, m.id])).toEqual([
      ['error', 'pub-9'],
      ['unit-ack', 'pub-9'],
    ]);
    expect(answers[0]).toMatchObject({
      code: 'bad_message',
      message: expect.stringMatching(/^unit-publish: /),
    });
    expect(answers[1]).toMatchObject({ ok: false, code: 'invalid' });
    const said = answers[1]!.message as string;
    expect(said).toMatch(/^this studio cannot read the publish: unit\.version /);
    expect(HostToDeskMessageSchema.safeParse(answers[1]).success).toBe(true);
    expect(s.publishes).toEqual([]);
    expect(h.toasts).toEqual([[`Not saved to the library: ${said}`, 'warning']]);
    expect(h.last().line).toBe(`Not saved to the library: ${said}`);
    // one without a usable id: nothing to answer
    h.desk(PUBLISH('', { kind: 'vehicle' }));
    expect(h.posted()).toHaveLength(before + 2);
    expect(h.toasts).toHaveLength(1);
  });
});

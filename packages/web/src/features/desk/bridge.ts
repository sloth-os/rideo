import {
  DESK_CLOSE_STORE_TIMEOUT_MS,
  DESK_HELLO_TIMEOUT_MS,
  DESK_PROTOCOL,
  DESK_PROTOCOL_VERSIONS,
  DESK_STATE_FORMAT,
  DESK_STATE_VERSION,
  DESK_STATE_WRITE_INTERVAL_MS,
  DESK_STORE_RETRY_MAX_MS,
  DESK_STORE_RETRY_MS,
  DESK_TO_HOST_TYPES,
  type DeskBrief,
  DeskConnectSchema,
  type DeskErrorCode,
  DeskErrorMessageSchema,
  DeskHelloSchema,
  type DeskOpenOptions,
  type DeskResultMessage,
  type DeskState,
  DeskToHostMessageSchema,
  deskOrigin,
  deskText,
  type HostToDeskMessage,
  HostToDeskMessageSchema,
} from '@rideo/shared';
import type { DeskAck } from './results';

/**
 * The studio's side of the desk embed protocol, version 1 (docs/design/director-desk.md#the-protocol): the handshake
 * with the desk's iframe, the messages on the port (each validated with the shared schemas, both ways), the desk
 * state kept and stored, and results applied and acknowledged. Free of React and of the DOM it is given, so tests
 * drive it with fake windows and ports.
 */

export type DeskPhase = 'connecting' | 'opening' | 'open' | 'closing' | 'closed' | 'failed';

export interface DeskStatus {
  phase: DeskPhase;
  /** The status line under the panel's title. */
  line: string;
  /** Why this browser cannot render the reference clips (staging still works); null when it can. */
  exportUnavailable: string | null;
  /** The desk was not connected or not opened: why. */
  failure: string | null;
  /**
   * What the panel offers with the failure: a link to the headers the desk needs (it did not answer), Retry and Start
   * over (the stored state was not loaded: `retry()`, `startOver()`), or nothing.
   */
  remedy: 'headers' | 'retry' | null;
  /**
   * The stored state is kept and nothing is stored on its own (docs/design/director-desk.md#when-rideo-stores-it): the
   * desk could not read it, or another session stored a newer one. The panel says so and offers Replace the stored
   * desk state (`replace()`); null while states are stored as usual.
   */
  kept: { reason: 'unreadable' | 'conflict'; notice: string } | null;
}

/**
 * The state a write replaces (docs/design/director-desk.md#when-rideo-stores-it): `If-Match` with the sha256 of the
 * state the panel last loaded or stored (`*`: one whose sha256 is not known), or `If-None-Match: *` when none is stored.
 */
export type DeskStorePrecondition = { ifMatch: string } | { ifNoneMatch: '*' };

/**
 * A write refused because the server holds another state than the one it named (`412` `desk_state_conflict`): another
 * session stored a newer state, or cleared it.
 */
export class DeskStateConflict extends Error {
  constructor(
    /** The stored state's sha256 (its ETag); null when the clip names none. */
    readonly stored: string | null,
    message = 'another session stored a newer desk state',
  ) {
    super(message);
    this.name = 'DeskStateConflict';
  }
}

/** A desk state as the server holds it (`GET …/desk-state`). */
export interface StoredDeskState {
  format: string;
  version: number;
  /** The ETag: the bytes' sha256. */
  sha256: string;
  data: ArrayBuffer;
}

/** The studio's end of the MessageChannel. */
export interface DeskPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

/** What posts to the desk's window. */
export interface DeskWindow {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

export interface DeskBridgeOptions {
  /** `features.desk.url`: the desk's origin is taken from it once. */
  url: string;
  /** The studio's window, where the desk's `hello` arrives. */
  host: {
    addEventListener(type: 'message', fn: (event: MessageEvent) => void): void;
    removeEventListener(type: 'message', fn: (event: MessageEvent) => void): void;
  };
  /** The iframe's window (`iframe.contentWindow`), once it has one. */
  frame: () => DeskWindow | null;
  /** The clip's brief, as `open` sends it. */
  brief: () => DeskBrief;
  options: () => DeskOpenOptions;
  /** The stored state (`GET desk-state`), null when none is stored (`404`); any other failure rejects. */
  load: () => Promise<StoredDeskState | null>;
  /**
   * Stores a state (`PUT desk-state`) over the one the precondition names: the sha256 the server holds. Rejects with
   * `DeskStateConflict` when the server holds another state. `signal` aborts it (closing waits at most
   * `DESK_CLOSE_STORE_TIMEOUT_MS`); a write on the way out of the panel has none.
   */
  store: (state: DeskState, precondition: DeskStorePrecondition, signal?: AbortSignal) => Promise<string>;
  /** Clears the stored state (`DELETE desk-state`): Start over. */
  clear: () => Promise<void>;
  /**
   * Applies a result (docs/design/director-desk.md#the-result) with the brief the desk was opened with: what
   * `result-ack` says.
   */
  applyResult: (result: DeskResultMessage, brief: DeskBrief | null) => Promise<DeskAck>;
  onStatus: (status: DeskStatus) => void;
  onToast: (message: string, level: 'info' | 'success' | 'warning' | 'error') => void;
  /** The panel closes. */
  onClosed: () => void;
  channel?: () => { port1: DeskPort; port2: Transferable };
  sha256?: (data: ArrayBuffer) => Promise<string>;
  log?: (message: string, data?: unknown) => void;
}

/** How long Close waits for the desk's answer to `save` before it stores the newest state it has. */
export const DESK_SAVE_TIMEOUT_MS = 5_000;

const PHASES = {
  prepare: 'preparing',
  render: 'rendering',
  encode: 'encoding',
  finish: 'finishing',
} as const;
const SOURCES = { state: 'the stored desk', local: "this browser's copy", brief: 'the brief' } as const;

/**
 * The desk's errors meant for the person, said in a toast too; the others answer rideo's own requests (`not_open` for
 * a `save` that came while the desk was staging, `bad_message`, `busy`, …): the status line and the log only.
 */
const FOR_THE_PERSON: ReadonlySet<string> = new Set<DeskErrorCode>([
  'state_unreadable',
  'export_failed',
  'export_unavailable',
  'out_of_memory',
  'invalid_scene',
]);

/** A write refused because another session stored a newer state (docs/design/director-desk.md#when-rideo-stores-it). */
export const DESK_CONFLICT_NOTICE = 'Another session stored a newer desk state for this clip; it was kept';
/** What a write outcome was: `same` the stored bytes again, `skipped` nothing to store (or the stored state is kept). */
type StoreOutcome = 'stored' | 'same' | 'skipped' | 'failed' | 'conflict';

/** The sha256 of the bytes in lowercase hex, as the server's `ETag` and `media.hash` give it. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** "30 s", "1 min", "10 min". */
const wait = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

type Timer = ReturnType<typeof setTimeout>;

export class DeskBridge {
  readonly origin: string;
  private status: DeskStatus;
  private port: DeskPort | null = null;
  /** `ready` arrived on the port, and `open` was sent on it (once per connection). */
  private ready = false;
  private openSent = false;
  /**
   * Hellos that came before their page's `load` event, and whether the last `load` still waits for its hello: the desk
   * says hello from its own load handler, which usually reaches the studio before the iframe's `load`.
   */
  private early = 0;
  private awaitingHello = false;
  private helloTimer: Timer | null = null;
  private writeTimer: Timer | null = null;
  /** The stored state once loaded; null while it loads or after it failed (`loadFailure` says why). */
  private stored: Promise<{ state: StoredDeskState | null } | null> = Promise.resolve(null);
  private loadFailure: string | null = null;
  /**
   * The sha256 of the state the panel last loaded or stored, which a write names (`If-Match`); `*` for one whose sha256
   * is not known, null when none is stored (`If-None-Match: *`).
   */
  private storedSha: string | null = null;
  /**
   * The stored state is kept: nothing is stored on its own until the person replaces it (`replace()`), then over the
   * state `etag` names (the one a conflict reported).
   */
  private kept: { reason: 'unreadable' | 'conflict'; notice: string; etag: string | null } | null = null;
  /** The `open` sent on this connection carried a state, which `state_unreadable` is about. */
  private handedOver = false;
  /** The brief of the last `open`: a result's plan tells what the desk changed from what rideo changed. */
  private brief: DeskBrief | null = null;
  /** The scene the desk was opened on: states are kept, and stored, only once `open` was sent (stored state loaded). */
  private sceneId: string | null = null;
  /** The newest state the desk sent, and whether it may differ from the stored one. */
  private latest: DeskState | null = null;
  private dirty = false;
  private lastWrite = Date.now();
  /** Writes that failed in a row: the backoff, and one toast per run of failures. */
  private failures = 0;
  private writing: Promise<unknown> = Promise.resolve();
  private results: Promise<void> = Promise.resolve();
  private saves = new Map<string, (state: DeskState | null) => void>();
  private requests = 0;
  /** Aborts the writes in flight when closing has waited `DESK_CLOSE_STORE_TIMEOUT_MS`. */
  private readonly aborts = new AbortController();
  private closeRequest: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly o: DeskBridgeOptions) {
    this.origin = deskOrigin(o.url);
    this.status = {
      phase: 'connecting',
      line: this.connectingLine(),
      exportUnavailable: null,
      failure: null,
      remedy: null,
      kept: null,
    };
  }

  get current(): DeskStatus {
    return this.status;
  }

  /** Listens for the desk's `hello` and loads the stored state, which `open` gives back. */
  start(): void {
    this.o.host.addEventListener('message', this.onWindowMessage);
    this.lastWrite = Date.now();
    this.loadStored();
    this.set({});
  }

  /**
   * The iframe's `load`. A load whose page said hello already is answered; any other (the first, or the desk page
   * loading again, say into the browser's error page) drops the connection to the page that is gone, shows
   * "Connecting…" again and gives the page 15 seconds to say hello (a page the browser refused fires no error).
   */
  frameLoaded(): void {
    if (this.disposed || this.leaving) return;
    if (this.early > 0) {
      this.early = 0;
      return;
    }
    this.awaitingHello = true;
    this.dropPort();
    if (this.loadFailure) this.showLoadFailure();
    else this.set({ phase: 'connecting', line: this.connectingLine(), failure: null, remedy: null });
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      this.awaitingHello = false;
      this.fail(
        `The desk at ${this.origin} did not answer. Check that it is served with the headers it needs`,
        'headers',
      );
    }, DESK_HELLO_TIMEOUT_MS);
  }

  /** Retry, after the stored state was not loaded: it is loaded again, and the desk opened once it is. */
  retry(): void {
    if (this.disposed || this.leaving || this.status.remedy !== 'retry') return;
    this.loadFailure = null;
    this.set(
      this.port
        ? { phase: 'opening', line: 'Opening the scene…', failure: null, remedy: null }
        : { phase: 'connecting', line: this.connectingLine(), failure: null, remedy: null },
    );
    this.loadStored();
    if (this.port && this.ready) void this.open(this.port);
  }

  /**
   * Start over, after the person confirmed it, when the stored state was not loaded (a file gone for good, say): the
   * stored state is cleared (`DELETE`) and the desk opened without it, from its own copy of the scene or the brief.
   */
  startOver(): void {
    if (this.disposed || this.leaving || this.status.remedy !== 'retry') return;
    this.set({ line: 'Clearing the stored desk state…', failure: null, remedy: null });
    this.stored = Promise.resolve()
      .then(() => this.o.clear())
      .then(
        () => {
          this.log('the stored desk state was cleared (Start over)');
          this.loadFailure = null;
          this.storedSha = null;
          if (!this.leaving)
            this.set(
              this.port
                ? { phase: 'opening', line: 'Opening the scene…' }
                : { phase: 'connecting', line: this.connectingLine() },
            );
          return { state: null };
        },
        (err: unknown) => {
          this.log('the stored desk state was not cleared', err);
          if (!this.disposed && !this.leaving) {
            this.loadFailure = `The stored desk state could not be cleared: ${deskText(messageOf(err))}`;
            this.showLoadFailure();
          }
          return null;
        },
      );
    if (this.port && this.ready) void this.open(this.port);
  }

  /**
   * Replace the stored desk state, after the person confirmed it, when it was kept: the desk's newest state is stored
   * over it now, naming the state the notice was about (a newer one a third session stored meanwhile is refused
   * again), and later states are stored as usual. A desk that sent no state yet (it sends none after it could not read
   * the one handed over, until the person edits) is asked for the one it holds (`save`).
   */
  replace(): void {
    if (this.disposed || !this.kept) return;
    if (this.kept.reason === 'conflict') this.storedSha = this.kept.etag;
    this.log('the person replaces the stored desk state', { reason: this.kept.reason });
    this.kept = null;
    this.set({ kept: null });
    if ((this.latest && this.dirty) || !this.port || !this.openSent || this.leaving) {
      void this.storeLatest();
      return;
    }
    const id = `save-${++this.requests}`;
    this.saves.set(id, (state) => {
      if (state) void this.storeLatest();
    });
    setTimeout(() => this.saves.delete(id), DESK_SAVE_TIMEOUT_MS);
    this.post({ type: 'save', id });
  }

  /**
   * Close: the desk's state (`save`, at most 5 seconds), stored (at most 10 seconds, without waiting for a result's
   * uploads), then the panel closes.
   */
  close(): Promise<void> {
    this.closeRequest ??= this.requestClose();
    return this.closeRequest;
  }

  /**
   * The panel goes away without Close: the newest state not stored yet is stored on the way out, best effort (the
   * request is not waited for, and goes on after `dispose`).
   */
  flush(): void {
    if (this.disposed || this.leaving) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    // queued after a write in flight: it runs when that one ended, and only if the state is still not stored (and is
    // not kept)
    if (this.latest && !this.kept) void this.storeLatest({ final: true, signal: null });
  }

  /** Stops listening, timers and the port (the panel unmounts); reports no status after this. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.o.host.removeEventListener('message', this.onWindowMessage);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.helloTimer = this.writeTimer = null;
    for (const resolve of this.saves.values()) resolve(null);
    this.saves.clear();
    this.dropPort();
  }

  private get leaving(): boolean {
    return this.closeRequest !== null || this.closing !== null;
  }

  private connectingLine(): string {
    return `Connecting to the desk at ${this.origin}…`;
  }

  private set(patch: Partial<DeskStatus>): void {
    if (this.disposed) return;
    this.status = { ...this.status, ...patch };
    this.o.onStatus(this.status);
  }

  /** A status line that does not replace "Storing the desk…" once the panel closes. */
  private show(line: string): void {
    if (!this.leaving) this.set({ line });
  }

  private log(message: string, data?: unknown): void {
    this.o.log?.(message, data);
  }

  private fail(message: string, remedy: DeskStatus['remedy'] = null): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    if (this.leaving) return;
    this.set({ phase: 'failed', line: message, failure: message, remedy });
  }

  /** The stored state's failure, with Retry; a load of the iframe still waiting for its hello keeps its 15 seconds. */
  private showLoadFailure(): void {
    if (this.loadFailure && !this.leaving)
      this.set({ phase: 'failed', line: this.loadFailure, failure: this.loadFailure, remedy: 'retry' });
  }

  /**
   * Loads the stored state. Anything but a state rideo reads or none (`404`) fails the panel with Retry and Start over:
   * the desk is not opened without it (it would stage the brief or its own copy, and the next store would replace the
   * stored state with that).
   */
  private loadStored(): void {
    this.stored = Promise.resolve()
      .then(() => this.o.load())
      .then(async (s) => {
        if (s && (s.format !== DESK_STATE_FORMAT || s.version !== DESK_STATE_VERSION))
          throw new Error(
            `it is in a format this studio does not read (${deskText(s.format || 'none')}, version ${s.version})`,
          );
        // the state a write names: its ETag, else the sha256 of its bytes, else any stored state (`*`)
        this.storedSha = s ? s.sha256 || (await this.hash(s.data)) || '*' : null;
        return { state: s };
      })
      .catch((err: unknown) => {
        this.log('the stored desk state was not loaded', err);
        if (!this.disposed && !this.leaving) {
          this.loadFailure = `The stored desk could not be loaded: ${deskText(messageOf(err))}`;
          this.showLoadFailure();
        }
        return null;
      });
  }

  private dropPort(): void {
    if (this.port) this.port.onmessage = null;
    this.port?.close();
    this.port = null;
    this.ready = this.openSent = this.handedOver = false;
  }

  /** The sha256 of a state's bytes; null where this page cannot hash (no crypto.subtle). */
  private hash(data: ArrayBuffer): Promise<string | null> {
    return (this.o.sha256 ?? sha256Hex)(data).catch(() => null);
  }

  /** The state a write replaces: the one this panel last loaded or stored, or none. */
  private precondition(): DeskStorePrecondition {
    return this.storedSha === null ? { ifNoneMatch: '*' } : { ifMatch: this.storedSha };
  }

  /**
   * The stored state is kept (docs/design/director-desk.md#when-rideo-stores-it): nothing is stored on its own until the
   * person replaces it. The notice goes to the panel and, once per notice, to a toast (the one way to say it when the
   * panel is gone).
   */
  private keep(reason: 'unreadable' | 'conflict', notice: string, etag: string | null): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    const told = this.kept?.notice === notice;
    this.kept = { reason, notice, etag };
    this.log(`the stored desk state was kept (${reason})`, { etag });
    this.set({ kept: { reason, notice } });
    if (!told) this.o.onToast(notice, 'warning');
  }

  private onWindowMessage = (event: MessageEvent): void => {
    const frame = this.o.frame();
    // only the desk's own window, from the desk's origin
    if (
      this.disposed ||
      this.leaving ||
      !frame ||
      event.source !== (frame as unknown) ||
      event.origin !== this.origin
    )
      return;
    const hello = DeskHelloSchema.safeParse(event.data);
    if (!hello.success) {
      this.log('ignored a window message that is not a hello', event.data);
      return;
    }
    // the hello of the page that loaded: its `load` event is answered, or will be when it comes after
    if (this.awaitingHello) this.awaitingHello = false;
    else this.early += 1;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    const version = DESK_PROTOCOL_VERSIONS.find((v) => hello.data.versions.includes(v));
    if (version === undefined) {
      this.dropPort();
      this.fail(
        `This desk speaks protocol versions ${deskText(hello.data.versions.join(', '))}; this studio speaks ${DESK_PROTOCOL_VERSIONS.join(', ')}`,
      );
      return;
    }
    this.connect(frame, version);
  };

  private connect(frame: DeskWindow, version: number): void {
    // a desk that loaded again is connected again
    this.dropPort();
    const channel = this.o.channel ? this.o.channel() : new MessageChannel();
    const port = channel.port1 as DeskPort;
    port.onmessage = (event) => this.onPortMessage(port, event.data);
    this.port = port;
    const connect = DeskConnectSchema.parse({ protocol: DESK_PROTOCOL, type: 'connect', version });
    frame.postMessage(connect, this.origin, [channel.port2]);
    if (this.loadFailure) this.showLoadFailure();
    else this.set({ phase: 'opening', line: 'Opening the scene…', failure: null, remedy: null });
  }

  private post(message: HostToDeskMessage, transfer: Transferable[] = []): void {
    HostToDeskMessageSchema.parse(message);
    this.port?.postMessage(message, transfer);
  }

  private onPortMessage(port: DeskPort, data: unknown): void {
    if (port !== this.port || this.disposed) return;
    const type = data && typeof data === 'object' ? (data as { type?: unknown }).type : undefined;
    if (typeof type !== 'string' || !DESK_TO_HOST_TYPES.includes(type)) {
      this.log('ignored a desk message of an unknown type', type);
      return;
    }
    const parsed = DeskToHostMessageSchema.safeParse(data);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || type} ${i.message}`).join('; ');
      this.log(`a desk message failed validation: ${issues}`, data);
      const id = (data as { id?: unknown }).id;
      if (typeof id === 'string' && id.length >= 1 && id.length <= 64) {
        const reply = DeskErrorMessageSchema.parse({
          type: 'error',
          id,
          code: 'bad_message',
          message: `${type}: ${issues}`.slice(0, 2000),
        });
        port.postMessage(reply);
      }
      return;
    }
    const m = parsed.data;
    switch (m.type) {
      case 'ready': {
        const exp = m.capabilities.export;
        this.set({
          exportUnavailable: exp.available
            ? null
            : `This browser cannot render the reference clips: ${deskText(exp.reason ?? 'the desk gave no reason')}`,
        });
        if (!this.ready) {
          this.ready = true;
          void this.open(port);
        }
        return;
      }
      case 'opened':
        if (m.sceneId !== this.sceneId) this.log('the desk opened another scene', m.sceneId);
        if (!this.leaving)
          this.set({ phase: 'open', line: `Opened from ${SOURCES[m.source]}`, failure: null, remedy: null });
        return;
      case 'state': {
        const waiter = m.id ? this.saves.get(m.id) : undefined;
        if (m.id && waiter) this.saves.delete(m.id);
        if (!this.sceneId || m.sceneId !== this.sceneId) {
          this.log('ignored a state of another scene, or before open', m.sceneId);
          waiter?.(null);
          return;
        }
        this.latest = m.state;
        this.dirty = true;
        waiter?.(m.state);
        this.scheduleWrite();
        return;
      }
      case 'progress':
        this.show(`Rendering the clips: ${PHASES[m.phase]} ${m.done} of ${m.total}`);
        return;
      case 'result': {
        // the brief the desk rendered from: a later open on another connection may bring another
        const brief = this.brief;
        this.results = this.results
          .then(() => this.applyResult(port, m, brief))
          .catch((err: unknown) => this.log('a result was not applied', err));
        return;
      }
      case 'error': {
        this.log(`the desk reported ${m.code}`, m);
        const waiter = m.id ? this.saves.get(m.id) : undefined;
        if (m.id && waiter) {
          this.saves.delete(m.id);
          waiter(null);
        }
        if (m.code === 'state_unreadable' && this.handedOver) {
          // the desk could not read the state rideo handed over: it is kept, whatever the desk stages instead
          this.keep(
            'unreadable',
            `The stored desk state was kept: the desk could not read it (${deskText(m.message)})`,
            this.storedSha,
          );
          return;
        }
        const text =
          m.code === 'state_unreadable'
            ? `The desk could not read the state: ${deskText(m.message)}`
            : deskText(m.message);
        // the line goes with the next status; a toast only for what is meant for the person
        this.show(text);
        if (FOR_THE_PERSON.has(m.code)) this.o.onToast(text, 'warning');
        return;
      }
      case 'close':
        void this.finish();
        return;
    }
  }

  /**
   * `open`, once per connection, once the stored state is loaded: the brief, the newest state the panel holds (the
   * desk's newest `state`, else the stored one; a copy of its bytes is transferred, the panel keeps the original) and
   * the options.
   */
  private async open(port: DeskPort): Promise<void> {
    const loaded = await this.stored;
    if (!loaded || port !== this.port || this.openSent || this.disposed || this.leaving) return;
    let scene: DeskBrief;
    try {
      scene = this.o.brief();
    } catch (err) {
      this.fail(messageOf(err));
      return;
    }
    const source: DeskState | null =
      this.latest ??
      (loaded.state
        ? { format: DESK_STATE_FORMAT, version: DESK_STATE_VERSION, data: loaded.state.data }
        : null);
    const state = source ? { ...source, data: source.data.slice(0) } : null;
    try {
      this.post({ type: 'open', scene, state, options: this.o.options() }, state ? [state.data] : []);
    } catch (err) {
      this.fail(`The scene could not be sent to the desk: ${messageOf(err)}`);
      return;
    }
    this.openSent = true;
    this.handedOver = state !== null;
    this.sceneId = scene.id;
    this.brief = scene;
  }

  /**
   * While the desk stays open its newest state is stored at most every 10 minutes (from the last write, or from the
   * panel's opening), when it changed; after a failed write the backoff's timer is the next write.
   */
  private scheduleWrite(): void {
    if (this.writeTimer || this.disposed || this.leaving || this.kept) return;
    const due = Math.max(0, this.lastWrite + DESK_STATE_WRITE_INTERVAL_MS - Date.now());
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.storeLatest({ interval: true });
    }, due);
  }

  /**
   * Stores the newest state unless the server holds the same bytes already (one write at a time), naming the state it
   * replaces; nothing while the stored state is kept. A write that fails is tried again with a backoff (30 seconds,
   * doubling, at most 10 minutes) and said in one toast until a write succeeds; a final write (closing, or leaving the
   * panel) is not tried again, and its failure is said in a toast. A write refused because another session stored a
   * newer state keeps that state: nothing more is stored on its own (docs/design/director-desk.md#when-rideo-stores-it).
   */
  private storeLatest(
    how: { final?: boolean; signal?: AbortSignal | null; interval?: boolean } = {},
  ): Promise<StoreOutcome> {
    const final = how.final ?? false;
    const signal = how.signal === undefined ? this.aborts.signal : (how.signal ?? undefined);
    const run = async (): Promise<StoreOutcome> => {
      const state = this.latest;
      if (!state || !this.dirty || !this.sceneId || this.kept) return 'skipped';
      // the 10 minutes' write waited for a write that started them again (a state came while that one was stored)
      if (how.interval && Date.now() - this.lastWrite < DESK_STATE_WRITE_INTERVAL_MS) {
        this.scheduleWrite();
        return 'skipped';
      }
      this.dirty = false;
      try {
        // a page that cannot hash (no crypto.subtle) sends the state: the server keeps the same bytes only once
        const sha = await this.hash(state.data);
        if (sha !== null && sha === this.storedSha) return 'same';
        this.show('Storing the desk…');
        this.storedSha = await this.o.store(state, this.precondition(), signal);
        this.lastWrite = Date.now();
        this.failures = 0;
        // any write starts the 10 minutes again (the one before a result too)
        if (this.writeTimer) clearTimeout(this.writeTimer);
        this.writeTimer = null;
        this.show('Desk stored');
        if (this.dirty) this.scheduleWrite();
        return 'stored';
      } catch (err) {
        this.dirty = true;
        if (err instanceof DeskStateConflict) {
          // another session stored a newer state, or cleared it: never replaced unseen, and not tried again
          this.log(
            'the desk state was not stored: the stored state is not the one this panel had',
            err.stored,
          );
          this.failures = 0;
          this.keep('conflict', DESK_CONFLICT_NOTICE, err.stored);
          this.show('The desk was not stored');
          return 'conflict';
        }
        this.log('the desk state was not stored', err);
        const said = `The desk could not be stored: ${deskText(messageOf(err))}`;
        if (final) {
          this.o.onToast(said, 'error');
          return 'failed';
        }
        // closing, or leaving the panel: the final write queued after this one tries again and says how it went
        if (this.leaving || this.disposed) return 'failed';
        this.failures += 1;
        const delay = Math.min(DESK_STORE_RETRY_MS * 2 ** (this.failures - 1), DESK_STORE_RETRY_MAX_MS);
        this.show(`${said}; trying again in ${wait(delay)}`);
        // one toast per run of failures
        if (this.failures === 1) this.o.onToast(said, 'error');
        if (this.writeTimer) clearTimeout(this.writeTimer);
        this.writeTimer = setTimeout(() => {
          this.writeTimer = null;
          void this.storeLatest();
        }, delay);
        return 'failed';
      }
    };
    const done = this.writing.then(run, run);
    this.writing = done;
    return done;
  }

  /**
   * A result: the newest state stored first (unless the stored one is kept), then the shots attached, checked against
   * the brief the desk rendered from, and acknowledged.
   */
  private async applyResult(
    port: DeskPort,
    result: DeskResultMessage,
    brief: DeskBrief | null,
  ): Promise<void> {
    this.show('Attaching the clips the desk rendered…');
    if (!this.leaving) await this.storeLatest();
    let ack: DeskAck;
    try {
      ack = await this.o.applyResult(result, brief);
    } catch (err) {
      ack = { ok: false, message: `The result was not applied: ${messageOf(err)}`, shots: [] };
    }
    if (port === this.port && !this.disposed) {
      try {
        this.post({ type: 'result-ack', id: result.id, ok: ack.ok, message: ack.message, shots: ack.shots });
      } catch (err) {
        this.log('the result-ack was not sent', err);
      }
    }
    // the toast says what was attached even after the panel closed
    this.o.onToast(deskText(ack.message), ack.ok ? 'success' : 'warning');
    this.show(deskText(ack.message));
  }

  private async requestClose(): Promise<void> {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    // a kept state is not replaced on Close: the desk is not asked for its state
    if (this.port && this.openSent && !this.disposed && !this.closing && !this.kept) {
      const id = `save-${++this.requests}`;
      const reply = new Promise<DeskState | null>((resolve) => {
        this.saves.set(id, resolve);
        setTimeout(() => {
          if (this.saves.delete(id)) resolve(null);
        }, DESK_SAVE_TIMEOUT_MS);
      });
      this.set({ phase: 'closing', line: 'Storing the desk…' });
      this.post({ type: 'save', id });
      await reply;
    }
    await this.finish();
  }

  /**
   * The newest state stored (unless the stored one is kept), then the panel closes (Close, or the desk's own Done or
   * Close). A result's uploads are not waited for (they go on, and their toast still says what was attached); the
   * write is, at most `DESK_CLOSE_STORE_TIMEOUT_MS`, then it is aborted: the person is never held in the panel. A last
   * write refused because another session stored a newer state leaves the panel open with that notice: the person
   * replaces it, or Close again closes without storing.
   */
  private finish(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.helloTimer) clearTimeout(this.helloTimer);
      if (this.writeTimer) clearTimeout(this.writeTimer);
      this.helloTimer = this.writeTimer = null;
      this.set({ phase: 'closing', line: 'Storing the desk…' });
      let timer: Timer | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => {
          this.aborts.abort(new Error(`it took longer than ${DESK_CLOSE_STORE_TIMEOUT_MS / 1000} seconds`));
          resolve('late');
        }, DESK_CLOSE_STORE_TIMEOUT_MS);
      });
      const outcome = await Promise.race([this.storeLatest({ final: true }), late]);
      clearTimeout(timer);
      if (outcome === 'conflict' && !this.disposed) {
        this.closing = null;
        this.closeRequest = null;
        this.set({ phase: this.openSent ? 'open' : 'opening', line: 'The desk was not stored' });
        return;
      }
      this.set({ phase: 'closed' });
      this.dispose();
      this.o.onClosed();
    })();
    return this.closing;
  }
}

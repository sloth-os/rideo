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
   * What the panel offers with the failure: a link to the headers the desk needs (it did not answer), Retry (the
   * stored state was not loaded: `retry()`), or nothing.
   */
  remedy: 'headers' | 'retry' | null;
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
   * Stores a state (`PUT desk-state`): the sha256 the server holds. `signal` aborts it (closing waits at most
   * `DESK_CLOSE_STORE_TIMEOUT_MS`); a write on the way out of the panel has none.
   */
  store: (state: DeskState, signal?: AbortSignal) => Promise<string>;
  /** Applies a result (docs/design/director-desk.md#the-result): what `result-ack` says. */
  applyResult: (result: DeskResultMessage) => Promise<DeskAck>;
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
  private storedSha: string | null = null;
  /** The scene the desk was opened on: states are kept, and stored, only once `open` was sent (stored state loaded). */
  private sceneId: string | null = null;
  /** The newest state the desk sent, and whether it may differ from the stored one. */
  private latest: DeskState | null = null;
  private dirty = false;
  private lastWrite = Date.now();
  /** Writes that failed in a row: the backoff, and one toast per run of failures. */
  private failures = 0;
  private writing: Promise<void> = Promise.resolve();
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
    // queued after a write in flight: it runs when that one ended, and only if the state is still not stored
    if (this.latest) void this.storeLatest({ final: true, signal: null });
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
   * Loads the stored state. Anything but a state rideo reads or none (`404`) fails the panel with Retry: the desk is
   * not opened without it (it would stage the brief or its own copy, and the next store would replace the stored
   * state with that).
   */
  private loadStored(): void {
    this.stored = Promise.resolve()
      .then(() => this.o.load())
      .then((s) => {
        if (s && (s.format !== DESK_STATE_FORMAT || s.version !== DESK_STATE_VERSION))
          throw new Error(
            `it is in a format this studio does not read (${deskText(s.format || 'none')}, version ${s.version})`,
          );
        this.storedSha = s?.sha256 || null;
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
    this.ready = this.openSent = false;
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
      case 'result':
        this.results = this.results
          .then(() => this.applyResult(port, m))
          .catch((err: unknown) => this.log('a result was not applied', err));
        return;
      case 'error': {
        const text =
          m.code === 'state_unreadable'
            ? `The stored desk could not be read: ${deskText(m.message)}`
            : deskText(m.message);
        this.log(`the desk reported ${m.code}`, m);
        // the line goes with the next status (`opened` follows state_unreadable at once); the toast stays
        this.show(text);
        this.o.onToast(text, 'warning');
        const waiter = m.id ? this.saves.get(m.id) : undefined;
        if (m.id && waiter) {
          this.saves.delete(m.id);
          waiter(null);
        }
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
    this.sceneId = scene.id;
  }

  /**
   * While the desk stays open its newest state is stored at most every 10 minutes (from the last write, or from the
   * panel's opening), when it changed; after a failed write the backoff's timer is the next write.
   */
  private scheduleWrite(): void {
    if (this.writeTimer || this.disposed || this.leaving) return;
    const due = Math.max(0, this.lastWrite + DESK_STATE_WRITE_INTERVAL_MS - Date.now());
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.storeLatest({ interval: true });
    }, due);
  }

  /**
   * Stores the newest state unless the server holds the same bytes already (one write at a time). A write that fails
   * is tried again with a backoff (30 seconds, doubling, at most 10 minutes) and said in one toast until a write
   * succeeds; a final write (closing, or leaving the panel) is not tried again, and its failure is said in a toast.
   */
  private storeLatest(
    how: { final?: boolean; signal?: AbortSignal | null; interval?: boolean } = {},
  ): Promise<void> {
    const final = how.final ?? false;
    const signal = how.signal === undefined ? this.aborts.signal : (how.signal ?? undefined);
    const run = async () => {
      const state = this.latest;
      if (!state || !this.dirty || !this.sceneId) return;
      // the 10 minutes' write waited for a write that started them again (a state came while that one was stored)
      if (how.interval && Date.now() - this.lastWrite < DESK_STATE_WRITE_INTERVAL_MS) {
        this.scheduleWrite();
        return;
      }
      this.dirty = false;
      try {
        // a page that cannot hash (no crypto.subtle) sends the state: the server keeps the same bytes only once
        const sha = await (this.o.sha256 ?? sha256Hex)(state.data).catch(() => null);
        if (sha !== null && sha === this.storedSha) return;
        this.show('Storing the desk…');
        this.storedSha = await this.o.store(state, signal);
        this.lastWrite = Date.now();
        this.failures = 0;
        // any write starts the 10 minutes again (the one before a result too)
        if (this.writeTimer) clearTimeout(this.writeTimer);
        this.writeTimer = null;
        this.show('Desk stored');
        if (this.dirty) this.scheduleWrite();
      } catch (err) {
        this.dirty = true;
        this.log('the desk state was not stored', err);
        const said = `The desk could not be stored: ${deskText(messageOf(err))}`;
        if (final) {
          this.o.onToast(said, 'error');
          return;
        }
        // closing, or leaving the panel: the final write queued after this one tries again and says how it went
        if (this.leaving || this.disposed) return;
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
      }
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  /** A result: the newest state stored first, then the shots attached and acknowledged. */
  private async applyResult(port: DeskPort, result: DeskResultMessage): Promise<void> {
    this.show('Attaching the clips the desk rendered…');
    if (!this.leaving) await this.storeLatest();
    let ack: DeskAck;
    try {
      ack = await this.o.applyResult(result);
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
    if (this.port && this.openSent && !this.disposed && !this.closing) {
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
   * The newest state stored, then the panel closes (Close, or the desk's own Done or Close). A result's uploads are
   * not waited for (they go on, and their toast still says what was attached); the write is, at most
   * `DESK_CLOSE_STORE_TIMEOUT_MS`, then it is aborted: the person is never held in the panel.
   */
  private finish(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.helloTimer) clearTimeout(this.helloTimer);
      if (this.writeTimer) clearTimeout(this.writeTimer);
      this.helloTimer = this.writeTimer = null;
      this.set({ phase: 'closing', line: 'Storing the desk…' });
      let timer: Timer | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.aborts.abort(new Error(`it took longer than ${DESK_CLOSE_STORE_TIMEOUT_MS / 1000} seconds`));
          resolve();
        }, DESK_CLOSE_STORE_TIMEOUT_MS);
      });
      await Promise.race([this.storeLatest({ final: true }), late]);
      clearTimeout(timer);
      this.set({ phase: 'closed' });
      this.dispose();
      this.o.onClosed();
    })();
    return this.closing;
  }
}

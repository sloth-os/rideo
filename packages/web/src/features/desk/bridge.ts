import {
  DESK_HELLO_TIMEOUT_MS,
  DESK_PROTOCOL,
  DESK_PROTOCOL_VERSIONS,
  DESK_STATE_FORMAT,
  DESK_STATE_VERSION,
  DESK_STATE_WRITE_INTERVAL_MS,
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
  /** The desk was not connected: why (the panel links to the headers it needs). */
  failure: string | null;
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
  /** The stored state (`GET desk-state`), null when none is stored. */
  load: () => Promise<StoredDeskState | null>;
  /** Stores a state (`PUT desk-state`): the sha256 the server holds. */
  store: (state: DeskState) => Promise<string>;
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

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class DeskBridge {
  readonly origin: string;
  private status: DeskStatus;
  private port: DeskPort | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private stored: Promise<StoredDeskState | null> = Promise.resolve(null);
  private storedSha: string | null = null;
  private storedSent = false;
  private sceneId: string | null = null;
  private opened = false;
  /** The newest state the desk sent, and whether it may differ from the stored one. */
  private latest: DeskState | null = null;
  private dirty = false;
  private lastWrite = Date.now();
  private writing: Promise<void> = Promise.resolve();
  private results: Promise<void> = Promise.resolve();
  private saves = new Map<string, (state: DeskState | null) => void>();
  private requests = 0;
  private closing: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly o: DeskBridgeOptions) {
    this.origin = deskOrigin(o.url);
    this.status = {
      phase: 'connecting',
      line: `Connecting to the desk at ${this.origin}…`,
      exportUnavailable: null,
      failure: null,
    };
  }

  get current(): DeskStatus {
    return this.status;
  }

  /** Listens for the desk's `hello` and fetches the stored state, which `open` gives back. */
  start(): void {
    this.o.host.addEventListener('message', this.onWindowMessage);
    this.lastWrite = Date.now();
    this.stored = this.o.load().then(
      (s) => {
        this.storedSha = s?.sha256 ?? null;
        return s;
      },
      (err) => {
        this.log('the stored desk state was not loaded', err);
        this.set({ line: `The stored desk could not be loaded: ${messageOf(err)}` });
        return null;
      },
    );
    this.set({});
  }

  /** The iframe's `load`: the desk has 15 seconds to say hello (a page the browser refused fires no error). */
  frameLoaded(): void {
    if (this.port || this.disposed || this.status.phase === 'failed') return;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      this.fail(
        `The desk at ${this.origin} did not answer. Check that it is served with the headers it needs`,
      );
    }, DESK_HELLO_TIMEOUT_MS);
  }

  /** Close: the desk's state (`save`), stored, then the panel closes. */
  async close(): Promise<void> {
    if (this.port && this.opened && !this.disposed && !this.closing) {
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

  /** Stops listening, timers and the port (the panel unmounts). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.o.host.removeEventListener('message', this.onWindowMessage);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.helloTimer = this.writeTimer = null;
    for (const resolve of this.saves.values()) resolve(null);
    this.saves.clear();
    this.port?.close();
    this.port = null;
  }

  private set(patch: Partial<DeskStatus>): void {
    this.status = { ...this.status, ...patch };
    this.o.onStatus(this.status);
  }

  private log(message: string, data?: unknown): void {
    this.o.log?.(message, data);
  }

  private fail(message: string): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.set({ phase: 'failed', line: message, failure: message });
  }

  private onWindowMessage = (event: MessageEvent): void => {
    const frame = this.o.frame();
    // only the desk's own window, from the desk's origin
    if (this.disposed || !frame || event.source !== (frame as unknown) || event.origin !== this.origin)
      return;
    const hello = DeskHelloSchema.safeParse(event.data);
    if (!hello.success) {
      this.log('ignored a window message that is not a hello', event.data);
      return;
    }
    const version = DESK_PROTOCOL_VERSIONS.find((v) => hello.data.versions.includes(v));
    if (version === undefined) {
      this.fail(
        `This desk speaks protocol versions ${hello.data.versions.join(', ')}; this studio speaks ${DESK_PROTOCOL_VERSIONS.join(', ')}`,
      );
      return;
    }
    this.connect(frame, version);
  };

  private connect(frame: DeskWindow, version: number): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    // a desk that loaded again is connected again
    this.port?.close();
    const channel = this.o.channel ? this.o.channel() : new MessageChannel();
    const port = channel.port1 as DeskPort;
    port.onmessage = (event) => this.onPortMessage(port, event.data);
    this.port = port;
    this.opened = false;
    const connect = DeskConnectSchema.parse({ protocol: DESK_PROTOCOL, type: 'connect', version });
    frame.postMessage(connect, this.origin, [channel.port2]);
    this.set({ phase: 'opening', line: 'Opening the scene…', failure: null });
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
            : `This browser cannot render the reference clips: ${exp.reason ?? 'the desk gave no reason'}`,
        });
        if (!this.opened) {
          this.opened = true;
          void this.open(port);
        }
        return;
      }
      case 'opened':
        if (m.sceneId !== this.sceneId) this.log('the desk opened another scene', m.sceneId);
        this.set({ phase: 'open', line: `Opened from ${SOURCES[m.source]}` });
        return;
      case 'state': {
        if (m.sceneId !== this.sceneId) {
          this.log('ignored a state of another scene', m.sceneId);
          return;
        }
        this.latest = m.state;
        this.dirty = true;
        const waiter = m.id ? this.saves.get(m.id) : undefined;
        if (m.id && waiter) {
          this.saves.delete(m.id);
          waiter(m.state);
        }
        this.scheduleWrite();
        return;
      }
      case 'progress':
        this.set({ line: `Rendering the clips: ${PHASES[m.phase]} ${m.done} of ${m.total}` });
        return;
      case 'result':
        this.results = this.results.then(() => this.applyResult(port, m));
        return;
      case 'error': {
        const text =
          m.code === 'state_unreadable'
            ? 'The stored desk could not be read; the scene was staged from the brief'
            : m.message;
        this.log(`the desk reported ${m.code}`, m);
        this.set({ line: text });
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

  /** `open`: the brief, the stored state (or none) and the options, once per connection. */
  private async open(port: DeskPort): Promise<void> {
    const stored = await this.stored;
    if (port !== this.port || this.disposed) return;
    let scene: DeskBrief;
    try {
      scene = this.o.brief();
    } catch (err) {
      this.fail(messageOf(err));
      return;
    }
    this.sceneId = scene.id;
    let state: DeskState | null = null;
    const transfer: ArrayBuffer[] = [];
    if (this.latest) {
      // a desk that loaded again gets the newest state of this panel (a copy: the panel keeps its own)
      state = { ...this.latest, data: this.latest.data.slice(0) };
      transfer.push(state.data);
    } else if (
      stored &&
      !this.storedSent &&
      stored.format === DESK_STATE_FORMAT &&
      stored.version === DESK_STATE_VERSION
    ) {
      state = { format: DESK_STATE_FORMAT, version: DESK_STATE_VERSION, data: stored.data };
      transfer.push(stored.data);
      this.storedSent = true;
    }
    try {
      this.post({ type: 'open', scene, state, options: this.o.options() }, transfer);
    } catch (err) {
      this.fail(`The scene could not be sent to the desk: ${messageOf(err)}`);
    }
  }

  /** While the desk stays open its newest state is stored at most every 10 minutes, when it changed. */
  private scheduleWrite(): void {
    if (this.writeTimer || this.disposed || this.closing) return;
    const wait = Math.max(0, this.lastWrite + DESK_STATE_WRITE_INTERVAL_MS - Date.now());
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.storeLatest();
    }, wait);
  }

  /** Stores the newest state unless the server holds the same bytes already (one write at a time). */
  private storeLatest(): Promise<void> {
    const run = async () => {
      const state = this.latest;
      if (!state || !this.dirty) return;
      this.dirty = false;
      try {
        // a page that cannot hash (no crypto.subtle) sends the state: the server keeps the same bytes only once
        const sha = await (this.o.sha256 ?? sha256Hex)(state.data).catch(() => null);
        if (sha !== null && sha === this.storedSha) return;
        this.set({ line: 'Storing the desk…' });
        this.storedSha = await this.o.store(state);
        this.lastWrite = Date.now();
        this.set({ line: 'Desk stored' });
      } catch (err) {
        this.dirty = true;
        this.log('the desk state was not stored', err);
        this.set({ line: `The desk could not be stored: ${messageOf(err)}` });
        this.o.onToast(`The desk could not be stored: ${messageOf(err)}`, 'error');
      }
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  /** A result: the newest state stored first, then the shots attached and acknowledged. */
  private async applyResult(port: DeskPort, result: DeskResultMessage): Promise<void> {
    this.set({ line: 'Attaching the clips the desk rendered…' });
    await this.storeLatest();
    let ack: DeskAck;
    try {
      ack = await this.o.applyResult(result);
    } catch (err) {
      ack = { ok: false, message: `The result was not applied: ${messageOf(err)}`, shots: [] };
    }
    if (port === this.port && !this.disposed)
      this.post({ type: 'result-ack', id: result.id, ok: ack.ok, message: ack.message, shots: ack.shots });
    this.o.onToast(ack.message, ack.ok ? 'success' : 'warning');
    if (!this.disposed) this.set({ line: ack.message });
  }

  /** The newest state stored, then the panel closes (Close, or the desk's own Done or Close). */
  private finish(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.writeTimer) clearTimeout(this.writeTimer);
      this.writeTimer = null;
      this.set({ phase: 'closing', line: 'Storing the desk…' });
      await this.results;
      await this.storeLatest();
      this.dispose();
      this.set({ phase: 'closed' });
      this.o.onClosed();
    })();
    return this.closing;
  }
}

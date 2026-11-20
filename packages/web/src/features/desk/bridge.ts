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
  type DeskBriefOptions,
  type DeskBriefPinSlot,
  DeskConnectSchema,
  type DeskErrorCode,
  DeskErrorMessageSchema,
  DeskHelloSchema,
  type DeskOpenOptions,
  type DeskOpenUnit,
  type DeskResultMessage,
  type DeskState,
  type DeskStateUnit,
  type DeskStateUnitUse,
  DeskToHostMessageSchema,
  type DeskUnitAckMessage,
  type DeskUnitPublishMessage,
  type DeskUnitsCapability,
  type DeskUnitsOption,
  deskBriefPins,
  deskOrigin,
  deskText,
  deskUnitPinsToSend,
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
   * desk could not read it, another session changed it (a `412` naming a stored state) or cleared it (a `412` without
   * one). The panel says so and offers Replace the stored desk state (`replace()`); null while states are stored as
   * usual.
   */
  kept: { reason: DeskKeptReason; notice: string } | null;
}

/** Why the stored state is kept: what the notice and Replace's confirmation say. */
export type DeskKeptReason = 'unreadable' | 'conflict' | 'cleared';

/**
 * The state a write replaces (docs/design/director-desk.md#when-rideo-stores-it): `If-Match` with the sha256 of the
 * state the panel last loaded or stored (`*`: one whose sha256 is not known), or `If-None-Match: *` when none is stored;
 * `replace` when the person chose to replace it (Replace the stored desk state): the write is a commit of its own, so
 * the project's history keeps the state it replaces.
 */
export type DeskStorePrecondition = ({ ifMatch: string } | { ifNoneMatch: '*' }) & { replace?: true };

/**
 * A write refused because the server holds another state than the one it named (`412` `desk_state_conflict`): another
 * session stored one (or restored an older one), or cleared it.
 */
export class DeskStateConflict extends Error {
  constructor(
    /** The stored state's sha256 (its ETag); null when the clip names none. */
    readonly stored: string | null,
    message = 'the stored desk state is not the one this write replaces',
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
  /** The clip's brief, as `open` sends it: with the pins of the kinds the desk announced when the open has units. */
  brief: (options?: DeskBriefOptions) => DeskBrief;
  options: () => DeskOpenOptions;
  /** The stored state (`GET desk-state`), null when none is stored (`204`); any other answer rejects, a `404` too. */
  load: () => Promise<StoredDeskState | null>;
  /**
   * Stores a state (`PUT desk-state`) over the one the precondition names: the sha256 the server holds. Rejects with
   * `DeskStateConflict` when the server holds another state. `signal` aborts it (closing waits at most
   * `DESK_CLOSE_STORE_TIMEOUT_MS`); a write on the way out of the panel has none. `units` is what the state uses of
   * the library, as its `state` message said (`X-Desk-State-Units`); null when not known.
   */
  store: (
    state: DeskState,
    precondition: DeskStorePrecondition,
    signal?: AbortSignal,
    units?: readonly DeskStateUnitUse[] | null,
  ) => Promise<string>;
  /** Clears the stored state (`DELETE desk-state`): Start over. */
  clear: () => Promise<void>;
  /**
   * Applies a result (docs/design/director-desk.md#the-result) with the brief the desk was opened with and the shots
   * the brief retimed since the desk staged them (`opened.changes.retimed`), both of the connection the result came
   * on: what `result-ack` says.
   */
  applyResult: (result: DeskResultMessage, opened: DeskOpenedWith) => Promise<DeskAck>;
  onStatus: (status: DeskStatus) => void;
  onToast: (message: string, level: 'info' | 'success' | 'warning' | 'error') => void;
  /** The panel closes. */
  onClosed: () => void;
  channel?: () => { port1: DeskPort; port2: Transferable };
  sha256?: (data: ArrayBuffer) => Promise<string>;
  log?: (message: string, data?: unknown) => void;
  /**
   * The states this tab sent for this clip (`deskStatesSent`), shared with the clip's earlier and later panels: a `412`
   * that names one of them is no conflict, until the tab saw the server move past it. Without it the bridge remembers
   * only its own.
   */
  sent?: Map<string, DeskSentState>;
  /** Library units (docs/design/director-desk.md#library-units): without it, no open has them. */
  units?: DeskUnitsHost;
}

/** What the bridge needs of the studio for library units (`features/desk/units.ts`). */
export interface DeskUnitsHost {
  /** Whether the person may publish to the library (`open.options.units.publish`); read at each open. */
  mayPublish: () => boolean;
  /** What the stored state of that sha256 uses (`clip.deskState.units`); null when not known. */
  storedUses: (sha256: string | null) => readonly DeskStateUnitUse[] | null;
  /** The files of the pins an open sends (`fetchDeskUnits`): `units` in slot order, the others left out and why. */
  fetch: (
    pins: readonly DeskBriefPinSlot[],
    progress: (done: number, total: number) => void,
    signal: AbortSignal,
  ) => Promise<{ units: DeskOpenUnit[]; left: readonly { slot: string; why: string }[] }>;
  /** A `unit-publish`, saved to the library and linked (`publishDeskUnit`). */
  publish: (
    message: DeskUnitPublishMessage,
    opened: { readOnly: boolean },
  ) => Promise<DeskUnitPublishOutcome>;
}

/** A publish's answer: the `unit-ack`, and what the panel's status line and toast say. */
export interface DeskUnitPublishOutcome {
  ack: DeskUnitAckMessage;
  notice: string;
  level: 'success' | 'info' | 'warning';
}

/**
 * A state this tab sent for a clip (docs/design/director-desk.md#when-rideo-stores-it): the earliest panel that sent it
 * (its bridge's generation), on the tab's clock when its last write was sent and when that write was stored (null: no
 * answer yet, or the answer was lost or the write aborted, so it may still land), and the state that write named as
 * the one it replaces (its `If-Match`; null for `If-None-Match: *`), the only one it can land over.
 */
export interface DeskSentState {
  generation: number;
  sentAt: number;
  answeredAt: number | null;
  over: string | null;
}

/** What a result is applied with: the brief and the retimed shots of the `open` it answers. */
export interface DeskOpenedWith {
  brief: DeskBrief | null;
  retimed: readonly string[];
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

/**
 * A write refused with a `412` that names a stored state: another session stored it, or restored an older one
 * (docs/design/director-desk.md#the-desk). Until Replace, the changes live only in this browser's copy of the scene,
 * which the desk drops at its next open when the stored state is another staging.
 */
export const DESK_CONFLICT_NOTICE =
  "Another session changed the stored desk state of this clip, and it was kept: changes made here are not stored until you replace it. If it is another staging of the scene, the desk drops this browser's copy the next time it opens unless you replace it.";
/** A write refused with a `412` without an `ETag`: another session cleared the stored state. */
export const DESK_CLEARED_NOTICE =
  'Another session cleared the stored desk state of this clip: changes made here are not stored until you replace it.';
/** The desk could not read the state handed over (`state_unreadable`): its own message, as a sentence of its own. */
export function deskUnreadableNotice(message: string): string {
  const said = deskText(message.trim());
  const sentence = said && `${said[0]!.toUpperCase()}${said.slice(1)}${/[.!?…]$/.test(said) ? '' : '.'}`;
  return [
    'The stored desk state was kept.',
    sentence,
    'Changes made here are not stored until you replace it.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * What a write outcome was: `same` the stored bytes again, `skipped` nothing to store (or the stored state is kept),
 * `superseded` a later panel of the clip in this tab stored a newer state.
 */
type StoreOutcome = 'stored' | 'same' | 'skipped' | 'failed' | 'conflict' | 'superseded';

/**
 * The states this tab sent, per clip, by sha256 (docs/design/director-desk.md#when-rideo-stores-it), until the tab sees
 * the server is past one: a state whose write was refused for another state is forgotten at once; one whose write was
 * stored, once the answer to a request sent after that (a load, a write, a Start over's clear) names another stored
 * state; one whose write was never answered, once the answer to a request sent after it names a state other than the
 * one that write replaces. That state coming back later (a restore by another session) is a conflict like any other.
 * Module-level, so it outlives a panel: the next panel of the clip knows what the last one sent on its way out.
 */
const SENT = new Map<string, Map<string, DeskSentState>>();
/** The states remembered per clip: the ones sent longest ago are forgotten past this many. */
export const DESK_SENT_MAX = 64;
/** Bridges in the order they were made: a later panel has a higher generation. */
let generations = 0;
/** The tab's clock for the states it sent: a tick per request sent and per answer, across every panel. */
let ticks = 0;

/** The states this tab sent for one clip (`key`: the project and the clip), for its bridges' `sent`. */
export function deskStatesSent(key: string): Map<string, DeskSentState> {
  const sent = SENT.get(key) ?? new Map<string, DeskSentState>();
  SENT.set(key, sent);
  return sent;
}

/** The sha256 of the bytes in lowercase hex, as the server's `ETag` and `media.hash` give it. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** "30 s", "1 min", "10 min". */
const wait = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

type Timer = ReturnType<typeof setTimeout>;
/** A kept stored state: why, the notice, and the state a Replace names (`If-Match`; null: none, `If-None-Match: *`). */
type Kept = { reason: DeskKeptReason; notice: string; etag: string | null };

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
   * state `etag` names (the one a `412` reported; null after a clear).
   */
  private kept: Kept | null = null;
  /** The kept state when closing began (Close, or the desk's own close): a `412` met while closing holds the panel. */
  private keptAtClose: Kept | null | undefined = undefined;
  /**
   * The person replaced a kept state: the next write that stores is marked as a Replace (a commit of its own), until
   * one is stored.
   */
  private replacing = false;
  /** Replace asked the desk for its state (`save`, this id): the first state that comes is stored at once. */
  private replaceSave: string | null = null;
  /** The `open` sent on this connection carried a state, which `state_unreadable` is about. */
  private handedOver = false;
  /** The brief of the last `open`: a result's plan tells what the desk changed from what rideo changed. */
  private brief: DeskBrief | null = null;
  /**
   * The shots the brief retimed since the desk staged them, as the desk's `opened` said (`changes.retimed`): no later
   * message updates it, so it tells a result's refusals apart only for a shot without its own `brief_length` issue.
   */
  private retimed: readonly string[] = [];
  /** The states this tab sent for the clip, and this panel's place among the clip's panels (docs/…#when-rideo-stores-it). */
  private readonly sent: Map<string, DeskSentState>;
  private readonly generation = ++generations;
  /** The scene the desk was opened on: states are kept, and stored, only once `open` was sent (stored state loaded). */
  private sceneId: string | null = null;
  /** The newest state the desk sent, and whether it may differ from the stored one. */
  private latest: DeskState | null = null;
  /** What the newest state uses of the library, as its `state` said; undefined when not known. */
  private latestUnits: readonly DeskStateUnit[] | undefined = undefined;
  /** The desk's library units capability (`ready`), and the `options.units` of this connection's `open`. */
  private capability: DeskUnitsCapability | null = null;
  private unitsOpen: DeskUnitsOption | null = null;
  /** The open on this connection was read-only: a publish is never linked. */
  private openReadOnly = false;
  /** The open being prepared (its unit files fetched) on this port, and how its fetches are stopped. */
  private preparing: DeskPort | null = null;
  private unitsAbort: AbortController | null = null;
  /** Publishes, one at a time in the order they come. */
  private publishes: Promise<void> = Promise.resolve();
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
    this.sent = o.sent ?? new Map();
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
    const since = ++ticks;
    this.stored = Promise.resolve()
      .then(() => this.o.clear())
      .then(
        () => {
          this.log('the stored desk state was cleared (Start over)');
          this.loadFailure = null;
          this.storedSha = null;
          this.passed(null, since);
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
   * over it now, naming the state the notice was about (a state a third session stored meanwhile is refused again; none
   * after a clear) and marked as a Replace (a commit of its own, so the project's history keeps the state it replaces),
   * and later states are stored as usual. A desk that sent no state yet (it sends none after it could not read the one
   * handed over, until the person edits) is asked for the one it holds (`save`): its answer, however late, or any state
   * that comes first, is stored at once; an `error` answering the `save` ends the wait.
   */
  replace(): void {
    if (this.disposed || !this.kept) return;
    if (this.kept.reason !== 'unreadable') this.storedSha = this.kept.etag;
    this.log('the person replaces the stored desk state', { reason: this.kept.reason });
    this.kept = null;
    this.replacing = true;
    this.set({ kept: null });
    if ((this.latest && this.dirty) || !this.port || !this.openSent || this.leaving) {
      void this.storeLatest();
      return;
    }
    const id = `save-${++this.requests}`;
    this.replaceSave = id;
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
    this.replaceSave = null;
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
   * Loads the stored state. Anything but a state rideo reads or none (`204`) fails the panel with Retry and Start over:
   * the desk is not opened without it (it would stage the brief or its own copy, and the next store would replace the
   * stored state with that).
   */
  private loadStored(): void {
    const since = ++ticks;
    this.stored = Promise.resolve()
      .then(() => this.o.load())
      .then(async (s) => {
        if (s && (s.format !== DESK_STATE_FORMAT || s.version !== DESK_STATE_VERSION))
          throw new Error(
            `it is in a format this studio does not read (${deskText(s.format || 'none')}, version ${s.version})`,
          );
        // the state a write names: its ETag, else the sha256 of its bytes, else any stored state (`*`)
        this.storedSha = s ? s.sha256 || (await this.hash(s.data)) || '*' : null;
        if (this.storedSha !== '*') this.passed(this.storedSha, since);
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
    // the capability and the units are this connection's: a desk that loads again says them again
    this.capability = this.unitsOpen = null;
    this.unitsAbort?.abort();
    this.unitsAbort = null;
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
  private keep(reason: DeskKeptReason, notice: string, etag: string | null): void {
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
        // the desk reads no error of the host: a publish waits for its unit-ack, so it gets one at once too
        if (type === 'unit-publish') this.refuseUnreadablePublish(id, issues);
      }
      return;
    }
    const m = parsed.data;
    switch (m.type) {
      case 'ready': {
        // read leniently: a capability rideo cannot use is no units, never a refused ready
        this.capability = m.capabilities.units ?? null;
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
        // a result's refusals tell a shot the brief retimed (Update shots) from a length changed in the desk, for a
        // shot whose result carries no brief_length issue of the desk's own
        this.retimed = m.changes?.retimed ?? [];
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
        // what it uses goes with its bytes: rows that did not validate, or none, are not known
        this.latestUnits = m.units;
        this.dirty = true;
        waiter?.(m.state);
        if (this.replaceSave && !this.kept) {
          // the first state after Replace (its save's answer, however late, or one the desk sent first): stored now
          this.replaceSave = null;
          void this.storeLatest();
          return;
        }
        this.scheduleWrite();
        return;
      }
      case 'progress':
        this.show(`Rendering the clips: ${PHASES[m.phase]} ${m.done} of ${m.total}`);
        return;
      case 'result': {
        // the brief the desk rendered from: a later open on another connection may bring another
        const opened: DeskOpenedWith = { brief: this.brief, retimed: this.retimed };
        this.results = this.results
          .then(() => this.applyResult(port, m, opened))
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
        // the desk answered Replace's save with an error: the wait ends, later states are stored as usual
        if (m.id && m.id === this.replaceSave) this.replaceSave = null;
        if (m.code === 'state_unreadable' && this.handedOver) {
          // the desk could not read the state rideo handed over: it is kept, whatever the desk stages instead
          this.keep('unreadable', deskUnreadableNotice(m.message), this.storedSha);
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
      case 'unit-publish': {
        if (!this.o.units || !this.unitsOpen?.publish) {
          // no desk should send one: answered at once, so it never waits out its timeout
          this.log('refused a unit-publish on an open without units, or without publish', m.id);
          this.post({
            type: 'unit-ack',
            id: m.id,
            ok: false,
            code: 'refused',
            message: this.unitsOpen ? 'you may not publish to the library' : 'this open has no library units',
          });
          return;
        }
        const opened = { readOnly: this.openReadOnly };
        this.publishes = this.publishes
          .then(() => this.publishUnit(port, m, opened))
          .catch((err: unknown) => this.log('a unit-publish was not answered', err));
        return;
      }
      case 'close':
        void this.finish();
        return;
    }
  }

  /**
   * A `unit-publish` that does not validate (a newer desk's unit format, a kind or `meta` this studio does not read):
   * answered `unit-ack` `invalid` at once, so the desk never waits out its timeout, and said in a notice; nothing is
   * uploaded (docs/design/director-desk.md#publishing-and-linking).
   */
  private refuseUnreadablePublish(id: string, issues: string): void {
    const said = deskText(`this studio cannot read the publish: ${issues}`);
    this.log('refused a unit-publish it cannot read', id);
    try {
      this.post({ type: 'unit-ack', id, ok: false, code: 'invalid', message: said });
    } catch (err) {
      this.log('the unit-ack was not sent', err);
    }
    const notice = `Not saved to the library: ${said}`;
    this.o.onToast(notice, 'warning');
    this.show(notice);
  }

  /** A `unit-publish`, published and linked; its `unit-ack` on the connection it came on, and a notice. */
  private async publishUnit(
    port: DeskPort,
    message: DeskUnitPublishMessage,
    opened: { readOnly: boolean },
  ): Promise<void> {
    this.show(`Saving ${deskText(message.name)} to the library…`);
    let out: DeskUnitPublishOutcome;
    try {
      out = await this.o.units!.publish(message, opened);
    } catch (err) {
      const said = deskText(messageOf(err)).slice(0, 2000) || 'failed';
      out = {
        ack: { type: 'unit-ack', id: message.id, ok: false, code: 'failed', message: said },
        notice: `Not saved to the library: ${said}`,
        level: 'warning',
      };
    }
    this.log('a unit-publish was answered', out.ack);
    if (port === this.port && !this.disposed) {
      try {
        this.post(out.ack);
      } catch (err) {
        this.log('the unit-ack was not sent', err);
      }
    }
    // the toast says it even after the panel closed
    this.o.onToast(out.notice, out.level);
    this.show(out.notice);
  }

  /**
   * `open`, once per connection, once the stored state is loaded: the brief, the newest state the panel holds (the
   * desk's newest `state`, else the stored one; a copy of its bytes is transferred, the panel keeps the original) and
   * the options.
   */
  private async open(port: DeskPort): Promise<void> {
    const loaded = await this.stored;
    if (
      !loaded ||
      port !== this.port ||
      this.openSent ||
      this.preparing === port ||
      this.disposed ||
      this.leaving
    )
      return;
    // library units only for a desk that announced them, when the studio offers them
    // (docs/design/director-desk.md#negotiation): else the open of before, byte for byte
    const capability = this.o.units ? this.capability : null;
    const units: DeskUnitsOption | null = capability
      ? { version: 1, publish: this.o.units!.mayPublish() }
      : null;
    let scene: DeskBrief;
    try {
      scene = capability ? this.o.brief({ units: { kinds: capability.kinds } }) : this.o.brief();
    } catch (err) {
      this.fail(messageOf(err));
      return;
    }
    let files: DeskOpenUnit[] = [];
    if (units) {
      this.preparing = port;
      try {
        files = await this.unitFiles(port, scene, loaded.state);
      } finally {
        if (this.preparing === port) this.preparing = null;
      }
      // Close, or a desk that loaded again, while the files came: this open is not sent
      if (port !== this.port || this.openSent || this.disposed || this.leaving) return;
    }
    const source: DeskState | null =
      this.latest ??
      (loaded.state
        ? { format: DESK_STATE_FORMAT, version: DESK_STATE_VERSION, data: loaded.state.data }
        : null);
    const state = source ? { ...source, data: source.data.slice(0) } : null;
    const options = { ...this.o.options(), ...(units ? { units } : {}) };
    try {
      this.post({ type: 'open', scene, state, options, ...(files.length ? { units: files } : {}) }, [
        ...(state ? [state.data] : []),
        ...files.map((f) => f.unit.data),
      ]);
    } catch (err) {
      this.fail(`The scene could not be sent to the desk: ${messageOf(err)}`);
      return;
    }
    this.openSent = true;
    this.handedOver = state !== null;
    this.sceneId = scene.id;
    this.brief = scene;
    this.unitsOpen = units;
    this.openReadOnly = !!options.readOnly;
    // this connection's `opened` says which shots the brief retimed
    this.retimed = [];
  }

  /**
   * The unit files an open sends (docs/design/director-desk.md#unit-bytes-in-open): every pin of the brief once per
   * version, but those the state handed over already uses (the desk's newest state's rows, else the stored state's);
   * the status line counts them as they come, and Close stops them. A file that does not come is left out (logged).
   */
  private async unitFiles(
    port: DeskPort,
    scene: DeskBrief,
    stored: StoredDeskState | null,
  ): Promise<DeskOpenUnit[]> {
    const host = this.o.units!;
    const uses = this.latest ? (this.latestUnits ?? null) : stored ? host.storedUses(this.storedSha) : null;
    const pins = deskUnitPinsToSend(deskBriefPins(scene), uses);
    if (!pins.length) return [];
    const abort = new AbortController();
    this.unitsAbort = abort;
    const line = (done: number) => {
      if (port === this.port && !this.disposed)
        this.show(`Getting the scene's library units (${done} of ${pins.length})…`);
    };
    line(0);
    try {
      const got = await host.fetch(pins, line, abort.signal);
      for (const left of got.left) this.log(`a library unit was left out of the open (${left.why})`, left);
      return abort.signal.aborted ? [] : got.units;
    } catch (err) {
      this.log('the library units were not fetched', err);
      return [];
    } finally {
      if (this.unitsAbort === abort) this.unitsAbort = null;
    }
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
   * replaces (and marked as a Replace after the person replaced a kept state); nothing while the stored state is kept. A
   * write that fails is tried again with a backoff (30 seconds, doubling, at most 10 minutes) and said in one toast until
   * a write succeeds; a final write (closing, or leaving the panel) is not tried again, and its failure is said in a
   * toast. A `412` keeps the stored state: nothing more is stored on its own
   * (docs/design/director-desk.md#when-rideo-stores-it), unless it names a state this tab sent itself and has not seen
   * the server move past: one this panel or an earlier panel of the clip sent is taken as the stored one and the write
   * tried once more at once (a lost answer, an earlier panel's write that landed late); a panel on its way out that
   * meets one a later panel sent drops its write.
   */
  private storeLatest(
    how: { final?: boolean; signal?: AbortSignal | null; interval?: boolean } = {},
  ): Promise<StoreOutcome> {
    const final = how.final ?? false;
    const signal = how.signal === undefined ? this.aborts.signal : (how.signal ?? undefined);
    const run = async (): Promise<StoreOutcome> => {
      const state = this.latest;
      // what it uses, sent with it (`X-Desk-State-Units`); null when not known
      const units = this.latestUnits ? this.latestUnits.map(({ sha256: _sha256, ...use }) => use) : null;
      if (!state || !this.dirty || !this.sceneId || this.kept) return 'skipped';
      // the 10 minutes' write waited for a write that started them again (a state came while that one was stored)
      if (how.interval && Date.now() - this.lastWrite < DESK_STATE_WRITE_INTERVAL_MS) {
        this.scheduleWrite();
        return 'skipped';
      }
      this.dirty = false;
      // a page that cannot hash (no crypto.subtle) sends the state: the server keeps the same bytes only once
      const sha = await this.hash(state.data);
      for (let retried = false; ; retried = true) {
        // the tick this request is sent at: what its answer says about the stored state is from after it
        const since = ++ticks;
        try {
          if (sha !== null && sha === this.storedSha) {
            this.replacing = false;
            return 'same';
          }
          this.show('Storing the desk…');
          const replace = this.replacing;
          const pre: DeskStorePrecondition = replace
            ? { ...this.precondition(), replace: true }
            : this.precondition();
          if (sha !== null) this.remember(sha, since, 'ifMatch' in pre ? pre.ifMatch : null);
          const stored = await this.o.store(state, pre, signal, units);
          this.storedSha = stored;
          if (sha !== null) this.answered(sha, since);
          this.passed(stored, since);
          if (replace) this.replacing = false;
          this.lastWrite = Date.now();
          this.failures = 0;
          // any write starts the 10 minutes again (the one before a result too)
          if (this.writeTimer) clearTimeout(this.writeTimer);
          this.writeTimer = null;
          this.show('Desk stored');
          if (this.dirty) this.scheduleWrite();
          return 'stored';
        } catch (err) {
          if (err instanceof DeskStateConflict) {
            // refused: this write did not land, and the server held `err.stored` after it was sent
            if (sha !== null) this.refused(sha, since);
            this.passed(err.stored, since);
            const own = err.stored === null ? undefined : this.sent.get(err.stored);
            if (own && own.generation <= this.generation && !retried) {
              // a state this tab sent (its answer was lost, or an earlier panel's write landed late): no conflict
              this.log('the stored desk state is one this tab sent: stored over it', err.stored);
              // it landed, as the 412 says: the next stored write leaves it behind
              own.answeredAt ??= ++ticks;
              this.storedSha = err.stored;
              continue;
            }
            this.dirty = true;
            if (own && this.disposed) {
              // on the way out: a later panel of the clip stored the newer state
              this.log(
                'a later panel of this clip stored the desk state: this one is not stored',
                err.stored,
              );
              return 'superseded';
            }
            // another session changed the stored state, or cleared it: never replaced unseen, and not tried again
            this.log(
              'the desk state was not stored: the stored state is not the one this panel had',
              err.stored,
            );
            this.failures = 0;
            if (err.stored === null) this.keep('cleared', DESK_CLEARED_NOTICE, null);
            else this.keep('conflict', DESK_CONFLICT_NOTICE, err.stored);
            this.show('The desk was not stored');
            return 'conflict';
          }
          this.dirty = true;
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
      }
    };
    const done = this.writing.then(run, run);
    this.writing = done;
    return done;
  }

  /**
   * A state this tab sends (its write sent at `since`, replacing `over`): remembered for the clip with the earliest panel
   * that sent it, as not answered yet; past `DESK_SENT_MAX`, the state sent longest ago is forgotten.
   */
  private remember(sha: string, since: number, over: string | null): void {
    const had = this.sent.get(sha);
    this.sent.delete(sha);
    this.sent.set(sha, {
      generation: Math.min(had?.generation ?? this.generation, this.generation),
      sentAt: since,
      answeredAt: null,
      over,
    });
    while (this.sent.size > DESK_SENT_MAX) this.sent.delete(this.sent.keys().next().value as string);
  }

  /** The write of `sha` sent at `since` was stored: it landed before now. */
  private answered(sha: string, since: number): void {
    const sent = this.sent.get(sha);
    if (sent?.sentAt === since) sent.answeredAt = ++ticks;
  }

  /**
   * The write of `sha` sent at `since` was refused (the server answers a write of the bytes it holds as stored, whatever
   * its precondition, so the `412` names another state): that write never lands, and the state is forgotten, the same
   * bytes stored later being another session's.
   */
  private refused(sha: string, since: number): void {
    if (this.sent.get(sha)?.sentAt === since) this.sent.delete(sha);
  }

  /**
   * An answer to a request this tab sent at `since` says the server held `stored` (null: none) after then. A state this
   * tab sent that is not `stored` is one the server moved past, and is forgotten so that it coming back (another session
   * restored it) is a conflict like any other: one whose write was stored before `since`, and one whose write, sent
   * before `since`, was never answered and replaces another state than `stored` (it lands, if ever, only over that one).
   */
  private passed(stored: string | null, since: number): void {
    for (const [sha, sent] of this.sent) {
      if (sha === stored) continue;
      const past =
        sent.answeredAt !== null ? sent.answeredAt < since : sent.sentAt < since && sent.over !== stored;
      if (past) this.sent.delete(sha);
    }
  }

  /**
   * A result: the newest state stored first (unless the stored one is kept), then the shots attached, checked against
   * the brief the desk rendered from, and acknowledged.
   */
  private async applyResult(
    port: DeskPort,
    result: DeskResultMessage,
    opened: DeskOpenedWith,
  ): Promise<void> {
    this.show('Attaching the clips the desk rendered…');
    if (!this.leaving) await this.storeLatest();
    let ack: DeskAck;
    try {
      ack = await this.o.applyResult(result, opened);
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
    this.closingFrom();
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

  /** Closing begins (Close, or the desk's own close): the state kept then, against which a `412` met later is told. */
  private closingFrom(): void {
    if (this.keptAtClose === undefined) this.keptAtClose = this.kept;
  }

  /**
   * The newest state stored (unless the stored one is kept), then the panel closes (Close, or the desk's own Done or
   * Close). A result's uploads are not waited for (they go on, and their toast still says what was attached); the
   * write is, at most `DESK_CLOSE_STORE_TIMEOUT_MS`, then it is aborted: the person is never held in the panel. A `412`
   * met while closing, by the last write or by a write already on its way when closing began, leaves the panel open
   * with its notice: the person replaces the stored state, or Close again closes without storing.
   */
  private finish(): Promise<void> {
    if (this.closing) return this.closing;
    this.closingFrom();
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
      // a 412 met while closing (this write's, or one already on its way): the person decides, the panel stays
      const refused = !!this.kept && this.kept !== this.keptAtClose && this.kept.reason !== 'unreadable';
      if (outcome !== 'late' && refused && !this.disposed) {
        this.closing = null;
        this.closeRequest = null;
        this.keptAtClose = undefined;
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

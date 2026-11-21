import {
  type ClientMessage,
  type Notification,
  type Presence,
  type ProjectEvent,
  ServerMessageSchema,
  type StorageRequest,
  type UiCommand,
} from '@rideo/shared';
import { getToken } from './api';
import { liveUrl } from './runtime';

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface LiveHandlers {
  onEvent: (projectId: string, seq: number, event: ProjectEvent) => void;
  onResync: (projectId: string, reason: string) => void;
  onUi: (command: UiCommand) => Promise<void> | void;
  onStatus: (status: LiveStatus) => void;
  /** Something for the person in this tab (docs/design/review.md#notifications). */
  onNotification?: (notification: Notification) => void;
  /** Browser storage (docs/design/browser-storage.md#the-protocol): the workspace this tab serves, if any. */
  workspace?: () => string | null;
  /** A storage operation on this browser's workspace. */
  onStorage?: (request: StorageRequest) => void;
  /** The server serves this browser's projects (after every (re)connect). */
  onWorkspaceReady?: (projects: number) => void;
  /** The answer to an editor job's heartbeat (docs/design/editor.md#editor-jobs). */
  onJobHeartbeat?: (reply: { jobId: string; leased: boolean; cancelled: boolean }) => void;
  /**
   * The server follows the project for this tab's session now: it answered the latest `subscribe` (after every
   * (re)connect). The tab's editor jobs of the project may be claimed from here (docs/design/editor.md#editor-jobs).
   */
  onSubscribed?: (projectId: string) => void;
}

/**
 * The live channel (docs/design/realtime-sync.md): one WebSocket per tab, automatic reconnect with
 * lastSeq replay, heartbeat, presence and UI-command acknowledgements.
 */
export class LiveClient {
  private ws: WebSocket | null = null;
  private readonly subscriptions = new Map<string, number>();
  /** The `ref` of each project's latest `subscribe`: only the answer to that one counts. */
  private readonly refs = new Map<string, number>();
  private lastRef = 0;
  /** The projects the server follows for this connection's session (their latest `subscribe` answered). */
  private readonly followed = new Set<string>();
  private instanceId: string | null = null;
  private retry = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private presence: (Presence & { type: 'presence' }) | null = null;
  private closed = false;
  sessionId: string | null = null;

  constructor(private readonly handlers: LiveHandlers) {}

  connect(): void {
    this.closed = false;
    const token = getToken();
    this.handlers.onStatus('connecting');
    const ws = new WebSocket(`${liveUrl('/live')}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 20_000);
    };
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.ws = null;
      this.sessionId = null;
      this.followed.clear();
      this.handlers.onStatus('offline');
      if (!this.closed) {
        const delay = Math.min(10_000, 500 * 2 ** this.retry++);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  /** Sends a message when the socket is open (storage answers, presence). */
  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Offers this tab as a server of its browser's workspace; `changed` names projects changed here (an import). */
  attachWorkspace(changed?: string[]): void {
    const workspaceId = this.handlers.workspace?.();
    if (workspaceId && this.sessionId)
      this.send({ type: 'workspace', workspaceId, ...(changed?.length ? { changed } : {}) });
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const res = ServerMessageSchema.safeParse(parsed);
    if (!res.success) return;
    const msg = res.data;
    switch (msg.type) {
      case 'hello': {
        const restarted = this.instanceId !== null && this.instanceId !== msg.instanceId;
        this.instanceId = msg.instanceId;
        this.sessionId = msg.sessionId;
        // a new session follows nothing until the server answers its subscriptions
        this.followed.clear();
        this.handlers.onStatus('live');
        this.attachWorkspace();
        for (const [projectId, seq] of this.subscriptions) {
          if (restarted) this.handlers.onResync(projectId, 'server restarted');
          this.sendSubscribe(projectId, restarted ? undefined : seq);
        }
        if (this.presence) this.send(this.presence);
        return;
      }
      case 'event': {
        const last = this.subscriptions.get(msg.projectId);
        if (last === undefined) return;
        if (msg.seq <= last) return;
        this.subscriptions.set(msg.projectId, msg.seq);
        this.handlers.onEvent(msg.projectId, msg.seq, msg.event);
        return;
      }
      case 'resync':
        this.handlers.onResync(msg.projectId, msg.reason);
        return;
      case 'subscribed':
        // the answer to an earlier subscribe (the tab left the project since, or subscribed again) does not count
        if (!this.subscriptions.has(msg.projectId) || this.refs.get(msg.projectId) !== msg.ref) return;
        this.followed.add(msg.projectId);
        this.handlers.onSubscribed?.(msg.projectId);
        return;
      case 'ui': {
        const command = msg.command;
        Promise.resolve(this.handlers.onUi(command))
          .then(() => this.send({ type: 'ui-ack', commandId: command.id, ok: true }))
          .catch((err: unknown) =>
            this.send({ type: 'ui-ack', commandId: command.id, ok: false, error: String(err) }),
          );
        return;
      }
      case 'notification':
        this.handlers.onNotification?.(msg.notification);
        return;
      case 'storage':
        this.handlers.onStorage?.(msg);
        return;
      case 'workspace-ready':
        this.handlers.onWorkspaceReady?.(msg.projects);
        return;
      case 'job-heartbeat':
        this.handlers.onJobHeartbeat?.(msg);
        return;
      default:
        return;
    }
  }

  /** Subscribes from a snapshot's sequence number (events already in the snapshot are skipped). */
  subscribe(projectId: string, seq: number): void {
    this.subscriptions.set(projectId, seq);
    this.sendSubscribe(projectId, seq);
  }

  /** A `subscribe` with a `ref` of its own; the project is not followed until the server answers this one. */
  private sendSubscribe(projectId: string, lastSeq?: number): void {
    const ref = ++this.lastRef;
    this.refs.set(projectId, ref);
    this.followed.delete(projectId);
    this.send({ type: 'subscribe', projectId, ...(lastSeq === undefined ? {} : { lastSeq }), ref });
  }

  unsubscribe(projectId: string): void {
    this.subscriptions.delete(projectId);
    this.refs.delete(projectId);
    this.followed.delete(projectId);
    this.send({ type: 'unsubscribe', projectId });
  }

  /**
   * Whether the server follows the project for this tab's session: the session's latest `subscribe` to it was answered
   * (`subscribed`). An editor-job claim for the project is refused until then (docs/design/editor.md#editor-jobs).
   */
  follows(projectId: string): boolean {
    return this.sessionId !== null && this.followed.has(projectId);
  }

  resetSeq(projectId: string, seq: number): void {
    if (this.subscriptions.has(projectId)) this.subscriptions.set(projectId, seq);
  }

  /** An editor job's heartbeat on this socket; false when it is not open. */
  jobHeartbeat(jobId: string, progress?: { done: number; total: number; message?: string }): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.sessionId) return false;
    this.send({ type: 'job-heartbeat', jobId, ...(progress ? { progress } : {}) });
    return true;
  }

  setPresence(presence: Presence): void {
    this.presence = { type: 'presence', ...presence };
    this.send(this.presence);
  }
}

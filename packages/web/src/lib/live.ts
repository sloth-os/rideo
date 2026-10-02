import {
  type ClientMessage,
  type Notification,
  type Presence,
  type ProjectEvent,
  ServerMessageSchema,
  type UiCommand,
} from '@rideo/shared';
import { getToken } from './api';

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface LiveHandlers {
  onEvent: (projectId: string, seq: number, event: ProjectEvent) => void;
  onResync: (projectId: string, reason: string) => void;
  onUi: (command: UiCommand) => Promise<void> | void;
  onStatus: (status: LiveStatus) => void;
  /** Something for the person in this tab (docs/design/review.md#notifications). */
  onNotification?: (notification: Notification) => void;
}

/**
 * The live channel (docs/design/realtime-sync.md): one WebSocket per tab, automatic reconnect with
 * lastSeq replay, heartbeat, presence and UI-command acknowledgements.
 */
export class LiveClient {
  private ws: WebSocket | null = null;
  private readonly subscriptions = new Map<string, number>();
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
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = getToken();
    this.handlers.onStatus('connecting');
    const ws = new WebSocket(
      `${proto}://${location.host}/api/live${token ? `?token=${encodeURIComponent(token)}` : ''}`,
    );
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

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
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
        this.handlers.onStatus('live');
        for (const [projectId, seq] of this.subscriptions) {
          if (restarted) this.handlers.onResync(projectId, 'server restarted');
          this.send({ type: 'subscribe', projectId, ...(restarted ? {} : { lastSeq: seq }) });
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
      default:
        return;
    }
  }

  /** Subscribes from a snapshot's sequence number (events already in the snapshot are skipped). */
  subscribe(projectId: string, seq: number): void {
    this.subscriptions.set(projectId, seq);
    this.send({ type: 'subscribe', projectId, lastSeq: seq });
  }

  unsubscribe(projectId: string): void {
    this.subscriptions.delete(projectId);
    this.send({ type: 'unsubscribe', projectId });
  }

  resetSeq(projectId: string, seq: number): void {
    if (this.subscriptions.has(projectId)) this.subscriptions.set(projectId, seq);
  }

  setPresence(presence: Presence): void {
    this.presence = { type: 'presence', ...presence };
    this.send(this.presence);
  }
}

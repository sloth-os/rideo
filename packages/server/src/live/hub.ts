import {
  type Actor,
  ClientMessageSchema,
  newId,
  type Presence,
  type ProjectEvent,
  type ServerMessage,
  type SessionInfo,
  type UiCommand,
} from '@rideo/shared';
import type { Metrics } from '../metrics';
import { randomHex } from '../util/crypto';

export interface LiveSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', fn: (data: Buffer | string) => void): void;
  on(event: 'close', fn: () => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
}

interface Session {
  id: string;
  socket: LiveSocket;
  projects: Set<string>;
  presence: Presence | null;
  connectedAt: string;
  lastSeen: number;
}

interface Buffered {
  seq: number;
  event: ProjectEvent;
}

export type HubListener = (projectId: string, seq: number, event: ProjectEvent) => void;

const RING = 1000;
const MAX_INLINE_DOCS = 512 * 1024;
const OPEN = 1;

/** Per-project event fan-out, replay, presence and UI command relay (docs/design/realtime-sync.md). */
export class LiveHub {
  readonly instanceId = randomHex(8);
  private readonly sessions = new Map<string, Session>();
  private readonly seqs = new Map<string, number>();
  private readonly buffers = new Map<string, Buffered[]>();
  private readonly listeners = new Set<HubListener>();
  private readonly acks = new Map<string, (sessionId: string, ok: boolean, error?: string) => void>();
  private readonly closeListeners = new Set<(sessionId: string) => void>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly deps: { metrics?: Metrics; log?: { debug: (o: unknown, m?: string) => void } } = {},
  ) {
    this.heartbeat = setInterval(() => this.reap(), 20_000);
    this.heartbeat.unref();
  }

  private send(session: Session, msg: ServerMessage): void {
    if (session.socket.readyState !== OPEN) return;
    try {
      session.socket.send(JSON.stringify(msg));
    } catch {
      // socket closing; reaped by the close handler
    }
  }

  private reap(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.lastSeen > 60_000) {
        s.socket.close(4000, 'heartbeat timeout');
        this.drop(s.id);
      }
    }
  }

  private drop(id: string): void {
    if (!this.sessions.delete(id)) return;
    this.deps.metrics?.liveSessions.set({}, this.sessions.size);
    for (const l of this.closeListeners) {
      try {
        l(id);
      } catch {
        // listeners must not break session cleanup
      }
    }
  }

  /** Called once per closed session (editor jobs leased to it are released). */
  onSessionClosed(listener: (sessionId: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Whether a live session exists and follows the project (editor-job claims). */
  isSubscribed(sessionId: string, projectId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!s && (s.projects.has(projectId) || s.presence?.projectId === projectId);
  }

  attach(socket: LiveSocket, initialProject?: string): string {
    const session: Session = {
      id: newId('session'),
      socket,
      projects: new Set(),
      presence: null,
      connectedAt: new Date().toISOString(),
      lastSeen: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.deps.metrics?.liveSessions.set({}, this.sessions.size);
    socket.on('message', (raw) => this.onMessage(session, raw));
    socket.on('close', () => this.drop(session.id));
    socket.on('error', () => this.drop(session.id));
    this.send(session, {
      type: 'hello',
      sessionId: session.id,
      instanceId: this.instanceId,
      serverTime: new Date().toISOString(),
    });
    if (initialProject) session.projects.add(initialProject);
    return session.id;
  }

  private onMessage(session: Session, raw: Buffer | string): void {
    session.lastSeen = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      this.send(session, { type: 'error', message: 'invalid JSON' });
      return;
    }
    const res = ClientMessageSchema.safeParse(parsed);
    if (!res.success) {
      this.send(session, { type: 'error', message: 'invalid message' });
      return;
    }
    const msg = res.data;
    switch (msg.type) {
      case 'subscribe': {
        session.projects.add(msg.projectId);
        if (msg.lastSeq !== undefined) this.replay(session, msg.projectId, msg.lastSeq);
        break;
      }
      case 'unsubscribe':
        session.projects.delete(msg.projectId);
        break;
      case 'presence': {
        const { type: _t, ...presence } = msg;
        session.presence = presence;
        break;
      }
      case 'ui-ack':
        this.acks.get(msg.commandId)?.(session.id, msg.ok, msg.error);
        break;
      case 'ping':
        this.send(session, { type: 'pong' });
        break;
    }
  }

  private replay(session: Session, projectId: string, lastSeq: number): void {
    const current = this.seqs.get(projectId) ?? 0;
    if (lastSeq >= current) return;
    const buf = this.buffers.get(projectId) ?? [];
    const oldest = buf[0]?.seq ?? current + 1;
    if (lastSeq + 1 < oldest) {
      this.send(session, { type: 'resync', projectId, reason: 'events no longer buffered' });
      return;
    }
    for (const b of buf)
      if (b.seq > lastSeq) this.send(session, { type: 'event', projectId, seq: b.seq, event: b.event });
  }

  currentSeq(projectId: string): number {
    return this.seqs.get(projectId) ?? 0;
  }

  on(listener: HubListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(projectId: string, event: ProjectEvent): number {
    const seq = (this.seqs.get(projectId) ?? 0) + 1;
    this.seqs.set(projectId, seq);
    let wire = event;
    if (event.kind === 'commit' && event.docs && JSON.stringify(event.docs).length > MAX_INLINE_DOCS) {
      wire = { ...event, docs: null };
    }
    const buf = this.buffers.get(projectId) ?? [];
    buf.push({ seq, event: wire });
    if (buf.length > RING) buf.splice(0, buf.length - RING);
    this.buffers.set(projectId, buf);
    for (const s of this.sessions.values()) {
      if (s.projects.has(projectId)) this.send(s, { type: 'event', projectId, seq, event: wire });
    }
    for (const l of this.listeners) {
      try {
        l(projectId, seq, event);
      } catch {
        // listeners must not break publishing
      }
    }
    return seq;
  }

  activity(projectId: string, actor: Actor, action: string, summary: string): void {
    this.publish(projectId, { kind: 'activity', actor, action, summary, at: new Date().toISOString() });
  }

  /** Projects that at least one open session is subscribed to (periodic WebDAV sync). */
  subscribedProjects(): string[] {
    const ids = new Set<string>();
    for (const s of this.sessions.values()) for (const p of s.projects) ids.add(p);
    return [...ids];
  }

  sessionsFor(projectId?: string): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => !projectId || s.projects.has(projectId) || s.presence?.projectId === projectId)
      .map((s) => ({
        sessionId: s.id,
        projectIds: [...s.projects],
        presence: s.presence,
        connectedAt: s.connectedAt,
        lastSeen: new Date(s.lastSeen).toISOString(),
      }));
  }

  /** Sends a UI command to matching sessions and waits (up to timeoutMs) for acknowledgements. */
  async sendUi(
    command: Omit<UiCommand, 'id'>,
    timeoutMs = 3000,
  ): Promise<{
    commandId: string;
    delivered: string[];
    acked: { sessionId: string; ok: boolean; error?: string }[];
  }> {
    const full: UiCommand = { ...command, id: newId('command') };
    const targets = [...this.sessions.values()].filter((s) => {
      if (full.sessionId) return s.id === full.sessionId;
      if (!full.projectId) return true;
      return s.projects.has(full.projectId) || s.presence?.projectId === full.projectId;
    });
    const acked: { sessionId: string; ok: boolean; error?: string }[] = [];
    const done = new Promise<void>((resolve) => {
      if (targets.length === 0) return resolve();
      const timer = setTimeout(resolve, timeoutMs);
      this.acks.set(full.id, (sessionId, ok, error) => {
        acked.push({ sessionId, ok, ...(error ? { error } : {}) });
        if (acked.length >= targets.length) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    for (const s of targets) this.send(s, { type: 'ui', command: full });
    await done;
    this.acks.delete(full.id);
    return { commandId: full.id, delivered: targets.map((s) => s.id), acked };
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const s of this.sessions.values()) s.socket.close(1001, 'server shutting down');
    this.sessions.clear();
  }
}

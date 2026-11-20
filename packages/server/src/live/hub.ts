import {
  type Actor,
  ClientMessageSchema,
  newId,
  type Presence,
  type ProjectEvent,
  type ServerMessage,
  type SessionInfo,
  type StorageResult,
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
  /** The signed-in person (docs/design/accounts.md), for notifications. */
  userId?: string;
  /** Whether the session may follow a project (read permission); everyone may without accounts. */
  authorize?: (projectId: string) => Promise<boolean>;
  /** Presence claims so far: a claim checked against `authorize` counts only while no newer one came. */
  presenceClaims: number;
}

interface Buffered {
  seq: number;
  event: ProjectEvent;
}

export type HubListener = (projectId: string, seq: number, event: ProjectEvent) => void;

/**
 * Who a UI command may reach besides the tabs on its project (docs/design/realtime-sync.md#who-sees-and-steers-which-tabs):
 * `everyone` in auth mode none, one person whose tabs they all are (a session id reaches its tab wherever it is, a command
 * without a project every tab, as before); otherwise the caller's user (a command without a project reaches their own
 * tabs; a session id only picks one of the tabs a command reaches).
 */
export type UiReach = { everyone: true } | { userId: string | null };

const RING = 1000;
const MAX_INLINE_DOCS = 512 * 1024;
const OPEN = 1;

/** Tabs that keep projects in their browser (docs/design/browser-storage.md#the-protocol). */
export interface WorkspaceHandler {
  attach(
    session: { id: string; userId?: string; send: (msg: ServerMessage) => void },
    workspaceId: string,
    changed: string[],
  ): boolean;
  result(sessionId: string, msg: StorageResult): void;
}

/** Editor-job heartbeats sent on the live channel (docs/design/editor.md#editor-jobs). */
export type JobHeartbeatHandler = (
  sessionId: string,
  jobId: string,
  progress?: { done: number; total: number; message?: string },
) => { cancelled: boolean; leaseExpiresAt: string | null };

/** Whether a session is on a project: subscribed to it, or present on it. */
function onProject(s: Session, projectId: string): boolean {
  return s.projects.has(projectId) || s.presence?.projectId === projectId;
}

/** Per-project event fan-out, replay, presence and UI command relay (docs/design/realtime-sync.md). */
export class LiveHub {
  /** Answers `job-heartbeat` (the job queue); it throws when the job is not leased to the session. */
  jobHeartbeat?: JobHeartbeatHandler;
  /** Set when projects live in browsers: the workspace registry answers `workspace` and `storage-result`. */
  workspaceHandler?: WorkspaceHandler;
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

  /** Sends a message to every open tab of a person (notifications, docs/design/review.md#notifications). */
  notifyUser(userId: string, msg: ServerMessage): number {
    let sent = 0;
    for (const s of this.sessions.values())
      if (s.userId === userId) {
        this.send(s, msg);
        sent++;
      }
    return sent;
  }

  /** Whether a live session exists and follows the project (editor-job claims). */
  isSubscribed(sessionId: string, projectId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!s && onProject(s, projectId);
  }

  attach(
    socket: LiveSocket,
    initialProject?: string,
    opts: { userId?: string; authorize?: (projectId: string) => Promise<boolean> } = {},
  ): string {
    const session: Session = {
      id: newId('session'),
      socket,
      projects: new Set(),
      presence: null,
      connectedAt: new Date().toISOString(),
      lastSeen: Date.now(),
      userId: opts.userId,
      authorize: opts.authorize,
      presenceClaims: 0,
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
    if (initialProject) void this.follow(session, initialProject);
    return session.id;
  }

  /** Subscribes a session to a project when it may read it. */
  private async follow(session: Session, projectId: string, lastSeq?: number): Promise<void> {
    if (session.authorize && !(await session.authorize(projectId))) {
      this.send(session, { type: 'error', message: `forbidden: you may not follow ${projectId}` });
      return;
    }
    session.projects.add(projectId);
    if (lastSeq !== undefined) this.replay(session, projectId, lastSeq);
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
        void this.follow(session, msg.projectId, msg.lastSeq);
        break;
      }
      case 'unsubscribe':
        session.projects.delete(msg.projectId);
        break;
      case 'presence': {
        const { type: _t, ...presence } = msg;
        void this.claimPresence(session, presence);
        break;
      }
      case 'ui-ack':
        this.acks.get(msg.commandId)?.(session.id, msg.ok, msg.error);
        break;
      case 'ping':
        this.send(session, { type: 'pong' });
        break;
      case 'job-heartbeat': {
        if (!this.jobHeartbeat) break;
        try {
          const r = this.jobHeartbeat(session.id, msg.jobId, msg.progress);
          this.send(session, { type: 'job-heartbeat', jobId: msg.jobId, leased: true, ...r });
        } catch {
          // Not leased to this session (or no such job): the tab stops it
          this.send(session, {
            type: 'job-heartbeat',
            jobId: msg.jobId,
            leased: false,
            cancelled: false,
            leaseExpiresAt: null,
          });
        }
        break;
      }
      case 'workspace': {
        const handler = this.workspaceHandler;
        if (!handler) {
          this.send(session, { type: 'error', message: 'this studio does not keep projects in browsers' });
          break;
        }
        const ok = handler.attach(
          { id: session.id, userId: session.userId, send: (m) => this.send(session, m) },
          msg.workspaceId,
          msg.changed ?? [],
        );
        if (!ok)
          this.send(session, { type: 'error', message: 'forbidden: this workspace belongs to someone else' });
        break;
      }
      case 'storage-result':
        this.workspaceHandler?.result(session.id, msg);
        break;
    }
  }

  /**
   * A tab's presence. On a project it counts only when the session may follow that project, as a `subscribe`: a refused
   * claim is answered like a refused follow and leaves the tab present nowhere, so no UI command for that project
   * reaches it. Claims are decided in the order they arrive: an older answer never replaces a newer claim.
   */
  private async claimPresence(session: Session, presence: Presence): Promise<void> {
    const claim = ++session.presenceClaims;
    const projectId = presence.projectId;
    // nothing to ask: no project, no accounts, or a project the session follows or is present on already
    if (
      !projectId ||
      !session.authorize ||
      session.projects.has(projectId) ||
      session.presence?.projectId === projectId
    ) {
      session.presence = presence;
      return;
    }
    const allowed = await session.authorize(projectId).catch(() => false);
    if (claim !== session.presenceClaims) return;
    if (allowed) {
      session.presence = presence;
      return;
    }
    session.presence = null;
    this.send(session, { type: 'error', message: `forbidden: you may not follow ${projectId}` });
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

  /** The open sessions, on a project when given (subscribed to it or present on it). */
  sessionsFor(projectId?: string): SessionInfo[] {
    return this.sessionsWithUser(projectId).map((s) => s.session);
  }

  /** `sessionsFor` with the person each session is signed in as (UiService decides who sees which). */
  sessionsWithUser(projectId?: string): { session: SessionInfo; userId?: string }[] {
    return [...this.sessions.values()]
      .filter((s) => !projectId || onProject(s, projectId))
      .map((s) => ({
        session: {
          sessionId: s.id,
          projectIds: [...s.projects],
          presence: s.presence,
          connectedAt: s.connectedAt,
          lastSeen: new Date(s.lastSeen).toISOString(),
        },
        userId: s.userId,
      }));
  }

  /**
   * Sends a UI command and waits (up to `timeoutMs`) for acknowledgements. It goes to the tabs on its project; one
   * without a project to those `reach` allows (none when it is left out); `sessionId` picks one of these tabs and never
   * adds another, except for `everyone` (auth mode none, as before).
   */
  async sendUi(
    command: Omit<UiCommand, 'id'>,
    opts: { reach?: UiReach; timeoutMs?: number } = {},
  ): Promise<{
    commandId: string;
    delivered: string[];
    acked: { sessionId: string; ok: boolean; error?: string }[];
  }> {
    const full: UiCommand = { ...command, id: newId('command') };
    const reach = opts.reach ?? { userId: null };
    const timeoutMs = opts.timeoutMs ?? 3000;
    const targets = [...this.sessions.values()].filter((s) => {
      if ('everyone' in reach) {
        if (full.sessionId) return s.id === full.sessionId;
        return !full.projectId || onProject(s, full.projectId);
      }
      const audience = full.projectId
        ? onProject(s, full.projectId)
        : reach.userId !== null && s.userId === reach.userId;
      return audience && (!full.sessionId || s.id === full.sessionId);
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

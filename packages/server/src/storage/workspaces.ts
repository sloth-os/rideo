import { AsyncLocalStorage } from 'node:async_hooks';
import { PassThrough, Readable } from 'node:stream';
import {
  type ServerMessage,
  STORAGE_INLINE_MAX,
  type StorageOp,
  type StorageRequest,
  type StorageResult,
} from '@rideo/shared';
import { AppError } from '../errors';
import type { Metrics } from '../metrics';
import { randomHex } from '../util/crypto';
import {
  type Entry,
  PreconditionFailedError,
  type ReadResult,
  type Stat,
  type StorageBackend,
  type WriteOptions,
} from './backend';

/**
 * Browser storage (docs/design/browser-storage.md): projects kept in the IndexedDB of the browser that made them,
 * reached through the live channel of one of its open tabs. The registry knows which tabs serve which workspace and
 * which workspace holds which project, sends storage operations and moves large payloads over HTTP transfers.
 */

/** The workspace a request names (`x-rideo-workspace`, `?ws=`, `?workspace=`): where new projects go. */
export const workspaceContext = new AsyncLocalStorage<string | null>();

export function currentWorkspace(): string | null {
  return workspaceContext.getStore() ?? null;
}

const PROJECT_ID = /^prj_[0-9a-z]{10,32}$/;
const METADATA_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

interface Session {
  id: string;
  send: (msg: ServerMessage) => void;
  lastActive: number;
}

interface Workspace {
  id: string;
  /** Who attached it first since the server started; only their sessions may attach it. */
  owner: string;
  sessions: Map<string, Session>;
  /** Resolves once the workspace's projects are listed (after the first session attached). */
  ready: Promise<void> | null;
  attachedAt: number;
}

type Reply =
  | { kind: 'message'; result: unknown; data?: Buffer }
  | { kind: 'stream'; stream: Readable; size: number; start: number; end: number };

interface Pending {
  op: StorageOp;
  workspaceId: string;
  sessionId: string;
  resolve: (r: Reply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Transfer {
  data: Buffer | Readable;
  size?: number;
  contentType: string;
  timer: NodeJS.Timeout;
}

export function storageOffline(detail?: string): AppError {
  return new AppError(
    'storage_offline',
    detail ??
      'This project is stored in a browser that is not connected. Open Rideo in that browser, or move the project with a project file.',
    [],
    true,
  );
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly sessionWorkspace = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  private readonly transfers = new Map<string, Transfer>();
  private readonly waiters = new Map<string, (() => void)[]>();
  /** Projects found in a workspace when it attached (their job records are loaded). */
  onProjects?: (workspaceId: string, projectIds: string[]) => void;
  /** Projects a browser changed by itself (an import): the server drops what it cached about them. */
  onChanged?: (workspaceId: string, projectIds: string[]) => void;

  constructor(
    private readonly deps: {
      metrics?: Metrics;
      log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
      /** How long an operation waits for a workspace's tab to (re)attach. */
      waitMs?: number;
    } = {},
  ) {}

  private get waitMs(): number {
    return this.deps.waitMs ?? 5_000;
  }

  // ---- sessions (called by the live hub) ------------------------------------------------------------------------

  /** A tab offers to serve a workspace. False when the workspace belongs to someone else. */
  attach(
    session: { id: string; userId?: string; send: (msg: ServerMessage) => void },
    workspaceId: string,
    changed: string[] = [],
  ): boolean {
    const who = session.userId ?? 'studio';
    let ws = this.workspaces.get(workspaceId);
    if (ws && ws.owner !== who) {
      this.deps.log?.warn({ workspaceId, sessionId: session.id }, 'workspace attach refused: another owner');
      return false;
    }
    const previous = this.sessionWorkspace.get(session.id);
    if (previous && previous !== workspaceId) this.detach(session.id);
    if (!ws) {
      ws = { id: workspaceId, owner: who, sessions: new Map(), ready: null, attachedAt: Date.now() };
      this.workspaces.set(workspaceId, ws);
    }
    const first = ws.sessions.size === 0;
    ws.sessions.set(session.id, { id: session.id, send: session.send, lastActive: Date.now() });
    ws.attachedAt = Date.now();
    this.sessionWorkspace.set(session.id, workspaceId);
    this.deps.metrics?.workspaces.set({}, this.attachedWorkspaces().length);
    if (changed.length) this.onChanged?.(workspaceId, changed);
    if (first || !ws.ready) ws.ready = this.discover(ws, session.send);
    else void ws.ready.then(() => this.ready(ws!, session.send));
    for (const w of this.waiters.get(workspaceId) ?? []) w();
    this.waiters.delete(workspaceId);
    return true;
  }

  private ready(ws: Workspace, send: (msg: ServerMessage) => void): void {
    const projects = [...this.owners.values()].filter((w) => w === ws.id).length;
    send({ type: 'workspace-ready', workspaceId: ws.id, projects });
  }

  /** Lists the workspace's projects, so the server serves them (and resumes their jobs). */
  private async discover(ws: Workspace, send: (msg: ServerMessage) => void): Promise<void> {
    try {
      const entries = await this.storage(ws.id).list('/projects');
      const ids = entries.filter((e) => e.isDir && PROJECT_ID.test(e.name)).map((e) => e.name);
      for (const id of ids) this.owners.set(id, ws.id);
      this.deps.log?.info({ workspaceId: ws.id, projects: ids.length }, 'workspace attached');
      if (ids.length) this.onProjects?.(ws.id, ids);
      this.ready(ws, send);
    } catch (err) {
      ws.ready = null;
      this.deps.log?.warn({ workspaceId: ws.id, err: (err as Error).message }, 'workspace listing failed');
    }
  }

  detach(sessionId: string): void {
    const workspaceId = this.sessionWorkspace.get(sessionId);
    if (!workspaceId) return;
    this.sessionWorkspace.delete(sessionId);
    const ws = this.workspaces.get(workspaceId);
    ws?.sessions.delete(sessionId);
    if (ws && ws.sessions.size === 0) ws.ready = null;
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(storageOffline('The browser tab serving this project closed during the operation.'));
    }
    this.deps.metrics?.workspaces.set({}, this.attachedWorkspaces().length);
  }

  /** A tab's answer to a storage operation. */
  result(sessionId: string, msg: StorageResult): void {
    const p = this.pending.get(msg.id);
    if (!p || p.sessionId !== sessionId) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    const session = this.workspaces.get(p.workspaceId)?.sessions.get(sessionId);
    if (session) session.lastActive = Date.now();
    if (!msg.ok) {
      this.deps.metrics?.workspaceOps.inc({ op: p.op, outcome: msg.error?.code ?? 'error' });
      p.reject(browserError(msg.error));
      return;
    }
    this.deps.metrics?.workspaceOps.inc({ op: p.op, outcome: 'ok' });
    const data = msg.data !== undefined ? Buffer.from(msg.data, 'base64') : undefined;
    if (data) this.deps.metrics?.workspaceBytes.inc({ direction: 'read' }, data.length);
    p.resolve({ kind: 'message', result: msg.result, ...(data ? { data } : {}) });
  }

  // ---- routing ----------------------------------------------------------------------------------------------------

  owner(projectId: string): string | undefined {
    return this.owners.get(projectId);
  }

  assign(projectId: string, workspaceId: string): void {
    this.owners.set(projectId, workspaceId);
  }

  attached(workspaceId: string): boolean {
    return (this.workspaces.get(workspaceId)?.sessions.size ?? 0) > 0;
  }

  attachedWorkspaces(): string[] {
    return [...this.workspaces.values()].filter((w) => w.sessions.size > 0).map((w) => w.id);
  }

  /** The workspace whose tab attached last (agents without a workspace of their own create projects there). */
  mostRecent(): string | undefined {
    return [...this.workspaces.values()]
      .filter((w) => w.sessions.size > 0)
      .sort((a, b) => b.attachedAt - a.attachedAt)[0]?.id;
  }

  /** Waits (up to waitMs) for a tab of the workspace to attach and its projects to be listed. */
  async waitFor(workspaceId: string, ms = this.waitMs): Promise<boolean> {
    if (!this.attached(workspaceId)) {
      const attached = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        const list = this.waiters.get(workspaceId) ?? [];
        list.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
        this.waiters.set(workspaceId, list);
      });
      if (!attached) return false;
    }
    await this.workspaces.get(workspaceId)?.ready;
    return this.attached(workspaceId);
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  private session(workspaceId: string): Session | undefined {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return undefined;
    return [...ws.sessions.values()].sort((a, b) => b.lastActive - a.lastActive)[0];
  }

  /** Sends an operation to a tab of the workspace and waits for its answer. */
  async call(
    workspaceId: string,
    req: Omit<StorageRequest, 'type' | 'id'>,
    timeoutMs = METADATA_TIMEOUT_MS,
  ): Promise<Reply> {
    let session = this.session(workspaceId);
    if (!session) {
      if (!(await this.waitFor(workspaceId))) throw storageOffline();
      session = this.session(workspaceId);
      if (!session) throw storageOffline();
    }
    const id = randomHex(12);
    const target = session;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.deps.metrics?.workspaceOps.inc({ op: req.op, outcome: 'timeout' });
        reject(storageOffline(`The browser did not answer a storage operation (${req.op}) in time.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { op: req.op, workspaceId, sessionId: target.id, resolve, reject, timer });
      target.send({ type: 'storage', id, ...req });
    });
  }

  /** A payload the browser fetches for a write (`GET /api/workspace/transfers/:id`). */
  offer(data: Buffer | Readable, size: number | undefined, contentType = 'application/octet-stream'): string {
    const id = randomHex(16);
    const timer = setTimeout(() => {
      const t = this.transfers.get(id);
      this.transfers.delete(id);
      if (t && !Buffer.isBuffer(t.data)) t.data.destroy();
    }, TRANSFER_TIMEOUT_MS);
    timer.unref();
    this.transfers.set(id, { data, size, contentType, timer });
    return id;
  }

  /** The payload of a transfer, once. */
  take(id: string): { data: Buffer | Readable; size?: number; contentType: string } | null {
    const t = this.transfers.get(id);
    if (!t) return null;
    this.transfers.delete(id);
    clearTimeout(t.timer);
    if (Buffer.isBuffer(t.data)) this.deps.metrics?.workspaceBytes.inc({ direction: 'write' }, t.data.length);
    return t;
  }

  /**
   * The bytes of a read, sent by the browser (`PUT /api/workspace/transfers/:id`, id = the operation's). Resolves
   * when the reader has consumed or dropped them; false when no operation waits for them.
   */
  receive(
    id: string,
    workspaceId: string | null,
    body: Readable,
    meta: { size: number; start: number; end: number },
  ): Promise<boolean> {
    const p = this.pending.get(id);
    if (p?.op !== 'read' || p.workspaceId !== workspaceId) return Promise.resolve(false);
    this.pending.delete(id);
    clearTimeout(p.timer);
    this.deps.metrics?.workspaceOps.inc({ op: 'read', outcome: 'ok' });
    const stream = new PassThrough();
    let bytes = 0;
    body.on('data', (c: Buffer) => {
      bytes += c.length;
    });
    const done = new Promise<boolean>((resolve) => {
      const finish = () => {
        this.deps.metrics?.workspaceBytes.inc({ direction: 'read' }, bytes);
        resolve(true);
      };
      stream.once('close', finish);
      stream.once('end', finish);
      stream.once('error', finish);
      body.once('error', (err) => stream.destroy(err));
      body.once('aborted', () => stream.destroy(new Error('the browser stopped sending')));
    });
    body.pipe(stream);
    p.resolve({ kind: 'stream', stream, ...meta });
    return done;
  }

  /** The workspace's files as a StorageBackend (paths relative to the studio's root). */
  storage(workspaceId: string): WorkspaceStorage {
    return new WorkspaceStorage(this, workspaceId);
  }

  close(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(storageOffline('The server is reloading.'));
    }
    for (const [id, t] of this.transfers) {
      clearTimeout(t.timer);
      if (!Buffer.isBuffer(t.data)) t.data.destroy();
      this.transfers.delete(id);
    }
  }
}

function browserError(e: { code: string; message: string } | undefined): Error {
  if (e?.code === 'conflict') return new PreconditionFailedError(e.message);
  if (e?.code === 'quota')
    return new AppError('storage_error', `The browser is out of storage space: ${e.message}`);
  return new AppError('storage_error', `Browser storage: ${e?.message ?? 'the operation failed'}`);
}

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** One workspace's files: every operation is a round trip to one of its tabs. */
export class WorkspaceStorage implements StorageBackend {
  readonly kind = 'browser' as const;

  constructor(
    private readonly registry: WorkspaceRegistry,
    readonly workspaceId: string,
  ) {}

  async read(path: string): Promise<Buffer | null> {
    const r = await this.registry.call(this.workspaceId, { op: 'read', path }, TRANSFER_TIMEOUT_MS);
    if (r.kind === 'stream') return toBuffer(r.stream);
    if (r.result === null || r.result === undefined) return null;
    return r.data ?? Buffer.alloc(0);
  }

  async readStream(path: string, range?: { start: number; end?: number }): Promise<ReadResult | null> {
    const r = await this.registry.call(
      this.workspaceId,
      { op: 'read', path, ...(range ? { range } : {}) },
      TRANSFER_TIMEOUT_MS,
    );
    if (r.kind === 'stream') return { stream: r.stream, size: r.size, start: r.start, end: r.end };
    const meta = r.result as { size: number; start: number; end: number } | null | undefined;
    if (!meta) return null;
    return {
      stream: Readable.from([r.data ?? Buffer.alloc(0)]),
      size: meta.size,
      start: meta.start,
      end: meta.end,
    };
  }

  async write(
    path: string,
    data: Buffer | string | Readable,
    opts: WriteOptions = {},
  ): Promise<{ etag?: string }> {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    const conditions = {
      ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
      ...(opts.ifNoneMatch ? { ifNoneMatch: opts.ifNoneMatch } : {}),
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
    };
    let r: Reply;
    if (Buffer.isBuffer(buf) && buf.length <= STORAGE_INLINE_MAX) {
      r = await this.registry.call(this.workspaceId, {
        op: 'write',
        path,
        data: buf.toString('base64'),
        size: buf.length,
        ...conditions,
      });
    } else {
      const size = Buffer.isBuffer(buf) ? buf.length : opts.size;
      const transfer = this.registry.offer(buf, size, opts.contentType);
      r = await this.registry.call(
        this.workspaceId,
        { op: 'write', path, transfer, ...(size !== undefined ? { size } : {}), ...conditions },
        TRANSFER_TIMEOUT_MS,
      );
    }
    return (r.kind === 'message' ? (r.result as { etag?: string } | undefined) : undefined) ?? {};
  }

  async stat(path: string): Promise<Stat | null> {
    const r = await this.registry.call(this.workspaceId, { op: 'stat', path });
    return r.kind === 'message' ? ((r.result as Stat | null | undefined) ?? null) : null;
  }

  async list(dir: string): Promise<Entry[]> {
    const r = await this.registry.call(this.workspaceId, { op: 'list', path: dir });
    return r.kind === 'message' ? ((r.result as Entry[] | undefined) ?? []) : [];
  }

  async delete(path: string): Promise<void> {
    await this.registry.call(this.workspaceId, { op: 'delete', path });
  }

  async move(from: string, to: string): Promise<void> {
    await this.registry.call(this.workspaceId, { op: 'move', path: from, to });
  }

  async capabilities() {
    return { conditionalWrites: true };
  }

  externallyEditable(): boolean {
    return false;
  }
}

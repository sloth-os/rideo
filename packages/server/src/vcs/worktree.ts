import {
  type Character,
  canonicalJson,
  DOC_DIRS,
  docSpecForPath,
  jsonEqual,
  renderScreenplayMarkdown,
  type Screenplay,
  validateDoc,
} from '@rideo/shared';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { sha256 } from '../util/crypto';
import { eachLimit } from '../util/limit';
import { KeyedMutex } from '../util/mutex';
import type { Materializer } from './repo';

interface IndexEntry {
  hash: string;
  size: number;
  etag?: string;
  mtime?: number;
  /** The document's own hash (its canonical JSON: key order does not count), to tell a copy behind HEAD. */
  doc?: string;
}

export interface SyncScan {
  changes: Record<string, unknown | null>;
  issues: { path: string; error: string }[];
  inbox: { name: string; path: string; size: number }[];
}

function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function docHash(doc: unknown): string {
  return sha256(canonicalJson(doc));
}

const ROOT_DOCS = ['project.json', 'screenplay.json', 'timeline.json'];
/** How many work-tree files one batch writes at once. */
const WRITE_CONCURRENCY = 8;
/** The longest `idle()` waits. */
const IDLE_MAX_MS = 30_000;
/** The first wait before a failed batch is tried again (it doubles), and the longest. */
const RETRY_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** Runs `fn` over `items`, at most `limit` at a time. */

/**
 * The human-readable work tree on WebDAV: materializes committed documents as pretty JSON (+ screenplay.md)
 * and detects external edits made through any WebDAV client (docs/design/storage-webdav.md#external-edits).
 *
 * Materializing runs behind the commits: a commit queues its documents and returns; one batch at a time writes
 * the newest version of every queued path, so a burst of commits costs one write per path. A failed batch goes
 * back in the queue and is tried again later.
 */
export class Worktree implements Materializer {
  private index: Promise<Record<string, IndexEntry>> | null = null;
  /** Documents waiting to be written (null: delete), the newest version of each path. */
  private pending = new Map<string, unknown | null>();
  /** Every document is to be written, and files the documents lack deleted (a branch switch). */
  private everything = false;
  /** The checked-out documents as of the latest commit (screenplay.md and full rewrites read them). */
  private docs: ReadonlyMap<string, unknown> = new Map();
  private running: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  /** What this work tree adds to the pending-documents gauge. */
  private reported = 0;
  /** Batches and scans take turns: a scan never reads a file a batch is writing. */
  private readonly turns = new KeyedMutex();

  constructor(
    private readonly storage: StorageBackend,
    private readonly layout: Layout,
    private readonly projectId: string,
    private readonly log?: { warn: (obj: unknown, msg?: string) => void },
    private readonly metrics?: Metrics,
    private readonly opts: { retryMs?: number } = {},
  ) {}

  private loadIndex(): Promise<Record<string, IndexEntry>> {
    this.index ??= this.storage.read(this.layout.worktreeIndex(this.projectId)).then(
      (buf) => (buf ? (JSON.parse(buf.toString()) as Record<string, IndexEntry>) : {}),
      (err) => {
        this.index = null;
        throw err;
      },
    );
    return this.index;
  }

  private async saveIndex(): Promise<void> {
    await this.storage.write(
      this.layout.worktreeIndex(this.projectId),
      JSON.stringify(await this.loadIndex()),
      {
        contentType: 'application/json',
      },
    );
  }

  private dirOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
  }

  /** Refreshes etag/mtime of freshly written files with one listing per directory. */
  private async captureStats(paths: string[]): Promise<void> {
    const index = await this.loadIndex();
    const wanted = new Set(paths);
    const base = this.layout.project(this.projectId);
    await eachLimit([...new Set(paths.map((p) => this.dirOf(p)))], WRITE_CONCURRENCY, async (dir) => {
      const listing = await this.storage.list(dir ? `${base}/${dir}` : base).catch(() => []);
      for (const e of listing) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        const entry = index[rel];
        if (entry && wanted.has(rel)) {
          entry.etag = e.etag;
          entry.mtime = e.mtime;
          entry.size = e.size;
        }
      }
    });
  }

  private queued(): number {
    return this.pending.size + (this.everything ? this.docs.size : 0);
  }

  private track(): void {
    const now = this.queued();
    this.metrics?.worktreePending.add({}, now - this.reported);
    this.reported = now;
  }

  /** Queues a commit's documents; they are written in the background. */
  async materialize(
    changes: Record<string, unknown | null>,
    docs: ReadonlyMap<string, unknown>,
  ): Promise<void> {
    for (const [path, doc] of Object.entries(changes)) this.pending.set(path, doc);
    this.docs = docs;
    this.track();
    this.kick();
  }

  /** Queues every document (and the deletion of files they lack): a branch switch or an import. */
  async materializeAll(docs: ReadonlyMap<string, unknown>): Promise<void> {
    this.pending.clear();
    this.everything = true;
    this.docs = docs;
    this.track();
    this.kick();
  }

  /**
   * Queues the documents whose work-tree copy is not the one recorded for them (a batch lost to a crash or to a
   * failing server), when the project is loaded. It compares HEAD with the index, not with the files: a file edited
   * outside Rideo keeps its index entry, so sync still sees the edit. Entries written before documents had their own
   * hash count as current.
   */
  async reconcile(docs: ReadonlyMap<string, unknown>): Promise<void> {
    try {
      const index = await this.loadIndex();
      const stale: Record<string, unknown | null> = {};
      for (const [path, doc] of docs) {
        const entry = index[path];
        if (!entry || (entry.doc !== undefined && entry.doc !== docHash(doc))) stale[path] = doc;
      }
      for (const path of Object.keys(index)) if (!docs.has(path)) stale[path] = null;
      if (Object.keys(stale).length === 0) return;
      this.log?.warn(
        {
          projectId: this.projectId,
          paths: Object.keys(stale).slice(0, 20),
          count: Object.keys(stale).length,
        },
        'work tree behind HEAD; rewriting',
      );
      for (const [path, doc] of Object.entries(stale))
        if (!this.pending.has(path)) this.pending.set(path, doc);
      if (this.docs.size === 0) this.docs = docs;
      this.track();
      this.kick();
    } catch (err) {
      this.log?.warn({ err, projectId: this.projectId }, 'work tree check failed');
    }
  }

  /** Writes the given paths again from the current documents and waits for them (sync's discard). */
  async rematerialize(paths: string[], current: ReadonlyMap<string, unknown>): Promise<void> {
    const changes: Record<string, unknown | null> = {};
    for (const p of paths) changes[p] = current.get(p) ?? null;
    await this.materialize(changes, current);
    await this.idle();
  }

  /**
   * Resolves when nothing is queued and no batch runs, when the last batch failed (it is tried again later), or after
   * `ms`: commits that keep coming keep the queue busy.
   */
  async idle(ms = IDLE_MAX_MS): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((r) => {
      timer = setTimeout(r, ms);
    });
    const drained = (async () => {
      while (this.running) await this.running;
    })();
    await Promise.race([drained, late]);
    clearTimeout(timer);
  }

  /** Writes what is queued now, waiting at most `ms` (shutdown). */
  async flush(ms: number): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.kick();
    await this.idle(ms);
  }

  /** Starts a batch unless one runs, a failed one waits for its retry, or nothing is queued. */
  private kick(): void {
    if (this.running || this.retryTimer || this.queued() === 0) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.size || this.everything) {
      const batch = this.pending;
      const all = this.everything;
      const docs = this.docs;
      this.pending = new Map();
      this.everything = false;
      this.track();
      try {
        await this.turns.run('files', () => this.write(batch, all, docs));
        this.failures = 0;
        this.metrics?.worktreeBatches.inc({ outcome: 'ok' });
      } catch (err) {
        // Back in the queue under anything newer, and tried again after a pause
        for (const [p, d] of batch) if (!this.pending.has(p)) this.pending.set(p, d);
        this.everything ||= all;
        this.track();
        this.failures++;
        this.metrics?.worktreeBatches.inc({ outcome: 'failed' });
        const wait = Math.min(RETRY_MAX_MS, (this.opts.retryMs ?? RETRY_MS) * 2 ** (this.failures - 1));
        this.log?.warn(
          { err, projectId: this.projectId, paths: batch.size, retryInMs: wait },
          'work tree materialization failed; will retry',
        );
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.kick();
        }, wait);
        this.retryTimer.unref();
        return;
      }
    }
  }

  private async write(
    batch: Map<string, unknown | null>,
    all: boolean,
    docs: ReadonlyMap<string, unknown>,
  ): Promise<void> {
    const index = await this.loadIndex();
    const changes = new Map(batch);
    if (all) {
      for (const path of Object.keys(index))
        if (!docs.has(path) && !changes.has(path)) changes.set(path, null);
      for (const [path, doc] of docs) if (!changes.has(path)) changes.set(path, doc);
    }
    const written: string[] = [];
    await eachLimit([...changes], WRITE_CONCURRENCY, async ([path, doc]) => {
      const target = this.layout.doc(this.projectId, path);
      if (doc === null) {
        await this.storage.delete(target);
        delete index[path];
      } else {
        const bytes = serialize(doc);
        await this.storage.write(target, bytes, { contentType: 'application/json' });
        index[path] = { hash: sha256(bytes), size: Buffer.byteLength(bytes), doc: docHash(doc) };
        written.push(path);
      }
    });
    if ([...changes.keys()].some((p) => p === 'screenplay.json' || p.startsWith('characters/')))
      await this.renderMarkdown(docs);
    await this.captureStats(written);
    await this.saveIndex();
  }

  private async renderMarkdown(docs: ReadonlyMap<string, unknown>): Promise<void> {
    const sp = docs.get('screenplay.json') as Screenplay | undefined;
    if (!sp) return;
    const characters: Record<string, Character> = {};
    for (const [p, d] of docs)
      if (p.startsWith('characters/')) characters[(d as Character).id] = d as Character;
    await this.storage.write(
      this.layout.screenplayMarkdown(this.projectId),
      renderScreenplayMarkdown(sp, characters),
      {
        contentType: 'text/markdown; charset=utf-8',
      },
    );
  }

  /** Compares the work tree with the index and returns valid external changes, issues, and inbox files. */
  async scan(current: ReadonlyMap<string, unknown>): Promise<SyncScan> {
    return this.turns.run('files', () => this.scanFiles(current));
  }

  private async scanFiles(current: ReadonlyMap<string, unknown>): Promise<SyncScan> {
    const index = await this.loadIndex();
    const base = this.layout.project(this.projectId);
    const found = new Map<string, { size: number; etag?: string; mtime: number }>();
    for (const e of await this.storage.list(base))
      if (!e.isDir && ROOT_DOCS.includes(e.name)) found.set(e.name, e);
    for (const dir of DOC_DIRS) {
      for (const e of await this.storage.list(`${base}/${dir}`)) {
        if (!e.isDir && docSpecForPath(`${dir}/${e.name}`)) found.set(`${dir}/${e.name}`, e);
      }
    }
    // A listing can lag a write (OpenList caches directory listings): a file it leaves out is gone only when a
    // direct stat says so; one that is there is compared like the others (docs/design/storage-webdav.md#external-edits).
    for (const path of Object.keys(index)) {
      if (found.has(path)) continue;
      const st = await this.storage.stat(this.layout.doc(this.projectId, path));
      if (!st || st.isDir) continue;
      this.log?.warn({ projectId: this.projectId, path }, 'work-tree listing missed a file');
      found.set(path, st);
    }
    const changes: Record<string, unknown | null> = {};
    const issues: { path: string; error: string }[] = [];
    for (const [path, st] of found) {
      const entry = index[path];
      const unchanged =
        entry && entry.size === st.size && (st.etag ? entry.etag === st.etag : entry.mtime === st.mtime);
      if (unchanged) continue;
      const buf = await this.storage.read(this.layout.doc(this.projectId, path));
      if (!buf) continue;
      if (entry && sha256(buf) === entry.hash) {
        entry.etag = st.etag;
        entry.mtime = st.mtime;
        continue;
      }
      try {
        const doc = validateDoc(path, JSON.parse(buf.toString('utf8')));
        if (!jsonEqual(doc, current.get(path))) changes[path] = doc;
      } catch (err) {
        issues.push({ path, error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
      }
    }
    for (const path of Object.keys(index)) {
      if (found.has(path)) continue;
      if (path === 'project.json') {
        issues.push({ path, error: 'project.json was deleted externally; it will be restored' });
        continue;
      }
      if (current.has(path)) changes[path] = null;
    }
    const inbox = (await this.storage.list(this.layout.inbox(this.projectId)))
      .filter((e) => !e.isDir && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: e.path, size: e.size }));
    return { changes, issues, inbox };
  }
}

/**
 * This browser's project store (docs/design/browser-storage.md#workspaces): IndexedDB `rideo-workspace` with explicit
 * directory entries (a listing is one index read), file bytes apart from their entries (a move rewrites entries only)
 * and conditional writes checked inside the transaction (tabs of one browser cannot lose each other's ref updates).
 * Paths are relative to the studio's root: `/projects/prj_…/project.json`.
 */

export const DB_NAME = 'rideo-workspace';
export const DB_VERSION = 1;

export interface WorkspaceEntry {
  path: string;
  parent: string;
  isDir: boolean;
  size: number;
  etag?: string;
  mtime: number;
  contentType?: string;
  /** Key of the bytes in the `blobs` store (files). */
  blob?: string;
}

export interface WorkspaceStat {
  size: number;
  etag?: string;
  mtime: number;
  isDir: boolean;
}

export class PreconditionError extends Error {
  readonly code = 'conflict';
  constructor(path: string) {
    super(`precondition failed for ${path}`);
    this.name = 'PreconditionError';
  }
}

/** `/a//b/` → `/a/b`; '' → '/'. */
export function normPath(path: string): string {
  const p = `/${path}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return p || '/';
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
  });
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Everything under a directory (its descendants), as a key range of the `entries` store. */
function below(path: string): IDBKeyRange {
  const prefix = path === '/' ? '/' : `${path}/`;
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

export function openWorkspaceDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('entries')) {
        const entries = db.createObjectStore('entries', { keyPath: 'path' });
        entries.createIndex('parent', 'parent');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('the workspace database is blocked by another tab'));
  });
}

export class WorkspaceStore {
  constructor(private readonly db: IDBDatabase) {}

  static async open(factory?: IDBFactory): Promise<WorkspaceStore> {
    return new WorkspaceStore(await openWorkspaceDb(factory));
  }

  close(): void {
    this.db.close();
  }

  async meta<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction('meta', 'readonly');
    const row = (await req(tx.objectStore('meta').get(key))) as { key: string; value: T } | undefined;
    return row?.value;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    await done(tx);
  }

  async stat(path: string): Promise<WorkspaceStat | null> {
    const p = normPath(path);
    if (p === '/') return { size: 0, mtime: 0, isDir: true };
    const tx = this.db.transaction('entries', 'readonly');
    const e = (await req(tx.objectStore('entries').get(p))) as WorkspaceEntry | undefined;
    return e ? { size: e.size, mtime: e.mtime, isDir: e.isDir, ...(e.etag ? { etag: e.etag } : {}) } : null;
  }

  /** Depth-1 listing, sorted by name, in the server's Entry shape. */
  async list(dir: string): Promise<(WorkspaceStat & { name: string; path: string })[]> {
    const p = normPath(dir);
    const tx = this.db.transaction('entries', 'readonly');
    const rows = (await req(tx.objectStore('entries').index('parent').getAll(p))) as WorkspaceEntry[];
    return rows
      .map((e) => ({
        name: nameOf(e.path),
        path: e.path,
        size: e.size,
        mtime: e.mtime,
        isDir: e.isDir,
        ...(e.etag ? { etag: e.etag } : {}),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Every file under a directory (an export walks a project with it). */
  async files(dir: string): Promise<WorkspaceEntry[]> {
    const tx = this.db.transaction('entries', 'readonly');
    const rows = (await req(tx.objectStore('entries').getAll(below(normPath(dir))))) as WorkspaceEntry[];
    return rows.filter((e) => !e.isDir);
  }

  /** A file's bytes (a range of them), or null. */
  async read(
    path: string,
    range?: { start: number; end?: number },
  ): Promise<{ blob: Blob; size: number; start: number; end: number; contentType?: string } | null> {
    const tx = this.db.transaction(['entries', 'blobs'], 'readonly');
    const e = (await req(tx.objectStore('entries').get(normPath(path)))) as WorkspaceEntry | undefined;
    if (!e || e.isDir || !e.blob) return null;
    const blob = ((await req(tx.objectStore('blobs').get(e.blob))) as Blob | undefined) ?? new Blob([]);
    const size = blob.size;
    const start = Math.min(range?.start ?? 0, Math.max(0, size - 1));
    const end = Math.max(start, Math.min(range?.end ?? size - 1, size - 1));
    const slice = size === 0 ? blob : blob.slice(start, end + 1);
    return {
      blob: slice,
      size,
      start: size === 0 ? 0 : start,
      end: size === 0 ? 0 : end,
      contentType: e.contentType,
    };
  }

  async write(
    path: string,
    data: Blob,
    opts: { ifMatch?: string; ifNoneMatch?: '*'; contentType?: string } = {},
  ): Promise<{ etag: string }> {
    const p = normPath(path);
    if (p === '/') throw new Error('cannot write the root');
    const tx = this.db.transaction(['entries', 'blobs'], 'readwrite');
    const entries = tx.objectStore('entries');
    const blobs = tx.objectStore('blobs');
    const existing = (await req(entries.get(p))) as WorkspaceEntry | undefined;
    if (existing?.isDir) {
      tx.abort();
      throw new Error(`${p} is a folder`);
    }
    if ((opts.ifNoneMatch === '*' && existing) || (opts.ifMatch && existing?.etag !== opts.ifMatch)) {
      tx.abort();
      throw new PreconditionError(p);
    }
    await this.ensureDirs(entries, parentOf(p));
    const key = randomKey();
    const etag = `"${randomKey()}"`;
    blobs.put(data, key);
    entries.put({
      path: p,
      parent: parentOf(p),
      isDir: false,
      size: data.size,
      etag,
      mtime: Date.now(),
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
      blob: key,
    } satisfies WorkspaceEntry);
    if (existing?.blob) blobs.delete(existing.blob);
    await done(tx).catch((err: unknown) => {
      throw quota(err);
    });
    return { etag };
  }

  /** `mkdir -p` inside a transaction. */
  private async ensureDirs(entries: IDBObjectStore, dir: string): Promise<void> {
    const missing: string[] = [];
    for (let d = dir; d !== '/'; d = parentOf(d)) {
      const e = (await req(entries.get(d))) as WorkspaceEntry | undefined;
      if (e) {
        if (!e.isDir) throw new Error(`${d} is a file`);
        break;
      }
      missing.push(d);
    }
    for (const d of missing)
      entries.put({ path: d, parent: parentOf(d), isDir: true, size: 0, mtime: Date.now() });
  }

  async delete(path: string): Promise<void> {
    const p = normPath(path);
    const tx = this.db.transaction(['entries', 'blobs'], 'readwrite');
    const entries = tx.objectStore('entries');
    const blobs = tx.objectStore('blobs');
    const doomed = [
      (await req(entries.get(p))) as WorkspaceEntry | undefined,
      ...((await req(entries.getAll(below(p)))) as WorkspaceEntry[]),
    ].filter((e): e is WorkspaceEntry => !!e);
    for (const e of doomed) {
      entries.delete(e.path);
      if (e.blob) blobs.delete(e.blob);
    }
    await done(tx);
  }

  /** Renames a file or folder: entries move, bytes stay where they are. */
  async move(from: string, to: string): Promise<void> {
    const src = normPath(from);
    const dst = normPath(to);
    const tx = this.db.transaction('entries', 'readwrite');
    const entries = tx.objectStore('entries');
    const top = (await req(entries.get(src))) as WorkspaceEntry | undefined;
    if (!top) {
      tx.abort();
      throw new Error(`${src} does not exist`);
    }
    const all = [top, ...((await req(entries.getAll(below(src)))) as WorkspaceEntry[])];
    await this.ensureDirs(entries, parentOf(dst));
    for (const e of all) {
      const path = dst + e.path.slice(src.length);
      entries.delete(e.path);
      entries.put({ ...e, path, parent: parentOf(path) });
    }
    await done(tx);
  }
}

/** A failed write because the browser's quota is used up becomes an error the server reports as such. */
function quota(err: unknown): Error {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') {
    const e = new Error(err.message || 'storage quota exceeded');
    (e as Error & { code: string }).code = 'quota';
    return e;
  }
  return err instanceof Error ? err : new Error(String(err));
}

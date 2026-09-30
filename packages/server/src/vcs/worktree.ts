import {
  type Character,
  DOC_DIRS,
  docSpecForPath,
  jsonEqual,
  renderScreenplayMarkdown,
  type Screenplay,
  validateDoc,
} from '@rideo/shared';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { sha256 } from '../util/crypto';
import type { Materializer } from './repo';

interface IndexEntry {
  hash: string;
  size: number;
  etag?: string;
  mtime?: number;
}

export interface SyncScan {
  changes: Record<string, unknown | null>;
  issues: { path: string; error: string }[];
  inbox: { name: string; path: string; size: number }[];
}

function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const ROOT_DOCS = ['project.json', 'screenplay.json', 'timeline.json'];

/**
 * The human-readable work tree on WebDAV: materializes committed documents as pretty JSON (+ screenplay.md)
 * and detects external edits made through any WebDAV client (docs/design/storage-webdav.md#external-edits).
 */
export class Worktree implements Materializer {
  private index: Record<string, IndexEntry> | null = null;

  constructor(
    private readonly storage: StorageBackend,
    private readonly layout: Layout,
    private readonly projectId: string,
    private readonly log?: { warn: (obj: unknown, msg?: string) => void },
  ) {}

  private async loadIndex(): Promise<Record<string, IndexEntry>> {
    if (this.index) return this.index;
    const buf = await this.storage.read(this.layout.worktreeIndex(this.projectId));
    this.index = buf ? (JSON.parse(buf.toString()) as Record<string, IndexEntry>) : {};
    return this.index;
  }

  private async saveIndex(): Promise<void> {
    await this.storage.write(this.layout.worktreeIndex(this.projectId), JSON.stringify(this.index ?? {}), {
      contentType: 'application/json',
    });
  }

  private dirOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
  }

  /** Refreshes etag/mtime of freshly written files with one listing per directory. */
  private async captureStats(paths: string[]): Promise<void> {
    const index = await this.loadIndex();
    const dirs = new Set(paths.map((p) => this.dirOf(p)));
    for (const dir of dirs) {
      const base = this.layout.project(this.projectId);
      const listing = await this.storage.list(dir ? `${base}/${dir}` : base).catch(() => []);
      for (const e of listing) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        const entry = index[rel];
        if (entry && paths.includes(rel)) {
          entry.etag = e.etag;
          entry.mtime = e.mtime;
          entry.size = e.size;
        }
      }
    }
  }

  async materialize(
    changes: Record<string, unknown | null>,
    docs: ReadonlyMap<string, unknown>,
  ): Promise<void> {
    try {
      const index = await this.loadIndex();
      const written: string[] = [];
      for (const [path, doc] of Object.entries(changes)) {
        const target = this.layout.doc(this.projectId, path);
        if (doc === null) {
          await this.storage.delete(target);
          delete index[path];
        } else {
          const bytes = serialize(doc);
          await this.storage.write(target, bytes, { contentType: 'application/json' });
          index[path] = { hash: sha256(bytes), size: Buffer.byteLength(bytes) };
          written.push(path);
        }
      }
      if (Object.keys(changes).some((p) => p === 'screenplay.json' || p.startsWith('characters/'))) {
        await this.renderMarkdown(docs);
      }
      await this.captureStats(written);
      await this.saveIndex();
    } catch (err) {
      // The work tree is a projection; a failed write must not fail the commit (sync repairs it).
      this.log?.warn({ err, projectId: this.projectId }, 'work tree materialization failed');
    }
  }

  async materializeAll(docs: ReadonlyMap<string, unknown>): Promise<void> {
    const index = await this.loadIndex();
    const changes: Record<string, unknown | null> = {};
    for (const path of Object.keys(index)) if (!docs.has(path)) changes[path] = null;
    for (const [path, doc] of docs) changes[path] = doc;
    await this.materialize(changes, docs);
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

  async rematerialize(paths: string[], current: ReadonlyMap<string, unknown>): Promise<void> {
    const changes: Record<string, unknown | null> = {};
    for (const p of paths) changes[p] = current.get(p) ?? null;
    await this.materialize(changes, current);
  }
}

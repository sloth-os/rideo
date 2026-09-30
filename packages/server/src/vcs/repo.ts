import {
  type Actor,
  type BranchInfo,
  type CommitChange,
  type CommitSummary,
  type Diff,
  type DiffEntry,
  jsonDiff,
  REF_NAME_PATTERN,
  type TagInfo,
  validateDoc,
} from '@rideo/shared';
import { AppError, conflict, invalid, notFound } from '../errors';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { Lru } from '../util/lru';
import { KeyedMutex } from '../util/mutex';
import { type CommitObject, ObjectStore, type TreeEntry, type TreeObject } from './objects';

export interface CommitEvent {
  summary: CommitSummary;
  branch: string;
  /** Documents changed by this transaction (path → new doc, or null when deleted). */
  docs: Record<string, unknown | null>;
  checkedOut: boolean;
  /** Set when the commit amended (coalesced) the previous tip, which it replaces in history. */
  replaces?: string;
}

export interface TransactOptions<R = unknown> {
  actor: Actor;
  message: string | ((result: R) => string);
  meta?: Record<string, unknown>;
  branch?: string;
  coalesce?: { key: string };
}

export interface Materializer {
  materialize(changes: Record<string, unknown | null>, docs: ReadonlyMap<string, unknown>): Promise<void>;
  materializeAll(docs: ReadonlyMap<string, unknown>): Promise<void>;
}

interface BranchState {
  branch: string;
  commit: string | null;
  flat: Map<string, string>;
  docs: Map<string, unknown>;
}

/** Staged view of a snapshot inside a transaction. */
export class Tx {
  private readonly staged = new Map<string, unknown | null>();

  constructor(private readonly base: ReadonlyMap<string, unknown>) {}

  get<T>(path: string): T | null {
    if (this.staged.has(path)) return (this.staged.get(path) as T) ?? null;
    return (this.base.get(path) as T) ?? null;
  }

  require<T>(path: string, what: string): T {
    const v = this.get<T>(path);
    if (v === null) throw notFound(what);
    return v;
  }

  set(path: string, doc: unknown): void {
    this.staged.set(path, structuredClone(doc));
  }

  delete(path: string): void {
    this.staged.set(path, null);
  }

  /** All current documents (base overlaid with staged changes). */
  entries(): Map<string, unknown> {
    const out = new Map(this.base);
    for (const [p, d] of this.staged) {
      if (d === null) out.delete(p);
      else out.set(p, d);
    }
    return out;
  }

  list<T>(prefix: string): T[] {
    return [...this.entries()]
      .filter(([p]) => p.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, d]) => d as T);
  }

  changes(): Map<string, unknown | null> {
    return this.staged;
  }
}

function summaryOf(id: string, c: CommitObject, branch?: string): CommitSummary {
  return {
    id,
    parents: c.parents,
    author: c.author,
    message: c.message,
    timestamp: c.timestamp,
    changes: c.changes,
    ...(branch ? { branch } : {}),
    ...(c.meta && Object.keys(c.meta).length ? { meta: c.meta } : {}),
  };
}

function diffFlat(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): CommitChange[] {
  const out: CommitChange[] = [];
  for (const [p, id] of b) {
    const prev = a.get(p);
    if (prev === undefined) out.push({ path: p, op: 'add' });
    else if (prev !== id) out.push({ path: p, op: 'modify' });
  }
  for (const p of a.keys()) if (!b.has(p)) out.push({ path: p, op: 'delete' });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

/** Git-like repository for one project's documents (docs/design/version-control.md). */
export class Repository {
  readonly objects: ObjectStore;
  private readonly lock = new KeyedMutex();
  private readonly flatCache = new Lru<string, Map<string, string>>(128);
  private head: BranchState | null = null;
  private headBranch: string | null = null;
  materializer?: Materializer;
  onCommit?: (e: CommitEvent) => void;
  onHead?: (branch: string, commit: string | null) => void;

  constructor(
    private readonly storage: StorageBackend,
    private readonly layout: Layout,
    readonly projectId: string,
    private readonly opts: { coalesceWindowMs: number; now?: () => Date } = { coalesceWindowMs: 30_000 },
  ) {
    this.objects = new ObjectStore(storage, layout, projectId);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async currentBranch(): Promise<string> {
    if (this.headBranch) return this.headBranch;
    const buf = await this.storage.read(this.layout.head(this.projectId));
    this.headBranch = buf ? (JSON.parse(buf.toString()).branch as string) : 'main';
    return this.headBranch;
  }

  async exists(): Promise<boolean> {
    return (await this.storage.stat(this.layout.head(this.projectId))) !== null;
  }

  async readRef(branch: string): Promise<string | null> {
    const buf = await this.storage.read(this.layout.branchRef(this.projectId, branch));
    return buf ? ((JSON.parse(buf.toString()).commit as string | null) ?? null) : null;
  }

  private async writeRef(branch: string, commit: string | null): Promise<void> {
    await this.storage.write(
      this.layout.branchRef(this.projectId, branch),
      JSON.stringify({ commit, updatedAt: this.now().toISOString() }),
      { contentType: 'application/json' },
    );
  }

  async flatTree(commitId: string): Promise<Map<string, string>> {
    const hit = this.flatCache.get(commitId);
    if (hit) return hit;
    const c = await this.objects.get<CommitObject>(commitId);
    const flat = new Map<string, string>();
    const walk = async (treeId: string, prefix: string) => {
      const t = await this.objects.get<TreeObject>(treeId);
      for (const [name, e] of Object.entries(t.entries)) {
        if (e.kind === 'tree') await walk(e.hash, `${prefix}${name}/`);
        else flat.set(`${prefix}${name}`, e.hash);
      }
    };
    await walk(c.tree, '');
    this.flatCache.set(commitId, flat);
    return flat;
  }

  private async loadState(branch: string): Promise<BranchState> {
    const commit = await this.readRef(branch);
    const flat = commit ? new Map(await this.flatTree(commit)) : new Map<string, string>();
    const docs = new Map<string, unknown>();
    await Promise.all(
      [...flat].map(async ([p, id]) => {
        docs.set(p, (await this.objects.get<{ type: 'blob'; content: unknown }>(id)).content);
      }),
    );
    return { branch, commit, flat, docs };
  }

  private async state(branch: string): Promise<BranchState> {
    const current = await this.currentBranch();
    if (branch !== current) return this.loadState(branch);
    if (!this.head || this.head.branch !== branch) this.head = await this.loadState(branch);
    return this.head;
  }

  /** Documents of the checked-out branch (or another branch). */
  async snapshot(
    branch?: string,
  ): Promise<{ branch: string; commit: string | null; docs: ReadonlyMap<string, unknown> }> {
    const b = branch ?? (await this.currentBranch());
    const s = await this.state(b);
    return { branch: b, commit: s.commit, docs: s.docs };
  }

  async readDoc<T>(path: string, at?: string): Promise<T | null> {
    if (!at) return ((await this.snapshot()).docs.get(path) as T) ?? null;
    const flat = await this.flatTree(await this.resolve(at));
    const id = flat.get(path);
    return id ? ((await this.objects.get<{ type: 'blob'; content: T }>(id)).content ?? null) : null;
  }

  private async writeTree(flat: ReadonlyMap<string, string>): Promise<string> {
    interface Node {
      blobs: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const root: Node = { blobs: new Map(), dirs: new Map() };
    for (const [path, id] of flat) {
      const segs = path.split('/');
      let node = root;
      for (const seg of segs.slice(0, -1)) {
        let next = node.dirs.get(seg);
        if (!next) {
          next = { blobs: new Map(), dirs: new Map() };
          node.dirs.set(seg, next);
        }
        node = next;
      }
      node.blobs.set(segs[segs.length - 1]!, id);
    }
    const write = async (node: Node): Promise<string> => {
      const entries: Record<string, TreeEntry> = {};
      for (const [name, id] of node.blobs) entries[name] = { kind: 'blob', hash: id };
      for (const [name, child] of node.dirs) entries[name] = { kind: 'tree', hash: await write(child) };
      return this.objects.put({ type: 'tree', entries });
    };
    return write(root);
  }

  private async tagsByCommit(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const t of await this.listTags()) out.set(t.commit, [...(out.get(t.commit) ?? []), t.name]);
    return out;
  }

  /**
   * Read-modify-write under the project lock. The callback reads the current snapshot and stages
   * changes; staged documents are validated against their path schema and committed atomically.
   */
  async transact<R>(
    fn: (tx: Tx) => R | Promise<R>,
    opts: TransactOptions<R>,
  ): Promise<{ result: R; commit: CommitSummary | null }> {
    return this.lock.run('repo', async () => {
      const branch = opts.branch ?? (await this.currentBranch());
      const state = await this.state(branch);
      const tx = new Tx(state.docs);
      const result = await fn(tx);
      const staged = tx.changes();
      if (staged.size === 0) return { result, commit: null };
      const validated = new Map<string, unknown | null>();
      for (const [path, doc] of staged) {
        if (doc === null && path === 'project.json') throw invalid('project.json cannot be deleted');
        validated.set(path, doc === null ? null : validateDoc(path, doc));
      }
      const message = typeof opts.message === 'function' ? opts.message(result) : opts.message;
      const commit = await this.writeCommit(state, validated, { ...opts, message });
      return { result, commit };
    });
  }

  private async writeCommit(
    state: BranchState,
    changes: Map<string, unknown | null>,
    opts: Omit<TransactOptions, 'message'> & { message: string },
  ): Promise<CommitSummary | null> {
    const flat = new Map(state.flat);
    const changedDocs: Record<string, unknown | null> = {};
    for (const [path, doc] of changes) {
      if (doc === null) {
        if (flat.delete(path)) changedDocs[path] = null;
        continue;
      }
      const blobId = await this.objects.put({ type: 'blob', content: doc });
      if (flat.get(path) === blobId) continue;
      flat.set(path, blobId);
      changedDocs[path] = doc;
    }
    if (Object.keys(changedDocs).length === 0) return null;
    const tree = await this.writeTree(flat);
    const now = this.now();
    let parents = state.commit ? [state.commit] : [];
    let message = opts.message;
    let meta: Record<string, unknown> = { ...opts.meta };
    let replaces: string | undefined;
    if (opts.coalesce) meta.coalesceKey = opts.coalesce.key;
    let commitChanges = diffFlat(state.flat, flat);
    if (opts.coalesce && state.commit) {
      const tip = await this.objects.get<CommitObject>(state.commit);
      const tagged = (await this.tagsByCommit()).has(state.commit);
      const young = now.getTime() - Date.parse(tip.timestamp) <= this.opts.coalesceWindowMs;
      if (
        !tagged &&
        young &&
        tip.meta?.coalesceKey === opts.coalesce.key &&
        tip.author.kind === opts.actor.kind &&
        tip.author.id === opts.actor.id
      ) {
        parents = tip.parents;
        message = tip.message;
        meta = { ...tip.meta, ...meta, coalescedCount: Number(tip.meta?.coalescedCount ?? 1) + 1 };
        const parentFlat = parents[0] ? await this.flatTree(parents[0]) : new Map<string, string>();
        commitChanges = diffFlat(parentFlat, flat);
        replaces = state.commit;
      }
    }
    const commit: CommitObject = {
      type: 'commit',
      tree,
      parents,
      author: opts.actor,
      message,
      timestamp: now.toISOString(),
      changes: commitChanges,
      ...(Object.keys(meta).length ? { meta } : {}),
    };
    const id = await this.objects.put(commit);
    await this.writeRef(state.branch, id);
    this.flatCache.set(id, flat);
    state.commit = id;
    state.flat = flat;
    for (const [p, d] of Object.entries(changedDocs)) {
      if (d === null) state.docs.delete(p);
      else state.docs.set(p, d);
    }
    const checkedOut = state.branch === (await this.currentBranch());
    if (checkedOut) await this.materializer?.materialize(changedDocs, state.docs);
    const summary = summaryOf(id, commit, state.branch);
    this.onCommit?.({ summary, branch: state.branch, docs: changedDocs, checkedOut, replaces });
    return summary;
  }

  /** Creates the repository with its first commit on `main`. */
  async init(docs: Record<string, unknown>, actor: Actor, message: string): Promise<CommitSummary> {
    if (await this.exists()) throw conflict('repository already exists');
    await this.storage.write(this.layout.head(this.projectId), JSON.stringify({ branch: 'main' }), {
      contentType: 'application/json',
    });
    this.headBranch = 'main';
    this.head = { branch: 'main', commit: null, flat: new Map(), docs: new Map() };
    const { commit } = await this.transact(
      (tx) => {
        for (const [p, d] of Object.entries(docs)) tx.set(p, d);
      },
      { actor, message },
    );
    return commit!;
  }

  async resolve(ref: string): Promise<string> {
    if (/^[0-9a-f]{64}$/.test(ref)) return ref;
    if (REF_NAME_PATTERN.test(ref)) {
      const branch = await this.readRef(ref).catch(() => null);
      if (branch) return branch;
      const tag = (await this.listTags()).find((t) => t.name === ref);
      if (tag) return tag.commit;
    }
    if (/^[0-9a-f]{7,63}$/.test(ref)) {
      for (const b of await this.listBranches()) {
        let id = b.commit;
        for (let i = 0; id && i < 5000; i++) {
          if (id.startsWith(ref)) return id;
          id = (await this.objects.get<CommitObject>(id)).parents[0] ?? null;
        }
      }
    }
    throw notFound(`commit ${ref}`);
  }

  async log(
    opts: { branch?: string; path?: string; limit?: number; before?: string } = {},
  ): Promise<CommitSummary[]> {
    const branch = opts.branch ?? (await this.currentBranch());
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    let id = opts.before
      ? ((await this.objects.get<CommitObject>(await this.resolve(opts.before))).parents[0] ?? null)
      : await this.readRef(branch);
    const tags = await this.tagsByCommit();
    const out: CommitSummary[] = [];
    let scanned = 0;
    while (id && out.length < limit && scanned < 10_000) {
      const c = await this.objects.get<CommitObject>(id);
      if (!opts.path || c.changes.some((ch) => ch.path === opts.path)) {
        const s = summaryOf(id, c, branch);
        const t = tags.get(id);
        out.push(t ? { ...s, tags: t } : s);
      }
      id = c.parents[0] ?? null;
      scanned++;
    }
    return out;
  }

  async show(ref: string): Promise<CommitSummary> {
    const id = await this.resolve(ref);
    const c = await this.objects.get<CommitObject>(id);
    const tags = (await this.tagsByCommit()).get(id);
    return { ...summaryOf(id, c), ...(tags ? { tags } : {}) };
  }

  async diff(from: string | null, to: string, withDocs = true): Promise<Diff> {
    const toId = await this.resolve(to);
    const fromId = from ? await this.resolve(from) : null;
    const a = fromId ? await this.flatTree(fromId) : new Map<string, string>();
    const b = await this.flatTree(toId);
    const entries: DiffEntry[] = [];
    for (const change of diffFlat(a, b)) {
      const entry: DiffEntry = { ...change };
      if (withDocs) {
        const before = a.get(change.path)
          ? (await this.objects.get<{ type: 'blob'; content: unknown }>(a.get(change.path)!)).content
          : undefined;
        const after = b.get(change.path)
          ? (await this.objects.get<{ type: 'blob'; content: unknown }>(b.get(change.path)!)).content
          : undefined;
        entry.ops = jsonDiff(before ?? null, after ?? null);
      }
      entries.push(entry);
    }
    return { from: fromId, to: toId, entries };
  }

  async restore(opts: { commit: string; paths?: string[]; actor: Actor }): Promise<CommitSummary | null> {
    const id = await this.resolve(opts.commit);
    const target = await this.flatTree(id);
    const { commit } = await this.transact(
      async (tx) => {
        const current = tx.entries();
        const paths = opts.paths ?? [...new Set([...current.keys(), ...target.keys()])];
        for (const p of paths) {
          const blob = target.get(p);
          if (blob) tx.set(p, (await this.objects.get<{ type: 'blob'; content: unknown }>(blob)).content);
          else if (current.has(p) && p !== 'project.json') tx.delete(p);
        }
      },
      {
        actor: opts.actor,
        message: `Restore ${opts.paths ? opts.paths.join(', ') : 'project'} from ${id.slice(0, 8)}`,
        meta: { restoredFrom: id },
      },
    );
    return commit;
  }

  async listBranches(): Promise<BranchInfo[]> {
    const current = await this.currentBranch();
    const entries = await this.storage.list(this.layout.branchesDir(this.projectId));
    const names = entries.filter((e) => !e.isDir).map((e) => e.name);
    if (!names.includes(current)) names.push(current);
    return Promise.all(
      names
        .sort()
        .map(async (name) => ({ name, commit: await this.readRef(name), current: name === current })),
    );
  }

  async createBranch(name: string, from?: string): Promise<BranchInfo> {
    if (!REF_NAME_PATTERN.test(name)) throw invalid(`invalid branch name ${name}`);
    return this.lock.run('repo', async () => {
      if ((await this.storage.stat(this.layout.branchRef(this.projectId, name))) !== null)
        throw conflict(`branch ${name} exists`);
      const commit = from ? await this.resolve(from) : (await this.state(await this.currentBranch())).commit;
      await this.writeRef(name, commit);
      return { name, commit, current: false };
    });
  }

  async switchBranch(name: string): Promise<{ branch: string; commit: string | null }> {
    return this.lock.run('repo', async () => {
      if ((await this.storage.stat(this.layout.branchRef(this.projectId, name))) === null)
        throw notFound(`branch ${name}`);
      await this.storage.write(this.layout.head(this.projectId), JSON.stringify({ branch: name }), {
        contentType: 'application/json',
      });
      this.headBranch = name;
      this.head = await this.loadState(name);
      await this.materializer?.materializeAll(this.head.docs);
      this.onHead?.(name, this.head.commit);
      return { branch: name, commit: this.head.commit };
    });
  }

  async deleteBranch(name: string): Promise<void> {
    if (name === (await this.currentBranch())) throw conflict('cannot delete the checked-out branch');
    if ((await this.storage.stat(this.layout.branchRef(this.projectId, name))) === null)
      throw notFound(`branch ${name}`);
    await this.storage.delete(this.layout.branchRef(this.projectId, name));
  }

  async listTags(): Promise<TagInfo[]> {
    const entries = await this.storage.list(this.layout.tagsDir(this.projectId));
    const tags = await Promise.all(
      entries
        .filter((e) => !e.isDir)
        .map(async (e) => {
          const buf = await this.storage.read(this.layout.tagRef(this.projectId, e.name));
          return buf ? ({ name: e.name, ...JSON.parse(buf.toString()) } as TagInfo) : null;
        }),
    );
    return tags.filter((t): t is TagInfo => t !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates a tag; with `unique`, an existing name gets a numeric suffix instead of failing. */
  async createTag(opts: {
    name: string;
    commit?: string;
    message?: string;
    actor: Actor;
    unique?: boolean;
  }): Promise<TagInfo> {
    if (!REF_NAME_PATTERN.test(opts.name)) throw invalid(`invalid tag name ${opts.name}`);
    const commit = opts.commit ? await this.resolve(opts.commit) : (await this.snapshot()).commit;
    if (!commit) throw new AppError('conflict', 'nothing to tag yet');
    const existing = new Set((await this.listTags()).map((t) => t.name));
    let name = opts.name;
    if (existing.has(name)) {
      if (!opts.unique) throw conflict(`tag ${name} exists`);
      let n = 2;
      while (existing.has(`${opts.name}-${n}`)) n++;
      name = `${opts.name}-${n}`;
    }
    const tag: TagInfo = {
      name,
      commit,
      message: opts.message,
      actor: opts.actor,
      createdAt: this.now().toISOString(),
    };
    const { name: _n, ...body } = tag;
    await this.storage.write(this.layout.tagRef(this.projectId, name), JSON.stringify(body), {
      contentType: 'application/json',
    });
    return tag;
  }
}

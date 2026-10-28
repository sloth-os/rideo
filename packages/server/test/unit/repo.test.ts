import type { Readable } from 'node:stream';
import {
  type Actor,
  type Character,
  docPath,
  type Project,
  type Screenplay,
  type Timeline,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors';
import { Metrics } from '../../src/metrics';
import type { WriteOptions } from '../../src/storage/backend';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';
import { type CommitEvent, RECENT_LOG, Repository, type Tx } from '../../src/vcs/repo';
import { Worktree } from '../../src/vcs/worktree';

const user = { kind: 'user' as const, id: 'local', name: 'You' };
const agent = { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code' };

let storage: MemoryBackend;
let layout: Layout;
let project: Project;
let repo: Repository;
let worktree: Worktree;
let clock: number;
let events: CommitEvent[];

beforeEach(async () => {
  storage = new MemoryBackend();
  layout = new Layout('/rideo');
  project = f.project();
  clock = Date.parse('2026-09-30T10:00:00Z');
  repo = new Repository(storage, layout, project.id, {
    coalesceWindowMs: 30_000,
    now: () => new Date(clock),
  });
  worktree = new Worktree(storage, layout, project.id);
  repo.materializer = worktree;
  events = [];
  repo.onCommit = (e) => events.push(e);
  await repo.init({ 'project.json': project }, user, 'Create project');
});

function tick(ms: number) {
  clock += ms;
}

/** A slow storage that counts reads and the most in flight at once (docs/design/storage-webdav.md#slow-and-flaky-servers). */
class SlowCounting extends MemoryBackend {
  reads = 0;
  inFlight = 0;
  maxInFlight = 0;
  override async read(path: string): Promise<Buffer | null> {
    this.reads++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      return await super.read(path);
    } finally {
      this.inFlight--;
    }
  }
}

describe('loading a project', () => {
  it('shares a load in progress between callers and reads at most 12 documents at once', async () => {
    const slow = new SlowCounting();
    const first = new Repository(slow, layout, project.id);
    await first.init({ 'project.json': project }, user, 'Create project');
    await first.transact(
      (tx) => {
        for (let i = 0; i < 40; i++) {
          const c = f.character();
          tx.set(docPath.character(c.id), c);
        }
      },
      { actor: user, message: 'Forty characters' },
    );
    // A cold process: five requests arrive while the project loads
    const cold = new Repository(slow, layout, project.id);
    slow.reads = 0;
    slow.maxInFlight = 0;
    const snapshots = await Promise.all([1, 2, 3, 4, 5].map(() => cold.snapshot()));
    expect(new Set(snapshots.map((s) => s.docs.size))).toEqual(new Set([41]));
    const oneLoad = slow.reads;
    expect(oneLoad).toBeGreaterThan(41);
    expect(oneLoad).toBeLessThan(41 * 2);
    expect(slow.maxInFlight).toBeLessThanOrEqual(12);
    // Loaded: the next ones read nothing more
    await Promise.all([1, 2, 3].map(() => cold.snapshot()));
    expect(slow.reads).toBe(oneLoad);
  });
});

describe('commits', () => {
  it('initializes main with the project document', async () => {
    const snap = await repo.snapshot();
    expect(snap.branch).toBe('main');
    expect(snap.docs.get('project.json')).toMatchObject({ id: project.id });
    expect((await repo.log()).map((c) => c.message)).toEqual(['Create project']);
    expect(await repo.exists()).toBe(true);
  });

  it('validates documents and rejects deleting project.json', async () => {
    await expect(
      repo.transact((tx) => tx.set('project.json', { ...project, title: '' }), { actor: user, message: 'x' }),
    ).rejects.toThrow(/title/);
    await expect(
      repo.transact((tx) => tx.delete('project.json'), { actor: user, message: 'x' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      repo.transact((tx) => tx.set('evil/../x.json', {}), { actor: user, message: 'x' }),
    ).rejects.toThrow(/unknown document path/);
  });

  it('records add, modify and delete, skips no-ops and normalizes defaults', async () => {
    const c = f.character();
    const add = await repo.transact((tx) => tx.set(docPath.character(c.id), c), {
      actor: user,
      message: 'Add Mira',
    });
    expect(add.commit?.changes).toEqual([{ path: docPath.character(c.id), op: 'add' }]);
    const noop = await repo.transact((tx) => tx.set(docPath.character(c.id), c), {
      actor: user,
      message: 'same',
    });
    expect(noop.commit).toBeNull();
    const mod = await repo.transact((tx) => tx.set(docPath.character(c.id), { ...c, summary: 'changed' }), {
      actor: agent,
      message: 'Edit',
    });
    expect(mod.commit?.changes[0]?.op).toBe('modify');
    expect(mod.commit?.author).toEqual(agent);
    const del = await repo.transact((tx) => tx.delete(docPath.character(c.id)), {
      actor: user,
      message: 'Remove',
    });
    expect(del.commit?.changes).toEqual([{ path: docPath.character(c.id), op: 'delete' }]);
    expect(events.map((e) => Object.keys(e.docs))).toHaveLength(4);
    expect(events[3]!.docs[docPath.character(c.id)]).toBeNull();
  });

  it('passes the transaction result into message functions', async () => {
    const r = await repo.transact(
      (tx) => {
        tx.set('screenplay.json', f.screenplay());
        return 'The Keeper';
      },
      { actor: user, message: (title) => `Write ${title}` },
    );
    expect(r.result).toBe('The Keeper');
    expect(r.commit?.message).toBe('Write The Keeper');
  });
});

describe('coalescing', () => {
  const edit = (title: string, key = 'doc:screenplay.json', actor: Actor = user) =>
    repo.transact((tx) => tx.set('screenplay.json', f.screenplay({ title })), {
      actor,
      message: 'Edit screenplay',
      coalesce: { key },
    });

  it('amends rapid edits by the same author with the same key', async () => {
    await edit('A');
    tick(5_000);
    const second = await edit('B');
    tick(5_000);
    await edit('C');
    const log = await repo.log();
    expect(log.map((c) => c.message)).toEqual(['Edit screenplay', 'Create project']);
    expect(log[0]!.meta?.coalescedCount).toBe(3);
    expect(events.at(-1)!.replaces).toBe(second.commit!.id);
    expect(await repo.readDoc<Screenplay>('screenplay.json')).toMatchObject({ title: 'C' });
    expect(log[0]!.changes).toEqual([{ path: 'screenplay.json', op: 'add' }]);
  });

  it('starts a new commit after the window, for another key/author, or when the tip is tagged', async () => {
    await edit('A');
    tick(31_000);
    await edit('B');
    await edit('C', 'other');
    await edit('D', 'other', agent);
    await repo.createTag({ name: 'milestone', actor: user });
    await edit('E', 'other', agent);
    expect((await repo.log()).length).toBe(6);
  });
});

describe('history operations', () => {
  it('logs by path, paginates, diffs and restores', async () => {
    const c = f.character();
    const add = await repo.transact((tx) => tx.set(docPath.character(c.id), c), {
      actor: user,
      message: 'Add',
    });
    tick(1);
    await repo.transact((tx) => tx.set('screenplay.json', f.screenplay()), {
      actor: user,
      message: 'Screenplay',
    });
    tick(1);
    const edit = await repo.transact((tx) => tx.set(docPath.character(c.id), { ...c, name: 'Mira Vale' }), {
      actor: user,
      message: 'Rename',
    });
    expect((await repo.log({ path: docPath.character(c.id) })).map((x) => x.message)).toEqual([
      'Rename',
      'Add',
    ]);
    expect((await repo.log({ limit: 1, before: edit.commit!.id })).map((x) => x.message)).toEqual([
      'Screenplay',
    ]);

    const diff = await repo.diff(add.commit!.id, edit.commit!.id);
    expect(diff.entries.map((e) => [e.path, e.op])).toEqual([
      [docPath.character(c.id), 'modify'],
      ['screenplay.json', 'add'],
    ]);
    expect(diff.entries[0]!.ops).toEqual([
      { op: 'replace', pointer: '/name', before: 'Mira', after: 'Mira Vale' },
    ]);

    const restored = await repo.restore({
      commit: add.commit!.id,
      paths: [docPath.character(c.id)],
      actor: user,
    });
    expect(restored?.meta?.restoredFrom).toBe(add.commit!.id);
    expect((await repo.readDoc<{ name: string }>(docPath.character(c.id)))?.name).toBe('Mira');
    expect(await repo.readDoc('screenplay.json')).not.toBeNull();

    await repo.restore({ commit: add.commit!.id, actor: user });
    expect(await repo.readDoc('screenplay.json')).toBeNull();
    expect(await repo.readDoc('screenplay.json', edit.commit!.id)).not.toBeNull();
  });

  it('resolves branches, tags and short ids', async () => {
    const head = (await repo.snapshot()).commit!;
    await repo.createTag({ name: 'start', actor: user });
    expect(await repo.resolve('start')).toBe(head);
    expect(await repo.resolve('main')).toBe(head);
    expect(await repo.resolve(head.slice(0, 10))).toBe(head);
    await expect(repo.resolve('deadbeef00')).rejects.toThrow(/not found/);
    const t = await repo.createTag({ name: 'start', actor: user, unique: true });
    expect(t.name).toBe('start-2');
    await expect(repo.createTag({ name: 'start', actor: user })).rejects.toThrow(/exists/);
  });

  it('creates, switches and deletes branches with work-tree rematerialization', async () => {
    await repo.createBranch('alt-ending');
    await repo.switchBranch('alt-ending');
    await repo.transact((tx) => tx.set('screenplay.json', f.screenplay({ title: 'Alt' })), {
      actor: user,
      message: 'Alt',
    });
    await worktree.idle();
    expect((await storage.read(layout.doc(project.id, 'screenplay.json')))!.toString()).toContain('"Alt"');
    await repo.switchBranch('main');
    expect(await repo.readDoc('screenplay.json')).toBeNull();
    await worktree.idle();
    expect(await storage.read(layout.doc(project.id, 'screenplay.json'))).toBeNull();
    expect((await repo.listBranches()).map((b) => [b.name, b.current])).toEqual([
      ['alt-ending', false],
      ['main', true],
    ]);
    await expect(repo.deleteBranch('main')).rejects.toThrow(/checked-out/);
    await repo.deleteBranch('alt-ending');
    await expect(repo.createBranch('Bad Name')).rejects.toThrow(/invalid branch/);
  });

  it('commits a job to a non-checked-out branch without touching the work tree', async () => {
    await repo.createBranch('draft');
    await repo.transact((tx) => tx.set('screenplay.json', f.screenplay({ title: 'Draft' })), {
      actor: user,
      message: 'x',
      branch: 'draft',
    });
    expect(await repo.readDoc('screenplay.json')).toBeNull();
    expect(events.at(-1)!.checkedOut).toBe(false);
    expect((await repo.snapshot('draft')).docs.get('screenplay.json')).toMatchObject({ title: 'Draft' });
  });

  it('detects corrupt objects', async () => {
    const fresh = new Repository(storage, layout, project.id);
    const head = (await repo.snapshot()).commit!;
    const path = layout.object(project.id, head);
    await storage.write(path, (await storage.read(path))!.toString().replace('Create project', 'Tampered'));
    await expect(fresh.snapshot()).rejects.toThrow(/corrupt/);
  });
});

describe('work tree', () => {
  it('materializes pretty JSON and screenplay.md, then detects external edits', async () => {
    const c = f.character();
    await repo.transact(
      (tx) => {
        tx.set(docPath.character(c.id), c);
        tx.set('screenplay.json', f.screenplay());
      },
      { actor: user, message: 'Add' },
    );
    await worktree.idle();
    const wt = new Worktree(storage, layout, project.id);
    const json = (await storage.read(layout.doc(project.id, docPath.character(c.id))))!.toString();
    expect(json).toContain('\n  "name": "Mira"');
    expect((await storage.read(layout.screenplayMarkdown(project.id)))!.toString()).toContain('# The Keeper');

    const snap = await repo.snapshot();
    expect((await wt.scan(snap.docs)).changes).toEqual({});

    await storage.write(
      layout.doc(project.id, 'screenplay.json'),
      JSON.stringify({ ...f.screenplay(), title: 'Edited in Finder' }),
    );
    await storage.write(layout.doc(project.id, docPath.character(c.id)), '{ not json');
    const timeline: Timeline = {
      version: 1,
      fps: 24,
      width: 320,
      height: 180,
      tracks: [{ id: 'trk_0000000000aaaaaa', kind: 'video', name: 'V', items: [] }],
    };
    await storage.write(layout.doc(project.id, 'timeline.json'), JSON.stringify(timeline));
    await storage.write(`${layout.inbox(project.id)}/photo.png`, Buffer.from([1, 2, 3]));
    const scan = await wt.scan(snap.docs);
    expect(Object.keys(scan.changes).sort()).toEqual(['screenplay.json', 'timeline.json']);
    expect((scan.changes['screenplay.json'] as Screenplay).title).toBe('Edited in Finder');
    expect(scan.issues.map((i) => i.path)).toEqual([docPath.character(c.id)]);
    expect(scan.inbox.map((i) => i.name)).toEqual(['photo.png']);

    await storage.delete(layout.doc(project.id, docPath.character(c.id)));
    const afterDelete = await wt.scan(snap.docs);
    expect(afterDelete.changes[docPath.character(c.id)]).toBeNull();
  });

  it('deletes nothing a lagging listing leaves out, and still sees edits of it', async () => {
    const c = f.character();
    await repo.transact((tx) => tx.set(docPath.character(c.id), c), { actor: user, message: 'Add' });
    await worktree.idle();
    const file = layout.doc(project.id, docPath.character(c.id));
    // The server's listing has not caught up with the write (OpenList caches directory listings)
    const lagging = new Proxy(storage, {
      get: (target, prop) =>
        prop === 'list'
          ? async (dir: string) => (await target.list(dir)).filter((e) => e.name !== `${c.id}.json`)
          : Reflect.get(target, prop, target),
    });
    const warn = vi.fn();
    const wt = new Worktree(lagging, layout, project.id, { warn });
    const snap = await repo.snapshot();
    expect((await wt.scan(snap.docs)).changes).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      { projectId: project.id, path: docPath.character(c.id) },
      'work-tree listing missed a file',
    );
    await storage.write(file, JSON.stringify({ ...c, name: 'Mira Keeper' }));
    expect(((await wt.scan(snap.docs)).changes[docPath.character(c.id)] as Character).name).toBe(
      'Mira Keeper',
    );
    // a file that is really gone is still a deletion
    await storage.delete(file);
    expect((await wt.scan(snap.docs)).changes[docPath.character(c.id)]).toBeNull();
  });
});

/** A store whose every operation takes `ms`, recording when each started and ended (docs/design/storage-webdav.md). */
class SlowBackend extends MemoryBackend {
  readonly calls: { op: string; path: string; start: number; end: number }[] = [];
  failWrites: (path: string) => boolean = () => false;
  constructor(private readonly ms = 15) {
    super();
  }
  private async slow<T>(op: string, path: string, run: () => Promise<T>): Promise<T> {
    const call = { op, path, start: performance.now(), end: 0 };
    this.calls.push(call);
    await new Promise((r) => setTimeout(r, this.ms));
    try {
      return await run();
    } finally {
      call.end = performance.now();
    }
  }
  override read(path: string) {
    return this.slow('read', path, () => super.read(path));
  }
  override write(
    path: string,
    data: Parameters<MemoryBackend['write']>[1],
    opts?: Parameters<MemoryBackend['write']>[2],
  ) {
    return this.slow('write', path, async () => {
      if (this.failWrites(path)) throw new Error(`write of ${path} failed`);
      return super.write(path, data, opts);
    });
  }
  override stat(path: string) {
    return this.slow('stat', path, () => super.stat(path));
  }
  override list(dir: string) {
    return this.slow('list', dir, () => super.list(dir));
  }
  override delete(path: string) {
    return this.slow('delete', path, () => super.delete(path));
  }
}

describe('commit round trips (docs/design/version-control.md#commit-protocol)', () => {
  it('writes the objects at once, then the ref, without waiting for the work tree or reading tags', async () => {
    const slow = new SlowBackend();
    const r = new Repository(slow, layout, project.id, {
      coalesceWindowMs: 30_000,
      now: () => new Date(clock),
    });
    const wt = new Worktree(slow, layout, project.id);
    r.materializer = wt;
    await r.init({ 'project.json': project }, user, 'Create project');
    await wt.idle();
    const c = f.character();
    slow.calls.length = 0;
    const started = performance.now();
    await r.transact((tx) => tx.set(docPath.character(c.id), c), { actor: user, message: 'Add Mira' });
    const took = performance.now() - started;
    const objects = slow.calls.filter((x) => x.path.includes('/objects/'));
    const ref = slow.calls.find((x) => x.path.endsWith('/refs/heads/main'))!;
    // a blob, the characters tree, the root tree and the commit: written together, then the ref
    expect(objects).toHaveLength(4);
    expect(Math.max(...objects.map((o) => o.start))).toBeLessThan(Math.min(...objects.map((o) => o.end)));
    expect(ref.start).toBeGreaterThanOrEqual(Math.max(...objects.map((o) => o.end)));
    // the work tree follows in the background: its write had not finished when the commit answered
    const doc = layout.doc(project.id, docPath.character(c.id));
    expect(slow.files.has(doc)).toBe(false);
    await wt.idle();
    const write = slow.calls.find((x) => x.op === 'write' && x.path === doc)!;
    expect(write.end - started).toBeGreaterThan(took);
    expect((await slow.read(doc))!.toString()).toContain('"Mira"');

    // coalescing commits read the tags once, and the tip comes from memory
    slow.calls.length = 0;
    for (const title of ['A', 'B', 'C'])
      await r.transact((tx) => tx.set('screenplay.json', f.screenplay({ title })), {
        actor: user,
        message: 'Edit',
        coalesce: { key: 'doc:screenplay.json' },
      });
    expect(slow.calls.filter((x) => x.op === 'list' && x.path.endsWith('/refs/tags'))).toHaveLength(1);
    await r.log();
    expect(slow.calls.filter((x) => x.op === 'read' && x.path.endsWith('/refs/heads/main'))).toHaveLength(0);
    const tag = await r.createTag({ name: 'draft', actor: user });
    expect((await r.listTags()).map((t) => t.name)).toEqual(['draft']);
    expect(tag.commit).toBe((await r.snapshot()).commit);
  });
});

describe('work tree in the background (docs/design/storage-webdav.md#external-edits)', () => {
  const timelineDoc = (n: number): Timeline => ({
    version: 1,
    fps: 24,
    width: 320,
    height: 180,
    tracks: [{ id: 'trk_0000000000aaaaaa', kind: 'video', name: `V${n}`, items: [] }],
  });

  it('writes the newest version of a burst of commits once per path', async () => {
    const slow = new SlowBackend(30);
    const r = new Repository(slow, layout, project.id, { coalesceWindowMs: 0 });
    const wt = new Worktree(slow, layout, project.id);
    r.materializer = wt;
    await r.init({ 'project.json': project }, user, 'Create project');
    await wt.idle();
    slow.calls.length = 0;
    for (let n = 1; n <= 8; n++)
      await r.transact((tx) => tx.set('timeline.json', timelineDoc(n)), {
        actor: user,
        message: `Edit ${n}`,
      });
    await wt.idle();
    const writes = slow.calls.filter(
      (x) => x.op === 'write' && x.path === layout.doc(project.id, 'timeline.json'),
    );
    expect(writes.length).toBeLessThan(8);
    const file = JSON.parse((await slow.read(layout.doc(project.id, 'timeline.json')))!.toString());
    expect(file.tracks[0].name).toBe('V8');
    // ...and sync sees no external edit in what it wrote
    expect((await wt.scan((await r.snapshot()).docs)).changes).toEqual({});
  });

  it('tries a failed batch again, and catches up with commits it missed when the project loads', async () => {
    const slow = new SlowBackend(1);
    const metrics = new Metrics();
    const warn = vi.fn();
    const r = new Repository(slow, layout, project.id, { coalesceWindowMs: 0 });
    const wt = new Worktree(slow, layout, project.id, { warn }, metrics, { retryMs: 20 });
    r.materializer = wt;
    await r.init({ 'project.json': project }, user, 'Create project');
    await wt.idle();
    const target = layout.doc(project.id, 'timeline.json');
    let failures = 2;
    slow.failWrites = (path) => path === target && failures-- > 0;
    await r.transact((tx) => tx.set('timeline.json', timelineDoc(1)), { actor: user, message: 'Edit' });
    await expect.poll(async () => (await slow.read(target))?.toString() ?? '').toContain('"V1"');
    await wt.idle();
    expect(metrics.worktreeBatches.get({ outcome: 'failed' })).toBe(2);
    expect(metrics.worktreeBatches.get({ outcome: 'ok' })).toBeGreaterThanOrEqual(2);
    expect(metrics.worktreePending.get()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, retryInMs: expect.any(Number) }),
      'work tree materialization failed; will retry',
    );

    // A screenplay written to the work tree, then edited outside Rideo
    const sp = f.screenplay({ title: 'Committed' });
    await r.transact((tx) => tx.set('screenplay.json', sp), { actor: user, message: 'Script' });
    await wt.idle();
    await slow.write(
      layout.doc(project.id, 'screenplay.json'),
      JSON.stringify({ ...sp, title: 'Edited in Finder' }),
    );
    // A commit whose batch was lost (the process stopped): the next load writes it, and only it
    r.materializer = undefined;
    await r.transact((tx) => tx.set('timeline.json', timelineDoc(2)), { actor: user, message: 'Lost' });
    const fresh = new Repository(slow, layout, project.id);
    const wt2 = new Worktree(slow, layout, project.id, { warn });
    fresh.materializer = wt2;
    await fresh.snapshot();
    await expect.poll(async () => (await slow.read(target))?.toString() ?? '').toContain('"V2"');
    await wt2.idle();
    expect(warn).toHaveBeenCalledWith(
      { projectId: project.id, paths: ['timeline.json'], count: 1 },
      'work tree behind HEAD; rewriting',
    );
    const scan = await wt2.scan((await fresh.snapshot()).docs);
    expect((scan.changes['screenplay.json'] as Screenplay).title).toBe('Edited in Finder');
  });
});

/** A store that counts reads of commit objects. */
class ObjectCounting extends MemoryBackend {
  objectReads = 0;
  override async read(path: string): Promise<Buffer | null> {
    if (path.includes('/.rideo/objects/')) this.objectReads++;
    return super.read(path);
  }
}

describe('the recent log (docs/design/version-control.md#caching)', () => {
  /** A repository with `n` commits after its first, each on its own document; returns their ids, newest first. */
  async function history(store: MemoryBackend, n: number, opts: { coalesce?: boolean } = {}) {
    let now = Date.parse('2026-10-28T10:00:00Z');
    const r = new Repository(store, layout, project.id, {
      coalesceWindowMs: 30_000,
      now: () => new Date(now),
    });
    await r.init({ 'project.json': project }, user, 'Create project');
    for (let i = 0; i < n; i++) {
      // Coalesced edits land within the coalescing window
      now += opts.coalesce ? 1_000 : 60_000;
      await r.transact(
        (tx) => {
          const id = `chr_${String(i).padStart(10, '0')}`;
          tx.set(docPath.character(id), f.character({ id }));
        },
        {
          actor: user,
          message: `Character ${i}`,
          ...(opts.coalesce ? { coalesce: { key: 'same' } } : {}),
        },
      );
    }
    return { r, ids: (await r.log({ limit: 500 })).map((c) => c.id) };
  }

  it('lets a cold process read a branch’s history from its file, not one commit object after another', async () => {
    const store = new ObjectCounting();
    const { r, ids } = await history(store, 30);
    await r.flushRecent();
    const cold = new Repository(store, layout, project.id);
    store.objectReads = 0;
    const log = await cold.log({ limit: 20 });
    expect(log.map((c) => c.id)).toEqual(ids.slice(0, 20));
    expect(log[0]).toMatchObject({ branch: 'main', message: 'Character 29' });
    expect(store.objectReads).toBe(0);
    // Paging inside the window reads nothing either
    expect((await cold.log({ before: ids[19], limit: 5 })).map((c) => c.id)).toEqual(ids.slice(20, 25));
    expect(store.objectReads).toBe(0);
  });

  it('catches up from the tip when its file is behind, and follows commits in memory', async () => {
    const store = new ObjectCounting();
    const { r, ids } = await history(store, 10);
    await r.flushRecent();
    // Three commits the file does not have (written by a process that stopped before writing it)
    const other = new Repository(store, layout, project.id);
    for (let i = 0; i < 3; i++)
      await other.transact(
        (tx) => {
          const id = `chr_9${String(i).padStart(9, '0')}`;
          tx.set(docPath.character(id), f.character({ id }));
        },
        {
          actor: agent,
          message: `Later ${i}`,
        },
      );
    const cold = new Repository(store, layout, project.id);
    store.objectReads = 0;
    const log = await cold.log({ limit: 5 });
    expect(log.map((c) => c.message)).toEqual([
      'Later 2',
      'Later 1',
      'Later 0',
      'Character 9',
      'Character 8',
    ]);
    expect(log.slice(3).map((c) => c.id)).toEqual(ids.slice(0, 2));
    expect(store.objectReads).toBe(3);
    // A commit here is in the log at once, without reading anything
    await cold.transact(
      (tx) => {
        const id = 'chr_cut0000000';
        tx.set(docPath.character(id), f.character({ id }));
      },
      { actor: user, message: 'Cut' },
    );
    store.objectReads = 0;
    expect((await cold.log({ limit: 1 }))[0]!.message).toBe('Cut');
    expect(store.objectReads).toBe(0);
  });

  it('keeps a coalesced commit in place of the tip it replaces', async () => {
    const store = new MemoryBackend();
    const { r } = await history(store, 3, { coalesce: true });
    const log = await r.log({ limit: 10 });
    // The three coalesced edits are one commit after the first
    expect(log.map((c) => c.message)).toEqual(['Character 0', 'Create project']);
    expect(log[0]!.meta?.coalescedCount).toBe(3);
  });

  it('pages and filters by path past the window, as the walk does', async () => {
    const store = new MemoryBackend();
    const { r, ids } = await history(store, RECENT_LOG + 20);
    expect(ids).toHaveLength(RECENT_LOG + 21);
    const page = await r.log({ before: ids[RECENT_LOG - 3], limit: 10 });
    expect(page.map((c) => c.id)).toEqual(ids.slice(RECENT_LOG - 2, RECENT_LOG + 8));
    const path = docPath.character(`chr_${String(5).padStart(10, '0')}`);
    expect((await r.log({ path, limit: 5 })).map((c) => c.message)).toEqual(['Character 5']);
    const old = await r.log({ path: 'project.json', limit: 5 });
    expect(old.map((c) => c.message)).toEqual(['Create project']);
  });
});

describe('a slow server’s false 404 for an object (docs/design/storage-webdav.md#slow-and-flaky-servers)', () => {
  it('looks for a missing object again before the read fails', async () => {
    class MissOnce extends MemoryBackend {
      missed = new Set<string>();
      override async read(path: string) {
        if (path.includes('/.rideo/objects/') && !this.missed.has(path)) {
          this.missed.add(path);
          return null;
        }
        return super.read(path);
      }
    }
    const store = new MissOnce();
    const first = new Repository(store, layout, project.id);
    await first.init({ 'project.json': project }, user, 'Create project');
    const cold = new Repository(store, layout, project.id);
    cold.objects.missRetryMs = 1;
    expect((await cold.snapshot()).docs.get('project.json')).toMatchObject({ id: project.id });
    expect(store.missed.size).toBeGreaterThan(0);
    // A file that is truly gone still fails, after the second look
    const gone = new Repository(new MemoryBackend(), layout, project.id);
    await expect(gone.objects.get('a'.repeat(64))).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('several commits at once (docs/design/version-control.md#commit-protocol)', () => {
  it('makes a commit of each step, writes them together with one move of the ref, and leaves a failing step out', async () => {
    class RefCounting extends MemoryBackend {
      refWrites = 0;
      override async write(path: string, data: Buffer | string | Readable, opts?: WriteOptions) {
        if (path.endsWith('/refs/heads/main')) this.refWrites++;
        return super.write(path, data, opts);
      }
    }
    const store = new RefCounting();
    const r = new Repository(store, layout, project.id);
    await r.init({ 'project.json': project }, user, 'Create project');
    const seen: CommitEvent[] = [];
    r.onCommit = (e) => seen.push(e);
    const before = store.refWrites;
    const title = (t: string) => (tx: Tx) => {
      const p = tx.require<Project>('project.json', 'project');
      tx.set('project.json', { ...p, title: t });
      return t;
    };
    const out = await r.transactMany(
      [
        { fn: title('One'), message: 'Title One' },
        {
          fn: () => {
            throw new Error('does not apply');
          },
          message: 'Broken',
        },
        { fn: title('Two'), message: (t) => `Title ${t}` },
        { fn: title('Two'), message: 'Nothing changes' },
      ],
      { actor: user },
    );
    expect(out.map((o) => ('error' in o ? 'error' : (o.commit?.message ?? null)))).toEqual([
      'Title One',
      'error',
      'Title Two',
      null,
    ]);
    // Two commits, one after the other, behind one move of the ref
    expect(store.refWrites - before).toBe(1);
    const log = await r.log({ limit: 3 });
    expect(log.map((c) => c.message)).toEqual(['Title Two', 'Title One', 'Create project']);
    expect(log[0]!.parents).toEqual([log[1]!.id]);
    expect((await r.snapshot()).docs.get('project.json')).toMatchObject({ title: 'Two' });
    expect(seen.map((e) => e.summary.message)).toEqual(['Title One', 'Title Two']);
    // A cold process sees the same history
    const cold = new Repository(store, layout, project.id);
    expect((await cold.log({ limit: 3 })).map((c) => c.message)).toEqual([
      'Title Two',
      'Title One',
      'Create project',
    ]);
  });
});

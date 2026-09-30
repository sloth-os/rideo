import { type Actor, docPath, type Project, type Screenplay, type Timeline } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';
import { type CommitEvent, Repository } from '../../src/vcs/repo';
import { Worktree } from '../../src/vcs/worktree';

const user = { kind: 'user' as const, id: 'local', name: 'You' };
const agent = { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code' };

let storage: MemoryBackend;
let layout: Layout;
let project: Project;
let repo: Repository;
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
  repo.materializer = new Worktree(storage, layout, project.id);
  events = [];
  repo.onCommit = (e) => events.push(e);
  await repo.init({ 'project.json': project }, user, 'Create project');
});

function tick(ms: number) {
  clock += ms;
}

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
    expect((await storage.read(layout.doc(project.id, 'screenplay.json')))!.toString()).toContain('"Alt"');
    await repo.switchBranch('main');
    expect(await repo.readDoc('screenplay.json')).toBeNull();
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
});

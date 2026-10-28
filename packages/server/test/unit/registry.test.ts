import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRegistry } from '../../src/domain/registry';
import { LiveHub } from '../../src/live/hub';
import { Metrics } from '../../src/metrics';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';

/** Project existence (docs/design/storage-webdav.md#slow-and-flaky-servers). */

const user = { kind: 'user' as const, id: 'local', name: 'You' };
const layout = new Layout('/rideo');

/** A store that counts stats of HEAD and can answer 404 for it a few times (a slow server's false 404s). */
class CountingBackend extends MemoryBackend {
  heads = 0;
  falseMisses = 0;
  editable = true;
  /** Reads of version-control objects (a project's documents and history). */
  objectReads = 0;
  lists = 0;
  override async read(path: string) {
    if (path.includes('/.rideo/objects/')) this.objectReads++;
    return super.read(path);
  }
  override async list(path: string) {
    this.lists++;
    return super.list(path);
  }
  override async stat(path: string) {
    if (path.endsWith('/.rideo/HEAD')) {
      this.heads++;
      if (this.falseMisses > 0) {
        this.falseMisses--;
        return null;
      }
    }
    return super.stat(path);
  }
  externallyEditable() {
    return this.editable;
  }
}

let storage: CountingBackend;
let registry: ProjectRegistry;
const warn = vi.fn();

function makeRegistry() {
  return new ProjectRegistry({
    storage,
    layout,
    hub: new LiveHub(),
    metrics: new Metrics(),
    coalesceWindowMs: 0,
    log: { warn },
    confirmMs: 5,
  });
}

async function create(): Promise<string> {
  const project = f.project();
  const h = registry.handle(project.id);
  await h.repo.init({ 'project.json': project }, user, 'Create project');
  await h.worktree.idle();
  return project.id;
}

beforeEach(() => {
  storage = new CountingBackend();
  registry = makeRegistry();
  warn.mockReset();
});

describe('project existence', () => {
  it('looks a project up once, not on every request', async () => {
    const id = await create();
    const fresh = makeRegistry();
    storage.heads = 0;
    for (let i = 0; i < 5; i++) await fresh.existing(id);
    expect(storage.heads).toBe(1);
  });

  it('looks twice before a project counts as gone', async () => {
    const id = await create();
    const fresh = makeRegistry();
    storage.falseMisses = 1;
    await expect(fresh.existing(id)).resolves.toMatchObject({ id });
    expect(warn).toHaveBeenCalledWith(
      { projectId: id },
      'project folder answered 404 once; found it on the second look',
    );
    storage.heads = 0;
    await expect(fresh.existing('prj_0000000000nothere')).rejects.toMatchObject({ code: 'not_found' });
    expect(storage.heads).toBe(2);
  });

  it('notices a folder deleted outside Rideo when sync verifies it', async () => {
    const id = await create();
    await registry.existing(id);
    await storage.delete(layout.project(id));
    // a request is served from memory...
    await expect(registry.existing(id)).resolves.toMatchObject({ id });
    // ...sync looks again, and the project is gone from then on
    await expect(registry.existing(id, { verify: true })).rejects.toMatchObject({ code: 'not_found' });
    await expect(registry.existing(id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('asks every time for a project kept in a browser (a closed browser must be noticed)', async () => {
    const id = await create();
    storage.editable = false;
    storage.heads = 0;
    for (let i = 0; i < 3; i++) await registry.existing(id);
    expect(storage.heads).toBe(3);
  });
});

describe('maintenance (docs/design/storage-webdav.md#maintenance)', () => {
  it('forgets every loaded project whose folder is gone, on its timer', async () => {
    const kept = await create();
    const deleted = await create();
    const metrics = new Metrics();
    const fresh = new ProjectRegistry({
      storage,
      layout,
      hub: new LiveHub(),
      metrics,
      coalesceWindowMs: 0,
      log: { warn },
      confirmMs: 5,
    });
    await fresh.existing(kept);
    await fresh.existing(deleted);
    await storage.delete(layout.project(deleted));
    expect(await fresh.verifyLoaded()).toEqual([deleted]);
    expect(metrics.projectsVanished.get()).toBe(1);
    await expect(fresh.existing(deleted)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fresh.existing(kept)).resolves.toMatchObject({ id: kept });
    expect(warn).toHaveBeenCalledWith({ projectId: deleted }, 'project folder is gone; forgot the project');
  });

  it('remembers the recently used projects across a restart and warms them, each once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rideo-recent-'));
    const recentFile = join(dir, 'recent-projects.json');
    const [a, b, c, d] = [await create(), await create(), await create(), await create()];
    const make = (metrics = new Metrics()) =>
      new ProjectRegistry({ storage, layout, hub: new LiveHub(), metrics, coalesceWindowMs: 0, recentFile });
    const first = make();
    for (const id of [a, b, c, d]) {
      await first.existing(id);
      await new Promise((r) => setTimeout(r, 2));
    }
    await first.saveRecent();
    expect(await first.readRecent()).toEqual([d, c, b, a]);
    // After a restart: the three most recent are warmed, documents and log
    const metrics = new Metrics();
    const restarted = make(metrics);
    expect(await restarted.warmRecent()).toEqual([d, c, b]);
    expect(metrics.projectsWarmed.get()).toBe(3);
    // A second warm of the same project does nothing
    await restarted.warm(d);
    expect(metrics.projectsWarmed.get()).toBe(3);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('project summaries (docs/design/storage-webdav.md#slow-and-flaky-servers)', () => {
  const agent = { kind: 'agent' as const, id: 'tok_0000000000aaaa', name: 'Claude Code' };
  const summaries = (metrics = new Metrics()) =>
    new ProjectRegistry({
      storage,
      layout,
      hub: new LiveHub(),
      metrics,
      coalesceWindowMs: 0,
      log: { warn },
      confirmMs: 5,
      digestWriteMs: 5,
    });
  const retitle = (r: ProjectRegistry, id: string, title: string, actor: Actor = user) =>
    r
      .handle(id)
      .repo.transact(
        (tx) =>
          tx.set('project.json', { ...tx.require<{ title: string }>('project.json', 'project'), title }),
        { actor, message: `Title ${title}` },
      );

  it('is made from the documents once, then read from its file after a restart without the documents', async () => {
    const id = await create();
    const first = summaries();
    const d = await first.digest(id);
    expect(d.summary).toMatchObject({ id, title: expect.any(String) });
    // Written beside the project: a restarted studio reads it, and no document
    await expect.poll(async () => !!(await storage.read(layout.digest(id)))).toBe(true);
    const metrics = new Metrics();
    const restarted = summaries(metrics);
    storage.objectReads = 0;
    expect(await restarted.digest(id)).toEqual(d);
    expect(storage.objectReads).toBe(0);
    expect(metrics.projectDigests.get({ source: 'file' })).toBe(1);
  });

  it('follows the commits in memory, writes its file behind them, and is made again when the file is behind', async () => {
    const id = await create();
    const live = summaries();
    await live.digest(id);
    await retitle(live, id, 'Second title');
    await retitle(live, id, 'Third title', agent);
    // In memory at once: the title, the tip and the agent's commit
    await expect.poll(async () => (await live.digest(id)).summary.title).toBe('Third title');
    const tip = await live.handle(id).repo.readRef('main');
    expect((await live.digest(id)).commit).toBe(tip);
    expect((await live.digest(id)).agents.map((a) => a.message)).toEqual(['Title Third title']);
    // ...and on storage a few milliseconds later
    await expect
      .poll(async () => JSON.parse(String(await storage.read(layout.digest(id)))).summary.title)
      .toBe('Third title');
    // A commit another studio made after the file was written: the file is behind, so it is made again
    const other = makeRegistry();
    await retitle(other, id, 'Fourth title');
    const metrics = new Metrics();
    expect((await summaries(metrics).digest(id)).summary.title).toBe('Fourth title');
    expect(metrics.projectDigests.get({ source: 'documents' })).toBe(1);
  });

  it('lists the projects folder once a minute on WebDAV, and again after a project comes or goes', async () => {
    const id = await create();
    Object.defineProperty(storage, 'kind', { value: 'webdav' });
    const r = summaries();
    storage.lists = 0;
    expect(await r.listIds()).toEqual([id]);
    expect(await r.listIds()).toEqual([id]);
    expect(storage.lists).toBe(1);
    r.invalidateIds();
    await r.listIds();
    expect(storage.lists).toBe(2);
    r.forget(id);
    await r.listIds();
    expect(storage.lists).toBe(3);
  });
});

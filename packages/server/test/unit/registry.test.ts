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

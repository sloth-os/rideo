import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_MANIFEST,
  bundledFile,
  bundleFileName,
  bundleRelPath,
  canonicalJson,
  ProjectBundleManifestSchema,
  parseTarHeader,
  rewriteProjectId,
  TAR_BLOCK,
  tarEnd,
  tarHeader,
  tarPadding,
} from '../src';

describe('project files (docs/design/browser-storage.md#project-files-export-and-import)', () => {
  it('writes and reads ustar headers, long names in the prefix and huge sizes in base-256', () => {
    const h = tarHeader(BUNDLE_MANIFEST, 1234, 1_700_000_000);
    expect(h.length).toBe(TAR_BLOCK);
    expect(parseTarHeader(h)).toEqual({ name: BUNDLE_MANIFEST, size: 1234, type: '0' });
    const long = `project/media/uploads/${'a'.repeat(90)}/${'b'.repeat(60)}-0123456789ab.mp4`;
    expect(parseTarHeader(tarHeader(long, 5))).toMatchObject({ name: long, size: 5 });
    const huge = 9 * 1024 ** 3;
    expect(parseTarHeader(tarHeader('project/media/exports/x.mov', huge))?.size).toBe(huge);
    expect(() => tarHeader(`project/${'x'.repeat(300)}`, 1)).toThrow(/too long/);
  });

  it('ends at an empty block and refuses a damaged header', () => {
    expect(parseTarHeader(tarEnd().subarray(0, TAR_BLOCK))).toBeNull();
    const h = tarHeader('project/project.json', 10);
    h[0] = h[0]! ^ 1;
    expect(() => parseTarHeader(h)).toThrow(/checksum/);
    expect(tarPadding(0)).toBe(0);
    expect(tarPadding(1)).toBe(511);
    expect(tarPadding(512)).toBe(0);
  });

  it('carries the project folder but not job records or the inbox, and refuses unsafe entries', () => {
    expect(bundledFile('.rideo/objects/ab/cd.json')).toBe(true);
    expect(bundledFile('.rideo/jobs/job_1.json')).toBe(false);
    expect(bundledFile('inbox/README.txt')).toBe(false);
    expect(bundleRelPath('project/media/takes/c0-s1-0123456789ab.mp4')).toBe(
      'media/takes/c0-s1-0123456789ab.mp4',
    );
    expect(bundleRelPath('project/.rideo/refs/heads/main')).toBe('.rideo/refs/heads/main');
    for (const bad of [
      'media/x.mp4',
      'project/../etc/passwd',
      'project/a//b',
      'project//abs',
      'project/./x',
      'project/a\\b',
      'project/.rideo/jobs/job_1.json',
      'project/inbox/drop.mp4',
      'project/a\u0000b',
      'project/$(rm)',
    ])
      expect(bundleRelPath(bad), bad).toBeNull();
  });

  it('validates the manifest and names files after the title', () => {
    const manifest = {
      format: 'rideo-project',
      version: 1,
      projectId: 'prj_0123456789ab',
      title: 'Summer trip',
      kind: 'edit',
      createdAt: '2026-10-01T00:00:00.000Z',
      exportedAt: '2026-10-04T00:00:00.000Z',
      generator: 'Rideo 0.1.0',
      head: { branch: 'main', commit: null },
      files: 3,
      bytes: 100,
    };
    expect(ProjectBundleManifestSchema.parse(manifest)).toEqual(manifest);
    expect(ProjectBundleManifestSchema.safeParse({ ...manifest, version: 2 }).success).toBe(false);
    expect(ProjectBundleManifestSchema.safeParse({ ...manifest, projectId: '../x' }).success).toBe(false);
    expect(bundleFileName('Été à Nice: “cut 2”')).toBe('Ete a Nice cut 2.rideo');
    expect(bundleFileName('///')).toBe('project.rideo');
  });

  it('rewrites a history so every commit names the copy’s id, sharing everything else', async () => {
    const store = new Map<string, unknown>();
    const put = async (obj: unknown) => {
      const id = createHash('sha256').update(canonicalJson(obj)).digest('hex');
      store.set(id, obj);
      return id;
    };
    const io = {
      read: async (id: string) => store.get(id) as never,
      write: put as never,
    };
    const project = (title: string) => put({ type: 'blob', content: { id: 'prj_old0000000a', title } });
    const timeline = await put({ type: 'blob', content: { tracks: [] } });
    const sub = await put({ type: 'tree', entries: { 'a.json': { kind: 'blob', hash: timeline } } });
    const tree = async (title: string) =>
      put({
        type: 'tree',
        entries: {
          'project.json': { kind: 'blob', hash: await project(title) },
          'timeline.json': { kind: 'blob', hash: timeline },
          clips: { kind: 'tree', hash: sub },
        },
      });
    const commit = async (title: string, parents: string[]) =>
      put({
        type: 'commit',
        tree: await tree(title),
        parents,
        message: title,
        timestamp: '2026-10-04T00:00:00Z',
      });
    const c1 = await commit('one', []);
    const c2 = await commit('two', [c1]);
    const side = await commit('side', [c1]);
    const merge = await commit('two', [c2, side]);
    const mapped = await rewriteProjectId(io, [merge, side], 'prj_new0000000b');
    expect([...mapped.keys()].sort()).toEqual([c1, c2, side, merge].sort());
    for (const [from, to] of mapped) {
      expect(to).not.toBe(from);
      const c = store.get(to) as { tree: string; parents: string[]; message: string };
      const original = store.get(from) as { parents: string[]; message: string };
      expect(c.message).toBe(original.message);
      expect(c.parents).toEqual(original.parents.map((p) => mapped.get(p)));
      const t = store.get(c.tree) as { entries: Record<string, { hash: string }> };
      expect((store.get(t.entries['project.json']!.hash) as { content: { id: string } }).content.id).toBe(
        'prj_new0000000b',
      );
      // other documents and subtrees are shared
      expect(t.entries['timeline.json']!.hash).toBe(timeline);
      expect(t.entries.clips!.hash).toBe(sub);
    }
  });
});

// @vitest-environment node
// IndexedDB through fake-indexeddb, with Node's own Blob (which structured clone can store).
import 'fake-indexeddb/auto';
import {
  BUNDLE_MANIFEST,
  parseTarHeader,
  type StorageRequest,
  type StorageResult,
  TAR_BLOCK,
} from '@rideo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SW_DB_NAME, workspaceMediaResponse } from '../src/pwa/sw-media';
import { exportFromBrowser, importIntoBrowser, readProjectFile } from '../src/workspace/bundle';
import { WorkspaceProvider } from '../src/workspace/provider';
import { DB_NAME, PreconditionError, WorkspaceStore } from '../src/workspace/store';

const blob = (s: string | Uint8Array) => new Blob([s as BlobPart]);
const text = async (b: Blob | undefined) => (b ? await b.text() : null);

async function fresh(): Promise<WorkspaceStore> {
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
  });
  return WorkspaceStore.open();
}

describe('the workspace store (docs/design/browser-storage.md#workspaces)', () => {
  let store: WorkspaceStore;
  beforeEach(async () => {
    store = await fresh();
  });
  afterEach(() => store.close());

  it('writes files with their folders, lists one level, reads ranges', async () => {
    await store.write('/projects/prj_0123456789ab/.rideo/HEAD', blob('{"branch":"main"}'));
    await store.write('/projects/prj_0123456789ab/project.json', blob('{}'), {
      contentType: 'application/json',
    });
    expect(await store.list('/')).toEqual([expect.objectContaining({ name: 'projects', isDir: true })]);
    expect((await store.list('/projects/prj_0123456789ab')).map((e) => [e.name, e.isDir])).toEqual([
      ['.rideo', true],
      ['project.json', false],
    ]);
    expect(await store.stat('/projects/prj_0123456789ab/.rideo/HEAD')).toMatchObject({
      size: 17,
      isDir: false,
    });
    expect(await store.stat('/projects/missing')).toBeNull();
    const r = await store.read('/projects/prj_0123456789ab/.rideo/HEAD', { start: 2, end: 7 });
    expect(await text(r?.blob)).toBe('branch');
    expect(r).toMatchObject({ size: 17, start: 2, end: 7 });
    expect(await store.read('/nope')).toBeNull();
    expect((await store.files('/projects')).map((e) => e.path).sort()).toEqual([
      '/projects/prj_0123456789ab/.rideo/HEAD',
      '/projects/prj_0123456789ab/project.json',
    ]);
  });

  it('checks preconditions inside the transaction', async () => {
    const { etag } = await store.write('/ref', blob('1'), { ifNoneMatch: '*' });
    await expect(store.write('/ref', blob('2'), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
      PreconditionError,
    );
    await expect(store.write('/ref', blob('2'), { ifMatch: '"other"' })).rejects.toBeInstanceOf(
      PreconditionError,
    );
    await store.write('/ref', blob('3'), { ifMatch: etag });
    expect(await text((await store.read('/ref'))?.blob)).toBe('3');
  });

  it('moves folders without touching their bytes and deletes them whole', async () => {
    await store.write('/projects/prj_a/media/x.mp4', blob('video'));
    await store.write('/projects/prj_a/project.json', blob('{}'));
    await store.move('/projects/prj_a', '/trash/prj_a-1700000000000');
    expect(await store.stat('/projects/prj_a')).toBeNull();
    expect(await text((await store.read('/trash/prj_a-1700000000000/media/x.mp4'))?.blob)).toBe('video');
    expect((await store.list('/trash')).map((e) => e.name)).toEqual(['prj_a-1700000000000']);
    await store.delete('/trash');
    expect(await store.files('/')).toEqual([]);
    expect(await store.stat('/trash')).toBeNull();
  });
});

describe('serving the server (docs/design/browser-storage.md#the-protocol)', () => {
  it('answers small reads inline and large ones over a transfer, writes from both', async () => {
    const store = await fresh();
    const sent: StorageResult[] = [];
    const puts: { id: string; size: number; meta: unknown }[] = [];
    const provider = new WorkspaceProvider(store, {
      send: (m) => sent.push(m),
      fetchTransfer: async () => blob(new Uint8Array(300 * 1024).fill(7)),
      putTransfer: async (id, data, meta) => {
        puts.push({ id, size: data.size, meta });
      },
    });
    const req = (r: Omit<StorageRequest, 'type'>) => provider.handle({ type: 'storage', ...r });
    await req({ id: '1', op: 'write', path: '/a.json', data: btoa('{"x":1}') });
    await req({ id: '2', op: 'write', path: '/big.bin', transfer: 'tr_1', size: 300 * 1024 });
    await req({ id: '3', op: 'read', path: '/a.json' });
    await req({ id: '4', op: 'read', path: '/big.bin' });
    await req({ id: '5', op: 'read', path: '/big.bin', range: { start: 0, end: 9 } });
    await req({ id: '6', op: 'read', path: '/none' });
    await req({ id: '7', op: 'write', path: '/a.json', data: btoa('{}'), ifNoneMatch: '*' });
    await req({ id: '8', op: 'list', path: '/' });
    const by = (id: string) => sent.find((m) => m.id === id)!;
    expect(by('1')).toMatchObject({ ok: true, result: { etag: expect.any(String) } });
    expect(atob(by('3').data!)).toBe('{"x":1}');
    expect(by('3').result).toEqual({ size: 7, start: 0, end: 6 });
    expect(by('4')).toBeUndefined();
    expect(puts).toEqual([
      { id: '4', size: 300 * 1024, meta: { size: 300 * 1024, start: 0, end: 300 * 1024 - 1 } },
    ]);
    expect(by('5').data).toBe(btoa('\u0007'.repeat(10)));
    expect(by('6')).toMatchObject({ ok: true, result: null });
    expect(by('7')).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect((by('8').result as { name: string }[]).map((e) => e.name)).toEqual(['a.json', 'big.bin']);
    store.close();
  });
});

describe('project files in the browser (docs/design/browser-storage.md#project-files-export-and-import)', () => {
  it('exports a project as a tar of its files and imports it back, replacing the old one', async () => {
    const store = await fresh();
    const root = '/projects/prj_0123456789ab';
    await store.write(
      `${root}/project.json`,
      blob(JSON.stringify({ title: 'Summer', kind: 'edit', createdAt: 'x' })),
    );
    await store.write(`${root}/.rideo/HEAD`, blob('{"branch":"main"}'));
    await store.write(`${root}/.rideo/refs/heads/main`, blob('{"commit":"abc"}'));
    await store.write(`${root}/.rideo/jobs/job_1.json`, blob('{}'));
    await store.write(`${root}/media/uploads/clip-0123.mp4`, blob(new Uint8Array(1000).fill(1)));
    const { blob: file, filename, manifest } = await exportFromBrowser(store, 'prj_0123456789ab');
    expect(filename).toBe('Summer.rideo');
    expect(manifest).toMatchObject({
      projectId: 'prj_0123456789ab',
      files: 4,
      head: { branch: 'main', commit: 'abc' },
    });
    const first = parseTarHeader(new Uint8Array(await file.slice(0, TAR_BLOCK).arrayBuffer()));
    expect(first?.name).toBe(BUNDLE_MANIFEST);
    const read = await readProjectFile(file);
    expect(read.entries.map((e) => e.rel).sort()).toEqual([
      '.rideo/HEAD',
      '.rideo/refs/heads/main',
      'media/uploads/clip-0123.mp4',
      'project.json',
    ]);
    await expect(importIntoBrowser(store, read, 'new')).rejects.toThrow(/already in this browser/);
    const progress: number[] = [];
    await importIntoBrowser(store, read, 'replace', (done, total) => progress.push(done / total));
    expect(progress.at(-1)).toBe(1);
    expect((await store.list('/trash')).length).toBe(1);
    const media = await store.read(`${root}/media/uploads/clip-0123.mp4`);
    expect(media?.size).toBe(1000);
    // and the service worker serves it, with ranges
    const res = await workspaceMediaResponse(`${root}/media/uploads/clip-0123.mp4`, 'bytes=10-19', indexedDB);
    expect(res?.status).toBe(206);
    expect(res?.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(res?.headers.get('content-type')).toBe('video/mp4');
    expect((await res!.arrayBuffer()).byteLength).toBe(10);
    expect((await workspaceMediaResponse(`${root}/media/none.mp4`, null, indexedDB))?.status).toBeUndefined();
    expect(
      (await workspaceMediaResponse(`${root}/media/uploads/clip-0123.mp4`, 'bytes=5000-', indexedDB))?.status,
    ).toBe(416);
    store.close();
  });

  it('refuses files that are not project files', async () => {
    await expect(readProjectFile(blob('hello'))).rejects.toThrow(/not a Rideo project file/);
    await expect(readProjectFile(blob(new Uint8Array(2048)))).rejects.toThrow(/not a Rideo project file/);
  });

  it('never creates the database from the service worker', async () => {
    expect(SW_DB_NAME).toBe(DB_NAME);
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(DB_NAME);
      r.onsuccess = () => resolve();
    });
    expect(await workspaceMediaResponse('/projects/prj_x/media/a.mp4', null, indexedDB)).toBeNull();
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain(DB_NAME);
  });
});

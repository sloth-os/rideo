import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaStore } from '../../src/media/store';
import { Metrics } from '../../src/metrics';
import type { WriteOptions } from '../../src/storage/backend';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';

/** Files ready in the cache before they reach storage (docs/design/storage-webdav.md#local-cache-and-staging). */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const layout = new Layout('/rideo');
const project = 'prj_0000000000aaaaaa';

/** A storage whose writes wait for `open()`, and fail `failures` times first. */
class SlowStorage extends MemoryBackend {
  failures = 0;
  writes = 0;
  private gate: Promise<void> = Promise.resolve();
  private release: () => void = () => undefined;
  hold(): void {
    this.gate = new Promise((r) => {
      this.release = r;
    });
  }
  open(): void {
    this.release();
  }
  override async write(path: string, data: Buffer | string | Readable, opts?: WriteOptions) {
    this.writes++;
    await this.gate;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('503 Service Unavailable');
    }
    return super.write(path, data, opts);
  }
}

async function setup(storage: SlowStorage, dataDir?: string) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'rideo-upload-')));
  if (!dataDir) cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const metrics = new Metrics();
  const media = new MediaStore({
    storage,
    layout,
    ff: {} as never,
    dataDir: dir,
    maxCacheBytes: 1e9,
    metrics,
    uploadRetryMs: 5,
  });
  await media.init();
  const uploaded: string[] = [];
  media.onUploaded = (_p, path) => uploaded.push(path);
  return { dir, media, metrics, uploaded };
}

const read = async (s: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
};

describe('a file ready before its upload', () => {
  it('is served from the cache at once and written to storage behind it, again after a failure', async () => {
    const storage = new SlowStorage();
    const { dir, media, metrics, uploaded } = await setup(storage);
    const file = join(dir, 'export.tar');
    await writeFile(file, 'the film');
    storage.hold();
    storage.failures = 1;
    const ref = await media.putFileBehind(project, file, {
      kind: 'exports',
      name: 'exp_0000000000aaaaaa',
      mime: 'application/x-tar',
      probe: false,
    });
    // Ready: served from the cache though storage has nothing yet
    expect(await read((await media.stream(project, ref.path))!.stream)).toBe('the film');
    expect(await storage.stat(layout.media(project, ref.path))).toBeNull();
    expect(media.pendingUploads()).toMatchObject([{ projectId: project, path: ref.path, attempts: 0 }]);
    expect(JSON.parse(await readFile(join(dir, 'uploads.json'), 'utf8'))).toHaveLength(1);
    expect(metrics.mediaUploadsPending.get()).toBe(1);
    // The first write fails, the second lands
    storage.open();
    await expect.poll(() => uploaded, { timeout: 10_000 }).toEqual([ref.path]);
    expect(storage.writes).toBe(2);
    expect((await storage.read(layout.media(project, ref.path)))!.toString()).toBe('the film');
    expect(media.pendingUploads()).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'uploads.json'), 'utf8'))).toEqual([]);
    expect(metrics.mediaUploads.get({ outcome: 'retried' })).toBe(1);
    expect(metrics.mediaUploads.get({ outcome: 'done' })).toBe(1);
    expect(metrics.mediaUploadsPending.get()).toBe(0);
  });

  it('waits for startUpload when asked, and a restarted studio resumes the upload from the cache', async () => {
    const storage = new SlowStorage();
    const first = await setup(storage);
    const file = join(first.dir, 'export.tar');
    await writeFile(file, 'the film');
    const ref = await first.media.putFileBehind(project, file, {
      kind: 'exports',
      name: 'exp_0000000000aaaaaa',
      mime: 'application/x-tar',
      probe: false,
      start: false,
    });
    expect(storage.writes).toBe(0);
    // The studio stops before the upload starts; the next one resumes it
    const next = await setup(storage, first.dir);
    expect(next.media.pendingUploads()).toHaveLength(1);
    next.media.resumeUploads();
    await expect.poll(() => next.uploaded, { timeout: 10_000 }).toEqual([ref.path]);
    expect((await storage.read(layout.media(project, ref.path)))!.toString()).toBe('the film');
  });

  it('never evicts a file waiting for its upload', async () => {
    const storage = new SlowStorage();
    const dir = await mkdtemp(join(tmpdir(), 'rideo-upload-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const media = new MediaStore({ storage, layout, ff: {} as never, dataDir: dir, maxCacheBytes: 50 });
    await media.init();
    const big = join(dir, 'big.tar');
    await writeFile(big, 'x'.repeat(40));
    const ref = await media.putFileBehind(project, big, {
      kind: 'exports',
      name: 'exp_0000000000bbbbbb',
      mime: 'application/x-tar',
      probe: false,
      start: false,
    });
    // More than the cache holds: the newer file goes, the one waiting for its upload stays
    const other = join(dir, 'other.tar');
    await writeFile(other, 'y'.repeat(30));
    const otherRef = await media.putFile(project, other, {
      kind: 'exports',
      name: 'other',
      mime: 'application/x-tar',
      probe: false,
    });
    expect(await read((await media.stream(project, ref.path))!.stream)).toBe('x'.repeat(40));
    expect(await storage.stat(layout.media(project, ref.path))).toBeNull();
    // (the other is on storage, so it is still served)
    expect(await read((await media.stream(project, otherRef.path))!.stream)).toBe('y'.repeat(30));
  });
});

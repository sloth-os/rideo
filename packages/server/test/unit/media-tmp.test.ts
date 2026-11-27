import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { createStudio } from '../../src/domain/studio';
import { MediaStore } from '../../src/media/store';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';

/**
 * The scratch directory (docs/design/storage-webdav.md#local-cache-and-staging): uploads are spooled to
 * `${RIDEO_DATA_DIR}/tmp` and jobs work there; what a crash or a killed process left is removed when the server starts,
 * once it is more than a day old.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
const dataDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rideo-scratch-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const HOUR = 3600_000;
/** Sets a file's or a folder's times `hours` back. */
const age = async (path: string, hours: number) => {
  const t = new Date(Date.now() - hours * HOUR);
  await utimes(path, t, t);
};

/** What a crashed server leaves: a spooled upload and a job's folder two days old, and work of the last hour. */
async function leftovers(tmp: string) {
  await mkdir(tmp, { recursive: true });
  await writeFile(join(tmp, '1-aaaaaa.bin'), 'an upload a killed process spooled');
  await age(join(tmp, '1-aaaaaa.bin'), 48);
  await mkdir(join(tmp, 'd-1-bbbbbb', 'frames'), { recursive: true });
  await writeFile(join(tmp, 'd-1-bbbbbb', 'frames', '0001.png'), 'a crashed job');
  await age(join(tmp, 'd-1-bbbbbb', 'frames', '0001.png'), 30);
  await age(join(tmp, 'd-1-bbbbbb', 'frames'), 30);
  await age(join(tmp, 'd-1-bbbbbb'), 30);
  // a folder made long ago whose file was written an hour ago is still in use
  await mkdir(join(tmp, 'd-2-cccccc'));
  await writeFile(join(tmp, 'd-2-cccccc', 'part.mp4'), 'a long job');
  await age(join(tmp, 'd-2-cccccc', 'part.mp4'), 1);
  await age(join(tmp, 'd-2-cccccc'), 30);
  await writeFile(join(tmp, '3-dddddd.bin'), 'an upload being received');
  await writeFile(join(tmp, '4-eeeeee.bin'), 'just under a day');
  await age(join(tmp, '4-eeeeee.bin'), 23);
}

describe('the scratch directory', () => {
  it('loses what is more than a day old, a folder by its newest file, and keeps the rest', async () => {
    const dir = await dataDir();
    const media = new MediaStore({
      storage: new MemoryBackend(),
      layout: new Layout('/rideo'),
      ff: {} as never,
      dataDir: dir,
      maxCacheBytes: 1e9,
    });
    await media.init();
    await leftovers(media.tmpDir);
    expect(await media.sweepTmp()).toBe(2);
    expect((await readdir(media.tmpDir)).sort()).toEqual(['3-dddddd.bin', '4-eeeeee.bin', 'd-2-cccccc']);
    expect(await media.sweepTmp()).toBe(0);
    // no directory yet (before `init`): nothing to remove
    const fresh = new MediaStore({
      storage: new MemoryBackend(),
      layout: new Layout('/rideo'),
      ff: {} as never,
      dataDir: join(dir, 'none'),
      maxCacheBytes: 1e9,
    });
    expect(await fresh.sweepTmp()).toBe(0);
  });

  it('is swept when the server starts, with the count in the log', async () => {
    const dir = await dataDir();
    await leftovers(join(dir, 'tmp'));
    const config = loadConfig({
      RIDEO_DATA_DIR: dir,
      RIDEO_STORAGE: 'embedded',
      NODE_ENV: 'test',
      RIDEO_WATERMARK_KEY: 'unit-test-key',
      RIDEO_LOG_LEVEL: 'warn',
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
    const studio = createStudio(config, { log, storage: new MemoryBackend() });
    cleanup.unshift(() => studio.stop());
    await studio.start();
    expect((await readdir(join(dir, 'tmp'))).sort()).toEqual(['3-dddddd.bin', '4-eeeeee.bin', 'd-2-cccccc']);
    expect(log.info).toHaveBeenCalledWith({ removed: 2 }, 'removed stale scratch files');
  });
});

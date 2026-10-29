import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Staging } from '../../src/media/staging';

/** Editor outputs sent in slices (docs/design/editor.md#editor-jobs). */
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const job = 'job_0000000000aaaaaa';
const body = (s: string) => Readable.from([Buffer.from(s)]);

describe('staged slices', () => {
  it('appends slices in order and stages the file with the last one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rideo-staging-'));
    dirs.push(dir);
    const staging = new Staging(dir);
    const opts = (offset: number) => ({ offset, total: 10, maxBytes: 100 });
    expect(await staging.writeSlice(job, 'part-0001.mp4', body('0123'), opts(0))).toEqual({
      size: 4,
      complete: false,
    });
    // not staged until the last slice
    expect(await staging.exists(job, 'part-0001.mp4')).toBe(false);
    // a slice that does not start where the file ends is refused
    await expect(staging.writeSlice(job, 'part-0001.mp4', body('xx'), opts(6))).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await staging.writeSlice(job, 'part-0001.mp4', body('4567'), opts(4))).toEqual({
      size: 8,
      complete: false,
    });
    expect(await staging.writeSlice(job, 'part-0001.mp4', body('89'), opts(8))).toEqual({
      size: 10,
      complete: true,
    });
    expect(await readFile(staging.path(job, 'part-0001.mp4'), 'utf8')).toBe('0123456789');
    expect(await stat(`${staging.path(job, 'part-0001.mp4')}.upload`).catch(() => null)).toBeNull();
    // offset 0 starts a file again; more than the total, or a total over the limit, is refused
    await staging.writeSlice(job, 'part-0002.mp4', body('abc'), opts(0));
    await staging.writeSlice(job, 'part-0002.mp4', body('0123'), opts(0));
    await expect(staging.writeSlice(job, 'part-0002.mp4', body('4567890'), opts(4))).rejects.toThrow(
      /exceed/,
    );
    await expect(
      staging.writeSlice(job, 'part-0003.mp4', body('a'), { offset: 0, total: 1000, maxBytes: 100 }),
    ).rejects.toThrow(/exceeds 100 bytes/);
  });
});

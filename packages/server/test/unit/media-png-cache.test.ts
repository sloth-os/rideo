import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaStore } from '../../src/media/store';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';
import { sha256 } from '../../src/util/crypto';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64 * 1024, 7),
]);

/** An ffmpeg that writes its output (the last argument) in two halves a moment apart, as a real one streams it. */
function streamingFfmpeg(output: Buffer = PNG) {
  const calls = { n: 0 };
  return {
    calls,
    ff: {
      run: async (args: string[]) => {
        calls.n++;
        const out = args.at(-1)!;
        await writeFile(out, output.subarray(0, output.length >> 1));
        await new Promise((r) => setTimeout(r, 5));
        await writeFile(out, output);
        return '';
      },
    },
  };
}

async function store(ff: object) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rideo-png-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const media = new MediaStore({
    storage: new MemoryBackend(),
    layout: new Layout('/rideo'),
    ff: ff as never,
    dataDir,
    maxCacheBytes: 1e9,
  });
  await media.init();
  const src = join(dataDir, 'ref.jpg');
  await writeFile(src, 'jpeg bytes');
  return { media, dataDir, src };
}

describe('images converted for the models (docs/design/storage-webdav.md#local-cache-and-staging)', () => {
  it('gives every job drawing at once the whole image, never a half-written one', async () => {
    const { ff } = streamingFfmpeg();
    const { media, src } = await store(ff);
    const all = await Promise.all(Array.from({ length: 24 }, () => media.filePng(src, 1024)));
    for (const png of all) expect(png.equals(PNG)).toBe(true);
    // Later reads are cache hits, whole too
    expect((await media.filePng(src, 1024)).equals(PNG)).toBe(true);
  });

  it('converts again over an empty cached file', async () => {
    const { ff, calls } = streamingFfmpeg();
    const { media, dataDir, src } = await store(ff);
    const key = `${sha256(`${src}:512`).slice(0, 24)}.png`;
    await writeFile(join(dataDir, 'cache', 'media', `derived-${key}`), '');
    expect((await media.filePng(src, 512)).equals(PNG)).toBe(true);
    expect(calls.n).toBe(1);
  });

  it('fails with a media error when the conversion writes nothing', async () => {
    const { ff } = streamingFfmpeg(Buffer.alloc(0));
    const { media, src } = await store(ff);
    await expect(media.filePng(src, 256)).rejects.toMatchObject({ code: 'media_error' });
  });
});

import type { MediaRef } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaPool } from '../src/features/editor/engine/media-pool';
import { PEAKS_PER_SEC, thumbnailAt, waveformPeaks } from '../src/features/editor/engine/peaks';

/** Lanes drawn from a take's lane files (docs/design/editor.md#waveforms-and-filmstrips). */

afterEach(() => {
  vi.unstubAllGlobals();
});

function take(): MediaRef {
  const media = f.media({ durationSec: 3 });
  return {
    ...media,
    lanes: {
      peaks: { path: `media/lanes/${media.hash.slice(0, 12)}-peaks.json`, perSec: 50 },
      strip: {
        path: `media/lanes/${media.hash.slice(0, 12)}-strip.jpg`,
        everySec: 1,
        tiles: 3,
        tileWidth: 128,
        tileHeight: 72,
      },
    },
  };
}

function pool(files: Record<string, Response>) {
  const fetched: string[] = [];
  const decoded: string[] = [];
  const p = {
    fetchMedia: async (path: string) => {
      fetched.push(path);
      return files[path] ?? new Response('', { status: 404 });
    },
    get: async (m: MediaRef) => {
      decoded.push(m.path);
      throw new Error('decoded the original');
    },
  } as unknown as MediaPool;
  return { p, fetched, decoded };
}

describe('lanes from the lane files', () => {
  it('reads the server’s peaks at the tab’s rate instead of decoding the take', async () => {
    const media = take();
    const { p, fetched, decoded } = pool({
      [media.lanes!.peaks!.path]: Response.json({ perSec: 50, peaks: [0, 255, 51, 102, 0, 0] }),
    });
    const peaks = (await waveformPeaks(p, media))!;
    expect(peaks).toHaveLength(Math.ceil((6 / 50) * PEAKS_PER_SEC));
    // 50 a second spread over 100 a second: each value twice
    expect(Array.from(peaks.slice(0, 6)).map((v) => Math.round(v * 100) / 100)).toEqual([
      0, 0, 1, 1, 0.2, 0.2,
    ]);
    expect(fetched).toEqual([media.lanes!.peaks!.path]);
    expect(decoded).toEqual([]);
  });

  it('crops a filmstrip tile from the sprite, and falls back to decoding when the file is missing', async () => {
    const media = take();
    const crops: unknown[][] = [];
    vi.stubGlobal('createImageBitmap', async (...args: unknown[]) => {
      if (args.length > 1) crops.push(args.slice(1));
      return { width: 1, height: 1 } as unknown as ImageBitmap;
    });
    const { p, decoded } = pool({ [media.lanes!.strip!.path]: new Response(new Blob(['jpg'])) });
    await thumbnailAt(p, media, 2.4);
    expect(crops).toEqual([[256, 0, 128, 72]]);
    expect(decoded).toEqual([]);
    // A take whose sprite cannot be read is decoded as before
    const lost = { ...take(), hash: 'b'.repeat(64) };
    const missing = pool({});
    await expect(thumbnailAt(missing.p, lost, 1)).rejects.toThrow('decoded the original');
    expect(missing.decoded).toEqual([lost.path]);
  });
});

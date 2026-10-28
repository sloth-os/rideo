import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaRef } from '@rideo/shared';
import type { Ffmpeg } from './ffmpeg';

/**
 * The editor's lane files of a take or an upload (docs/design/editor.md#waveforms-and-filmstrips): its waveform peaks
 * and a filmstrip sprite, made once on the server so the tab does not decode whole clips to draw its lanes.
 */

/** Peaks a second: the loudest sample of every 10 ms, as the tab computes them. */
export const LANE_PEAKS_PER_SEC = 100;
/** The filmstrip: one frame a second (or fewer on long media), this high, at most this many. */
export const LANE_STRIP_HEIGHT = 72;
export const LANE_STRIP_MAX_TILES = 120;
/** The sample rate the peaks are measured at: 80 samples per 10 ms. */
const PEAKS_RATE = 8000;

/** The waveform peaks of a file's first sound track, 0–255 each; null when it has no sound. */
export async function makePeaks(
  ff: Ffmpeg,
  file: string,
  dir: string,
  signal?: AbortSignal,
): Promise<number[] | null> {
  const raw = join(dir, 'peaks.s16');
  await ff.run(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(PEAKS_RATE), '-f', 's16le', raw], {
    signal,
    timeoutMs: 120_000,
  });
  const buf = await readFile(raw);
  if (!buf.length) return null;
  const count = Math.floor(buf.length / 2);
  const per = PEAKS_RATE / LANE_PEAKS_PER_SEC;
  const peaks: number[] = [];
  for (let i = 0; i < count; i += per) {
    let loudest = 0;
    for (let k = i; k < Math.min(count, i + per); k++)
      loudest = Math.max(loudest, Math.abs(buf.readInt16LE(k * 2)));
    peaks.push(Math.min(255, Math.round((loudest / 32768) * 255)));
  }
  return peaks;
}

/** A filmstrip sprite: frames side by side at `LANE_STRIP_HEIGHT`; null without a picture or a duration. */
export async function makeStrip(
  ff: Ffmpeg,
  file: string,
  dir: string,
  ref: Pick<MediaRef, 'width' | 'height' | 'durationSec'>,
  signal?: AbortSignal,
): Promise<{ file: string; everySec: number; tiles: number; tileWidth: number; tileHeight: number } | null> {
  if (!ref.width || !ref.height || !ref.durationSec) return null;
  const everySec = Math.max(1, ref.durationSec / LANE_STRIP_MAX_TILES);
  const tiles = Math.max(1, Math.min(LANE_STRIP_MAX_TILES, Math.ceil(ref.durationSec / everySec)));
  const tileWidth = Math.max(2, Math.round((LANE_STRIP_HEIGHT * ref.width) / ref.height / 2) * 2);
  const out = join(dir, 'strip.jpg');
  await ff.run(
    [
      '-i',
      file,
      '-vf',
      `fps=1/${everySec.toFixed(4)},scale=${tileWidth}:${LANE_STRIP_HEIGHT},setsar=1,tile=${tiles}x1`,
      '-frames:v',
      '1',
      '-q:v',
      '5',
      out,
    ],
    { signal, timeoutMs: 120_000 },
  );
  if (!(await stat(out).catch(() => null))?.size) return null;
  return { file: out, everySec, tiles, tileWidth, tileHeight: LANE_STRIP_HEIGHT };
}

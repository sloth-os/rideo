import { isStillMedia, type MediaRef } from '@rideo/shared';
import type { MediaPool } from './media-pool';

/**
 * Waveforms and filmstrips of the timeline lanes (docs/design/editor.md#waveforms-and-filmstrips): computed in the
 * tab with WebCodecs from the original or the local proxy, kept per media hash for the session.
 */

/** Peaks per second of a waveform. */
export const PEAKS_PER_SEC = 100;

const peaks = new Map<string, Promise<Float32Array | null>>();
const thumbs = new Map<string, Promise<ImageBitmap | null>>();

/** The loudest sample of every 10 ms of a file's sound (0–1), or null when it has none. */
export function waveformPeaks(pool: MediaPool, media: MediaRef): Promise<Float32Array | null> {
  let p = peaks.get(media.hash);
  if (!p) {
    p = computePeaks(pool, media);
    peaks.set(media.hash, p);
    p.catch(() => peaks.delete(media.hash));
  }
  return p;
}

async function computePeaks(pool: MediaPool, media: MediaRef): Promise<Float32Array | null> {
  if (media.hasAudio === false || isStillMedia(media)) return null;
  const entry = await pool.get(media);
  if (!entry.audio) return null;
  const duration = media.durationSec ?? (await entry.input.computeDuration());
  const out = new Float32Array(Math.max(1, Math.ceil(duration * PEAKS_PER_SEC)));
  for await (const { buffer, timestamp } of entry.audio.buffers()) {
    const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) =>
      buffer.getChannelData(c),
    );
    const rate = buffer.sampleRate;
    for (let i = 0; i < buffer.length; i++) {
      const k = Math.floor((timestamp + i / rate) * PEAKS_PER_SEC);
      if (k < 0 || k >= out.length) continue;
      let v = 0;
      for (const ch of channels) v = Math.max(v, Math.abs(ch[i]!));
      if (v > out[k]!) out[k] = v;
    }
  }
  return out;
}

/** A thumbnail of a file at a time (rounded to half seconds so neighbouring tiles share them). */
export function thumbnailAt(pool: MediaPool, media: MediaRef, time: number): Promise<ImageBitmap | null> {
  const t = isStillMedia(media) ? 0 : Math.max(0, Math.round(time * 2) / 2);
  const key = `${media.hash}@${t}`;
  let p = thumbs.get(key);
  if (!p) {
    p = (async () => {
      if (isStillMedia(media)) return createImageBitmap(await pool.image(media));
      const entry = await pool.get(media);
      const frame = await entry.video?.getCanvas(t);
      return frame ? createImageBitmap(frame.canvas) : null;
    })();
    thumbs.set(key, p);
    p.catch(() => thumbs.delete(key));
  }
  return p;
}

/** Draws peaks of `[from, to]` seconds of a file across a canvas, centred, in the current fill colour. */
export function drawPeaks(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  from: number,
  to: number,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;
  for (let x = 0; x < width; x++) {
    const a = Math.floor((from + ((to - from) * x) / width) * PEAKS_PER_SEC);
    const b = Math.max(a + 1, Math.floor((from + ((to - from) * (x + 1)) / width) * PEAKS_PER_SEC));
    let v = 0;
    for (let k = a; k < b && k < data.length; k++) if (k >= 0) v = Math.max(v, data[k]!);
    const h = Math.max(1, v * (height - 2));
    ctx.fillRect(x, mid - h / 2, 1, h);
  }
}

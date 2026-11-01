import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Ffmpeg, MediaError } from './ffmpeg';

/** Composes several reference images into one labelled-by-position cast sheet (side by side). */
export async function makeCastSheet(
  ff: Ffmpeg,
  images: string[],
  out: string,
  height = 512,
  signal?: AbortSignal,
): Promise<string> {
  if (images.length === 1) {
    await ff.run(['-i', images[0]!, '-vf', `scale=-2:${height}`, out], { signal });
    return out;
  }
  const inputs = images.flatMap((p) => ['-i', p]);
  const scaled = images.map((_, i) => `[${i}:v]scale=-2:${height},setsar=1[s${i}]`).join(';');
  const stack = `${images.map((_, i) => `[s${i}]`).join('')}hstack=inputs=${images.length}[out]`;
  await ff.run([...inputs, '-filter_complex', `${scaled};${stack}`, '-map', '[out]', '-frames:v', '1', out], {
    signal,
  });
  return out;
}

/** A column or row of the grey copy is a gutter when this share of its pixels is near white. */
const GUTTER_SHARE = 0.9;
/** Near white, in a grey copy (0–255). */
const NEAR_WHITE = 232;
/** The width of the grey copy the gutters are found in. */
const SCAN_WIDTH = 960;

/**
 * Where a sheet's panels lie along one axis (docs/design/storyboard.md#scene-sheets): the runs between its gutters, the
 * positions whose share of near-white pixels is at least `GUTTER_SHARE`. Runs shorter than half a cell are specks in a
 * gutter. When the runs are not `count` cells, equal cells.
 */
export function gutterSpans(
  whiteShare: ArrayLike<number>,
  count: number,
): { found: boolean; spans: [number, number][] } {
  const length = whiteShare.length;
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= length; i++) {
    const gutter = i === length || whiteShare[i]! >= GUTTER_SHARE;
    if (!gutter && start < 0) start = i;
    if (gutter && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  const cells = runs.filter(([a, b]) => b - a >= length / count / 2);
  if (cells.length === count) return { found: true, spans: cells };
  return {
    found: false,
    spans: Array.from({ length: count }, (_, k) => [
      Math.round((k * length) / count),
      Math.round(((k + 1) * length) / count),
    ]),
  };
}

/**
 * Cuts a sheet's panels out (docs/design/storyboard.md#scene-sheets): the gutters found in a grey copy, each panel a
 * little inside its edges and to the frame's aspect from its middle, at its own size; the first `panels` cells in
 * reading order, as PNG files in `dir`.
 */
export async function cutSheet(
  ff: Ffmpeg,
  input: string,
  layout: { columns: number; rows: number; panels: number },
  frame: { width: number; height: number },
  dir: string,
  signal?: AbortSignal,
): Promise<{ files: string[]; gutters: boolean }> {
  const { width: W, height: H } = await ff
    .probe(input)
    .then((p) => ({ width: p.width ?? 0, height: p.height ?? 0 }));
  if (!W || !H) throw new MediaError(`the sheet ${input} has no size`);
  const w = SCAN_WIDTH;
  const h = Math.max(1, Math.round((w * H) / W));
  const grey = join(dir, 'sheet-scan.gray');
  await ff.run(
    ['-i', input, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', grey],
    {
      signal,
    },
  );
  const px = await readFile(grey);
  const columns = new Float64Array(w);
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if ((px[y * w + x] ?? 0) >= NEAR_WHITE) {
        columns[x]!++;
        rows[y]!++;
      }
  for (let x = 0; x < w; x++) columns[x]! /= h;
  for (let y = 0; y < h; y++) rows[y]! /= w;
  const across = gutterSpans(columns, layout.columns);
  const down = gutterSpans(rows, layout.rows);
  const aspect = frame.width / frame.height;
  const files: string[] = [];
  for (let k = 0; k < layout.panels; k++) {
    const [c0, c1] = across.spans[k % layout.columns]!.map((v) => (v * W) / w) as [number, number];
    const [r0, r1] = down.spans[Math.floor(k / layout.columns)]!.map((v) => (v * H) / h) as [number, number];
    // Inside the gutter's soft edge
    let x = c0 + (c1 - c0) * 0.006;
    let y = r0 + (r1 - r0) * 0.006;
    let pw = (c1 - c0) * 0.988;
    let ph = (r1 - r0) * 0.988;
    if (pw / ph > aspect) {
      x += (pw - ph * aspect) / 2;
      pw = ph * aspect;
    } else {
      y += (ph - pw / aspect) / 2;
      ph = pw / aspect;
    }
    const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
    const out = join(dir, `panel-${k + 1}.png`);
    await ff.run(
      [
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `crop=${even(pw)}:${even(ph)}:${Math.round(x)}:${Math.round(y)}`,
        out,
      ],
      { signal },
    );
    files.push(out);
  }
  return { files, gutters: across.found && down.found };
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  adjustmentFilters,
  applyAdjustments,
  applyOps,
  type ChromaKey,
  chunkEncodeArgs,
  chunkGraph,
  circleWeight,
  dipWeights,
  emptyTimeline,
  keyAlpha,
  keyColorOption,
  newId,
  planChunks,
  primaryTrack,
  slideOffsets,
  soundtrackEncodeArgs,
  soundtrackGraph,
  type Timeline,
  totalFrames,
  type VideoItem,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ff } from '../helpers/media';

/** The shared render plan (the browser's ffmpeg.wasm engine runs the same graphs) through native ffmpeg. */

let dir: string;
const pattern = f.media({ durationSec: 20 });
const red = f.media({ durationSec: 20, hasAudio: false });
const FONT = resolve(import.meta.dirname, '../../../web/src/engine/fonts/DejaVuSans.ttf');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rideo-render-'));
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24:duration=20',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=20',
    '-pix_fmt',
    'yuv420p',
    '-shortest',
    join(dir, 'a.mp4'),
  ]);
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=320x180:rate=30:duration=20',
    '-pix_fmt',
    'yuv420p',
    join(dir, 'b.mp4'),
  ]);
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:size=320x180:rate=24:duration=20',
    '-pix_fmt',
    'yuv420p',
    join(dir, 'c.mp4'),
  ]);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const blue = f.media({ durationSec: 20, hasAudio: false });
const inputPath = (m: { hash: string }) =>
  join(dir, m.hash === pattern.hash ? 'a.mp4' : m.hash === blue.hash ? 'c.mp4' : 'b.mp4');

/** Runs ffmpeg writing raw frames to stdout and returns the frame count. */
async function rawFrames(args: string[], width: number, height: number): Promise<number> {
  const proc = ff.spawn(['-loglevel', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], {
    stdout: true,
  });
  let bytes = 0;
  let stderr = '';
  proc.stdout!.on('data', (d: Buffer) => {
    bytes += d.length;
  });
  proc.stderr!.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const code = await new Promise<number | null>((r) => proc.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}: ${stderr}`);
  return bytes / ((width * height * 3) / 2);
}

/** Runs ffmpeg writing raw `rgb24` (or `rgba`) frames to stdout. */
async function raw(args: string[], pixFmt: 'rgb24' | 'rgba' = 'rgb24'): Promise<Buffer> {
  const proc = ff.spawn(['-loglevel', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'], {
    stdout: true,
  });
  const chunks: Buffer[] = [];
  let stderr = '';
  proc.stdout!.on('data', (d: Buffer) => chunks.push(d));
  proc.stderr!.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const code = await new Promise<number | null>((r) => proc.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}: ${stderr}`);
  return Buffer.concat(chunks);
}

/** The RGB of pixel (x, y) of frame `k` of raw rgb24 frames w × h. */
const pixel = (frames: Buffer, k: number, x: number, y: number, w = 320, h = 180) => {
  const i = k * w * h * 3 + (y * w + x) * 3;
  return [frames[i]!, frames[i + 1]!, frames[i + 2]!];
};
const near = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

async function renderChunks(t: Timeline): Promise<{ files: string[]; frames: number[] }> {
  const files: string[] = [];
  const frames: number[] = [];
  for (const chunk of planChunks(t, { targetSec: 8 })) {
    const g = chunkGraph(t, chunk, {
      quality: 'draft',
      inputPath,
      fontFile: FONT,
      textPath: (i) => join(dir, `t${chunk.index}-${i}.txt`),
    });
    for (const x of g.textFiles) await writeFile(x.path, x.content);
    frames.push(await rawFrames(g.args, g.size.width, g.size.height));
    expect(frames.at(-1)).toBe(chunk.frames);
    const out = join(dir, `part-${chunk.index}.mp4`);
    await ff.run([...g.args, ...chunkEncodeArgs('draft'), out]);
    files.push(out);
  }
  return { files, frames };
}

function film(): Timeline {
  const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
  const video = primaryTrack(base).id;
  const ids = [newId('item'), newId('item'), newId('item'), newId('item')];
  let t = applyOps(base, [
    {
      op: 'insert',
      trackId: video,
      item: {
        id: ids[0],
        kind: 'video',
        source: { type: 'media', media: pattern },
        in: 0,
        out: 10,
        fadeIn: 0.5,
      },
    },
    {
      op: 'insert',
      trackId: video,
      item: { id: ids[1], kind: 'video', source: { type: 'media', media: red }, in: 2, out: 8, speed: 2 },
    },
    {
      op: 'insert',
      trackId: video,
      item: { id: ids[2], kind: 'video', source: { type: 'media', media: pattern }, in: 5, out: 15 },
    },
    { op: 'set_transition', itemId: ids[2]!, transition: { type: 'crossfade', duration: 0.5 } },
    {
      op: 'insert',
      trackId: video,
      item: { id: ids[3], kind: 'video', source: { type: 'media', media: red }, in: 0, out: 6, fadeOut: 1 },
    },
    { op: 'set_transition', itemId: ids[3]!, transition: { type: 'wipe', duration: 0.4 } },
    {
      op: 'add_text',
      item: {
        kind: 'text',
        start: 6,
        duration: 5,
        text: 'Chapter One: “Letters”',
        style: { preset: 'title' },
      },
    },
  ]);
  t = applyOps(t, [{ op: 'split', itemId: ids[0]!, at: 4 }]);
  return t;
}

describe('render plan through native ffmpeg', () => {
  it('renders every chunk with its exact frame count (cuts, crossfade, wipe, speed, fades, text)', async () => {
    const t = film();
    const { files, frames } = await renderChunks(t);
    expect(files.length).toBeGreaterThan(1);
    expect(frames.reduce((a, b) => a + b, 0)).toBe(totalFrames(t));
    // the chunks join into the whole film (what the server's finishing pass decodes)
    const list = join(dir, 'parts.txt');
    await writeFile(list, files.map((x) => `file '${x}'`).join('\n'));
    expect(await rawFrames(['-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=24'], 320, 180)).toBe(
      totalFrames(t),
    );
  });

  it('renders one continuous soundtrack as long as the video', async () => {
    const t = film();
    const s = soundtrackGraph(t, { inputPath });
    const out = join(dir, 'soundtrack.flac');
    await ff.run([...s.args, ...soundtrackEncodeArgs(), out]);
    const probe = await ff.probe(out);
    expect(probe.hasAudio).toBe(true);
    expect(probe.durationSec).toBeCloseTo(totalFrames(t) / 24, 1);
  });

  it('pads the picture with black while the music runs past the last clip', async () => {
    const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
    const t = applyOps(base, [
      {
        op: 'insert',
        trackId: primaryTrack(base).id,
        item: { kind: 'video', source: { type: 'media', media: red }, in: 0, out: 3 },
      },
      {
        op: 'insert',
        trackId: base.tracks.find((x) => x.kind === 'audio')!.id,
        item: { kind: 'audio', source: { type: 'media', media: pattern }, start: 0, in: 0, out: 5 },
      },
    ]);
    const [chunk] = planChunks(t, { targetSec: 30 });
    expect(chunk!.frames).toBe(120);
    const g = chunkGraph(t, chunk!, {
      quality: 'draft',
      inputPath,
      textPath: (i) => join(dir, `pad-${i}.txt`),
    });
    expect(await rawFrames(g.args, 320, 180)).toBe(120);
  });
});

/** Two primary items (2 s of a, 2 s of b) with a transition of 1 s between them, at 24 fps. */
function pair(
  a: typeof pattern,
  b: typeof pattern,
  type: NonNullable<VideoItem['transitionIn']>['type'],
): Timeline {
  const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
  const video = primaryTrack(base).id;
  const second = newId('item');
  return applyOps(base, [
    {
      op: 'insert',
      trackId: video,
      item: { kind: 'video', source: { type: 'media', media: a }, in: 0, out: 2 },
    },
    {
      op: 'insert',
      trackId: video,
      item: { id: second, kind: 'video', source: { type: 'media', media: b }, in: 0, out: 2 },
    },
    { op: 'set_transition', itemId: second, transition: { type, duration: 1 } },
  ]);
}

async function renderOne(t: Timeline): Promise<Buffer> {
  const [chunk] = planChunks(t, { targetSec: 60 });
  const g = chunkGraph(t, chunk!, {
    quality: 'draft',
    inputPath,
    textPath: (i) => join(dir, `one-${i}.txt`),
  });
  for (const x of g.textFiles) await writeFile(x.path, x.content);
  const frames = await raw(g.args);
  expect(frames.length / (320 * 180 * 3)).toBe(chunk!.frames);
  return frames;
}

describe('editing tools through native ffmpeg (docs/design/editing-tools.md)', () => {
  it('renders freeze frames, mirrors, adjustments, keys and the new transitions with exact frame counts', async () => {
    const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
    const video = primaryTrack(base).id;
    const overlay = newId('track');
    const ids = Array.from({ length: 6 }, () => newId('item'));
    let t = applyOps(base, [
      {
        op: 'insert',
        trackId: video,
        item: { id: ids[0], kind: 'video', source: { type: 'media', media: pattern }, in: 0, out: 4 },
      },
      {
        op: 'insert',
        trackId: video,
        item: { id: ids[1], kind: 'video', source: { type: 'media', media: red }, in: 0, out: 3 },
      },
      { op: 'set_transition', itemId: ids[1]!, transition: { type: 'dip_to_white', duration: 0.5 } },
      {
        op: 'insert',
        trackId: video,
        item: { id: ids[2], kind: 'video', source: { type: 'media', media: blue }, in: 0, out: 3 },
      },
      { op: 'set_transition', itemId: ids[2]!, transition: { type: 'slide_up', duration: 0.5 } },
      {
        op: 'insert',
        trackId: video,
        item: { id: ids[3], kind: 'video', source: { type: 'media', media: pattern }, in: 5, out: 9 },
      },
      { op: 'set_transition', itemId: ids[3]!, transition: { type: 'circle_open', duration: 0.75 } },
      { op: 'set_flip', itemId: ids[3]!, flip: { x: true, y: true } },
      {
        op: 'set_effects',
        itemId: ids[3]!,
        effects: {
          exposure: 0.5,
          temperature: -0.4,
          tint: 0.2,
          hue: 30,
          shadows: 0.3,
          highlights: -0.2,
          vignette: 0.6,
        },
      },
      { op: 'add_track', track: { id: overlay, kind: 'video', name: 'Keyed' } },
      {
        op: 'insert',
        trackId: overlay,
        item: {
          id: ids[4],
          kind: 'video',
          source: { type: 'media', media: blue },
          start: 1,
          in: 0,
          out: 3,
        } as never,
      },
      { op: 'set_key', itemId: ids[4]!, key: { color: '#0000ff', similarity: 0.3, blend: 0.1 } },
      { op: 'set_transform', itemId: ids[4]!, transform: { keyframes: [{ t: 0, scale: 0.5 }] } },
    ]);
    t = applyOps(t, [{ op: 'freeze_frame', itemId: ids[0]!, at: 2, duration: 1.5 }]);
    const { frames } = await renderChunks(t);
    expect(frames.reduce((a, b) => a + b, 0)).toBe(totalFrames(t));
  });

  it('holds one frame for a freeze and mirrors the picture', async () => {
    const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
    const video = primaryTrack(base).id;
    const id = newId('item');
    const t = applyOps(base, [
      {
        op: 'insert',
        trackId: video,
        item: { id, kind: 'video', source: { type: 'media', media: pattern }, in: 0, out: 2 },
      },
      { op: 'freeze_frame', itemId: id, at: 1, duration: 1 },
    ]);
    // 0–1 s plays, 1–2 s holds the frame at 1 s, 2–3 s plays on from 1 s
    const frames = await renderOne(t);
    const size = 320 * 180 * 3;
    const frame = (k: number) => frames.subarray(k * size, (k + 1) * size);
    for (let k = 25; k < 48; k++) expect(frame(k).equals(frame(24))).toBe(true);
    expect(frame(24).equals(frame(48))).toBe(true);
    expect(frame(49).equals(frame(24))).toBe(false);
    // the mirror: the left of the flipped picture is the right of the plain one
    const plain = applyOps(base, [
      {
        op: 'insert',
        trackId: video,
        item: { id, kind: 'video', source: { type: 'media', media: pattern }, in: 0, out: 1 },
      },
    ]);
    const flipped = applyOps(plain, [{ op: 'set_flip', itemId: id, flip: { x: true } }]);
    const [a, b] = [await renderOne(plain), await renderOne(flipped)];
    for (const [x, y] of [
      [20, 40],
      [100, 90],
      [300, 150],
    ] as const)
      expect(near(pixel(b, 5, 319 - x, y), pixel(a, 5, x, y), 24)).toBe(true);
  });

  it('dips through white and slides as the compositor draws them', async () => {
    // red → blue, the transition 1–2 s (frames 24–48); frame 30: q = 0.25
    const dip = await renderOne(pair(red, blue, 'dip_to_white'));
    const w = dipWeights(0.25);
    const expected = [
      255 * w.out + 255 * (1 - w.out - w.in),
      255 * (1 - w.out - w.in),
      255 * w.in + 255 * (1 - w.out - w.in),
    ];
    expect(near(pixel(dip, 30, 160, 90), expected, 6)).toBe(true);
    const slide = await renderOne(pair(red, blue, 'slide_left'));
    // frame 36 (q = 0.5): the incoming frame from x = 160, the outgoing one left of it
    const at = slideOffsets('slide_left', 0.5, 320, 180).in[0];
    expect(at).toBe(160);
    expect(near(pixel(slide, 36, at - 6, 90), [255, 0, 0], 40)).toBe(true);
    expect(near(pixel(slide, 36, at + 6, 90), [0, 0, 255], 40)).toBe(true);
    const circle = await renderOne(pair(red, blue, 'circle_open'));
    const centre = circleWeight(160, 90, 320, 180, 0.5);
    const corner = circleWeight(4, 4, 320, 180, 0.5);
    expect(near(pixel(circle, 36, 160, 90), [255 * (1 - centre), 0, 255 * centre], 24)).toBe(true);
    expect(near(pixel(circle, 36, 4, 4), [255 * (1 - corner), 0, 255 * corner], 24)).toBe(true);
  });

  it('draws a hidden primary track black', async () => {
    const t = applyOps(pair(red, blue, 'crossfade'), [
      { op: 'set_track', trackId: 'trk_primaryvideo01', hidden: true },
    ]);
    const frames = await renderOne(t);
    expect(pixel(frames, 10, 160, 90).every((v) => v < 8)).toBe(true);
  });

  it('computes the adjustments and the key exactly as the filters do', async () => {
    // Every channel value through the chain: a 256 × 3 strip of r, g, b ramps
    const effects = {
      exposure: 0.35,
      temperature: 0.4,
      tint: -0.3,
      hue: 47,
      shadows: 0.45,
      highlights: -0.6,
    };
    const strip =
      'color=c=black:s=256x3,format=rgb24,geq=r=X*eq(Y\\,0)+(255-X)*eq(Y\\,2):g=X*eq(Y\\,1)+(X/2)*eq(Y\\,2):b=X*eq(Y\\,2)';
    const input = await raw(['-f', 'lavfi', '-i', strip, '-frames:v', '1']);
    const out = await raw([
      '-f',
      'lavfi',
      '-i',
      strip,
      '-frames:v',
      '1',
      '-vf',
      adjustmentFilters(effects).join(','),
    ]);
    const rgba = new Uint8ClampedArray(256 * 3 * 4);
    for (let i = 0; i < 256 * 3; i++)
      rgba.set([input[i * 3]!, input[i * 3 + 1]!, input[i * 3 + 2]!, 255], i * 4);
    applyAdjustments(rgba, 256, 3, effects);
    const mine = [...rgba].filter((_, i) => i % 4 !== 3);
    // ramps of every value in, changed by the chain
    expect(new Set(input).size).toBe(256);
    expect(out.equals(input)).toBe(false);
    expect(mine).toEqual([...out]);
    // the vignette's factors over a whole picture
    const flat = 'color=c=0xC8B4A0:s=64x36,format=rgb24';
    const vig = await raw([
      '-f',
      'lavfi',
      '-i',
      flat,
      '-frames:v',
      '1',
      '-vf',
      adjustmentFilters({ vignette: 0.7 }).join(','),
    ]);
    const pic = new Uint8ClampedArray(64 * 36 * 4);
    for (let i = 0; i < 64 * 36; i++) pic.set([200, 180, 160, 255], i * 4);
    applyAdjustments(pic, 64, 36, { vignette: 0.7 });
    expect(new Set(vig).size).toBeGreaterThan(20);
    expect([...pic].filter((_, i) => i % 4 !== 3)).toEqual([...vig]);
    // the key's alpha, hard and soft (within a level where the filters divide rather than multiply)
    for (const key of [
      { color: '#00ff00', similarity: 0.3, blend: 0 },
      { color: '#20c040', similarity: 0.12, blend: 0.25 },
    ] satisfies ChromaKey[]) {
      const keyed = await raw(
        [
          '-f',
          'lavfi',
          '-i',
          strip,
          '-frames:v',
          '1',
          '-vf',
          `format=rgba,colorkey=${keyColorOption(key)}:${key.similarity}:${key.blend}`,
        ],
        'rgba',
      );
      expect(new Set([...keyed].filter((_, i) => i % 4 === 3)).size).toBeGreaterThan(1);
      for (let i = 0; i < 256 * 3; i++) {
        const a = keyAlpha(input[i * 3]!, input[i * 3 + 1]!, input[i * 3 + 2]!, key);
        expect(Math.abs(a - keyed[i * 4 + 3]!)).toBeLessThanOrEqual(key.blend ? 1 : 0);
      }
    }
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyOps,
  chunkEncodeArgs,
  chunkGraph,
  emptyTimeline,
  newId,
  planChunks,
  primaryTrack,
  soundtrackEncodeArgs,
  soundtrackGraph,
  type Timeline,
  totalFrames,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ff } from '../helpers/media';

/** The shared render plan (the browser's ffmpeg.wasm engine runs the same graphs) through native ffmpeg. */

let dir: string;
const pattern = f.media({ durationSec: 20 });
const red = f.media({ durationSec: 20, hasAudio: false });
const FONT = resolve(import.meta.dirname, '../../../web/public/fonts/DejaVuSans.ttf');

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
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const inputPath = (m: { hash: string }) => join(dir, m.hash === pattern.hash ? 'a.mp4' : 'b.mp4');

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

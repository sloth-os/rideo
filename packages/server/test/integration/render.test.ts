import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, emptyTimeline, newId, primaryTrack, type Timeline } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRenderPlan } from '../../src/media/render';
import { ff } from '../helpers/media';

let dir: string;
const pattern = f.media({ durationSec: 3 });
const red = f.media({ durationSec: 3 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rideo-render-'));
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24:duration=3',
    '-pix_fmt',
    'yuv420p',
    join(dir, 'a.mp4'),
  ]);
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=320x180:rate=30:duration=3',
    '-pix_fmt',
    'yuv420p',
    join(dir, 'b.mp4'),
  ]);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs the plan's video graph through ffmpeg and returns the number of raw frames it produced. */
async function renderFrames(timeline: Timeline): Promise<{ frames: number; expected: number }> {
  const plan = buildRenderPlan({
    timeline,
    inputs: new Map([
      [pattern.hash, join(dir, 'a.mp4')],
      [red.hash, join(dir, 'b.mp4')],
    ]),
    quality: 'draft',
    textDir: dir,
  });
  const proc = ff.spawn(['-loglevel', 'error', ...plan.videoArgs], { stdout: true });
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
  return { frames: bytes / ((plan.width * plan.height * 3) / 2), expected: plan.totalFrames };
}

function timeline(): { t: Timeline; video: string } {
  const t = emptyTimeline({ fps: 24, width: 320, height: 180 });
  return { t, video: primaryTrack(t).id };
}

describe('server render filtergraph (ffmpeg)', () => {
  it('renders a hard cut followed by a crossfade (concat → xfade)', async () => {
    const { t, video } = timeline();
    const third = newId('item');
    const edited = applyOps(t, [
      {
        op: 'insert',
        trackId: video,
        item: { kind: 'video', source: { type: 'media', media: pattern }, in: 0, out: 3 },
      },
      {
        op: 'insert',
        trackId: video,
        item: { kind: 'video', source: { type: 'media', media: red }, in: 0, out: 3 },
      },
      {
        op: 'insert',
        trackId: video,
        item: { id: third, kind: 'video', source: { type: 'media', media: pattern }, in: 0, out: 3 },
      },
      { op: 'set_transition', itemId: third, transition: { type: 'crossfade', duration: 0.5 } },
    ]);
    const { frames, expected } = await renderFrames(edited);
    expect(frames).toBe(expected);
    expect(expected).toBe(204);
  });

  it('renders a split and trimmed clip before a wipe, with speed and fades', async () => {
    const { t, video } = timeline();
    const first = newId('item');
    const second = newId('item');
    let edited = applyOps(t, [
      {
        op: 'insert',
        trackId: video,
        item: {
          id: first,
          kind: 'video',
          source: { type: 'media', media: pattern },
          in: 0,
          out: 3,
          fadeIn: 0.5,
        },
      },
      {
        op: 'insert',
        trackId: video,
        item: { id: second, kind: 'video', source: { type: 'media', media: red }, in: 0, out: 3, speed: 2 },
      },
      { op: 'set_transition', itemId: second, transition: { type: 'wipe', duration: 0.4 } },
      { op: 'split', itemId: first, at: 1.5 },
    ]);
    edited = applyOps(edited, [{ op: 'trim', itemId: first, out: 1 }]);
    const { frames, expected } = await renderFrames(edited);
    expect(frames).toBe(expected);
  });
});

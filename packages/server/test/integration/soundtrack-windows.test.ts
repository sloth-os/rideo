import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIO_RATE,
  AUDIO_ROLES,
  applyOps,
  DEFAULT_TRACK_IDS,
  DIALOGUE_TRACK_ID,
  emptyTimeline,
  newId,
  planAudioWindows,
  primaryTrack,
  type SoundtrackGraph,
  soundtrackEncodeArgs,
  soundtrackGraph,
  stemOutputArgs,
  type Timeline,
  totalFrames,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinPieces } from '../../src/media/loudness';
import { ff } from '../helpers/media';

/**
 * The soundtrack in windows (docs/design/editor.md#soundtrack) through native ffmpeg: a tab renders it a window at a
 * time and the server joins the pieces, which must be the whole film's soundtrack sample for sample.
 */

let dir: string;
// a clip whose sound is a 440 Hz tone at 44.1 kHz (AAC), a music bed with noise at 32 kHz (AAC), a voice at 24 kHz
const clip = f.media({ durationSec: 20 });
const music = f.media({ durationSec: 30, mime: 'audio/mp4', width: undefined, height: undefined });
const voice = f.media({ durationSec: 8, mime: 'audio/wav', width: undefined, height: undefined });
const files: Record<string, string> = {};
const inputPath = (m: { hash: string }) => files[m.hash]!;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rideo-windows-'));
  files[clip.hash] = join(dir, 'clip.mp4');
  files[music.hash] = join(dir, 'music.m4a');
  files[voice.hash] = join(dir, 'voice.wav');
  await ff.run([
    ...['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=20'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=20'],
    ...['-pix_fmt', 'yuv420p', '-shortest', files[clip.hash]!],
  ]);
  // Noise: a part placed one sample off would not match
  await ff.run([
    ...['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=32000:duration=30'],
    ...['-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=32000:duration=30:amplitude=0.3'],
    ...['-filter_complex', 'amix=inputs=2', '-c:a', 'aac', '-b:a', '128k', files[music.hash]!],
  ]);
  await ff.run([
    ...['-f', 'lavfi', '-i', 'anoisesrc=color=white:sample_rate=24000:duration=8:amplitude=0.2'],
    files[voice.hash]!,
  ]);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Clip sound with fades, a crossfade and a sped-up item; a music bed with fades; a line at a fractional time. */
function film(): Timeline {
  const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
  const video = primaryTrack(base).id;
  const ids = [newId('item'), newId('item'), newId('item')];
  return applyOps(base, [
    {
      op: 'insert',
      trackId: video,
      item: {
        id: ids[0],
        kind: 'video',
        source: { type: 'media', media: clip },
        in: 0.37,
        out: 6.2,
        fadeIn: 0.3,
      },
    },
    {
      op: 'insert',
      trackId: video,
      item: { id: ids[1], kind: 'video', source: { type: 'media', media: clip }, in: 2, out: 9, speed: 2 },
    },
    {
      op: 'insert',
      trackId: video,
      item: { id: ids[2], kind: 'video', source: { type: 'media', media: clip }, in: 5.123, out: 14.4 },
    },
    { op: 'set_transition', itemId: ids[2]!, transition: { type: 'crossfade', duration: 0.5 } },
    {
      op: 'insert',
      trackId: DEFAULT_TRACK_IDS.audio,
      item: {
        kind: 'audio',
        source: { type: 'media', media: music },
        start: 0.5,
        in: 1.2501,
        out: 19,
        fadeIn: 1,
        fadeOut: 2,
      },
    },
    { op: 'add_track', track: { id: DIALOGUE_TRACK_ID, kind: 'audio', name: 'Dialogue' } },
    {
      op: 'insert',
      trackId: DIALOGUE_TRACK_ID,
      item: {
        kind: 'audio',
        source: { type: 'media', media: voice },
        start: 7.3333,
        in: 0.25,
        out: 6.5,
        speech: [[0.5, 5]],
      },
    },
    { op: 'set_mix', ducking: { enabled: true } },
  ]);
}

async function render(g: SoundtrackGraph, name: string) {
  const out = (role: string) => join(dir, `${name}-${role}.flac`);
  await ff.run([...g.args, ...soundtrackEncodeArgs(), out('mix'), ...stemOutputArgs(g, out)]);
  return { mix: out('mix'), ...Object.fromEntries(AUDIO_ROLES.map((r) => [r, out(r)])) } as Record<
    string,
    string
  >;
}

/** Decoded 16-bit stereo samples. */
async function pcm(path: string): Promise<Int16Array> {
  const proc = ff.spawn(['-loglevel', 'error', '-i', path, '-f', 's16le', '-ac', '2', '-'], { stdout: true });
  const chunks: Buffer[] = [];
  proc.stdout!.on('data', (d: Buffer) => chunks.push(d));
  const code = await new Promise<number | null>((r) => proc.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  const buf = Buffer.concat(chunks);
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

/** How many samples differ, and by how much at most. */
function compare(a: Int16Array, b: Int16Array) {
  let differ = 0;
  let worst = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > 0) differ++;
    worst = Math.max(worst, d);
  }
  return { differ, worst, lengths: [a.length, b.length] };
}

describe('the soundtrack in windows (docs/design/editor.md#soundtrack)', () => {
  it('plans whole-second windows that keep out of sped-up sound', () => {
    const t = film();
    const windows = planAudioWindows(t, { targetSec: 4 });
    const len = totalFrames(t) / t.fps;
    expect(windows[0]!.start).toBe(0);
    expect(windows.at(-1)!.end).toBeCloseTo(len, 9);
    for (const [k, w] of windows.entries()) {
      expect(w.index).toBe(k);
      if (k > 0) expect(w.start).toBe(windows[k - 1]!.end);
      if (k < windows.length - 1) expect(Number.isInteger(w.end)).toBe(true);
    }
    // the sped-up item plays 5.83–9.33 s: no boundary inside it
    const sped = { start: 6.2 - 0.37, end: 6.2 - 0.37 + 3.5 };
    expect(windows.some((w) => w.start > sped.start && w.start < sped.end)).toBe(false);
    expect(planAudioWindows(t).length).toBe(1);
    // with two-second windows no free second is near: the window runs on past the sped-up item
    const short = planAudioWindows(t, { targetSec: 2 });
    expect(short.some((w) => w.start > sped.start && w.start < sped.end)).toBe(false);
    expect(short.find((w) => w.start < sped.start && w.end > sped.end)).toBeTruthy();
  });

  it('joins windows into the whole film without a seam, stems included', async () => {
    const t = film();
    const whole = await render(soundtrackGraph(t, { inputPath, stems: true }), 'whole');
    const windows = planAudioWindows(t, { targetSec: 4 });
    expect(windows.length).toBeGreaterThan(3);
    const pieces: Record<string, string>[] = [];
    for (const w of windows) {
      const g = soundtrackGraph(t, { inputPath, stems: true, window: w });
      // a window reads only the media it plays
      expect(g.media.length).toBeLessThanOrEqual(3);
      expect(g.durationSec).toBeCloseTo(w.end - w.start, 4);
      pieces.push(await render(g, `w${w.index}`));
    }
    for (const role of ['mix', ...AUDIO_ROLES]) {
      const joined = await joinPieces(
        { ff },
        pieces.map((p) => p[role]!),
        join(dir, `joined-${role}.flac`),
      );
      const [a, b] = [await pcm(whole[role]!), await pcm(joined)];
      expect(a.length).toBe(Math.round((totalFrames(t) / t.fps) * AUDIO_RATE) * 2);
      // The same float samples; ffmpeg's conversion to 16 bits may round a few of them the other way. A seam (a
      // sample off, a resampler or a decoder starting over) differs by tens of steps.
      const c = compare(a, b);
      expect({ role, worst: c.worst, lengths: c.lengths }).toEqual({
        role,
        worst: c.differ ? 1 : 0,
        lengths: [a.length, a.length],
      });
      expect(c.differ / a.length).toBeLessThan(0.005);
    }
  });
});

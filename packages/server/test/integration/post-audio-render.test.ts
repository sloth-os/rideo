import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIO_ROLES,
  applyOps,
  DEFAULT_TRACK_IDS,
  DIALOGUE_TRACK_ID,
  duckEnvelope,
  duckGainAt,
  emptyTimeline,
  loudnormFilter,
  parseLoudnorm,
  soundtrackEncodeArgs,
  soundtrackGraph,
  stemOutputArgs,
  type Timeline,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeSoundtrack } from '../../src/media/loudness';
import { ff } from '../helpers/media';

/** Post audio (docs/design/post-audio.md) through native ffmpeg: the shared graphs the browser runs in wasm. */

let dir: string;
const music = f.media({ durationSec: 12, mime: 'audio/wav' });
const speech = f.media({ durationSec: 5, mime: 'audio/wav' });
const files: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rideo-post-audio-'));
  files[music.hash] = join(dir, 'music.wav');
  files[speech.hash] = join(dir, 'speech.wav');
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=12:sample_rate=48000',
    '-af',
    'volume=0.5',
    files[music.hash]!,
  ]);
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=5:sample_rate=48000',
    '-af',
    'volume=0.3',
    files[speech.hash]!,
  ]);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const inputPath = (m: { hash: string }) => files[m.hash]!;

/** A music bed under a TTS mix whose lines are at 1–2.5 s and 3–4 s. */
function scene(): Timeline {
  const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
  return applyOps(base, [
    {
      op: 'insert',
      trackId: DEFAULT_TRACK_IDS.audio,
      item: { kind: 'audio', source: { type: 'media', media: music }, start: 0, in: 0, out: 12 },
    },
    { op: 'add_track', track: { id: DIALOGUE_TRACK_ID, kind: 'audio', name: 'Dialogue' } },
    {
      op: 'insert',
      trackId: DIALOGUE_TRACK_ID,
      item: {
        kind: 'audio',
        source: { type: 'media', media: speech },
        start: 0,
        in: 0,
        out: 5,
        speech: [
          [1, 2.5],
          [3, 4],
        ],
      },
    },
    { op: 'set_mix', ducking: { enabled: true } },
  ]);
}

/** Decodes audio to mono float samples at `rate`. */
async function samples(path: string, rate = 8000, channels = 1): Promise<Float32Array> {
  const proc = ff.spawn(
    ['-loglevel', 'error', '-i', path, '-f', 'f32le', '-ac', String(channels), '-ar', String(rate), '-'],
    {
      stdout: true,
    },
  );
  const chunks: Buffer[] = [];
  proc.stdout!.on('data', (d: Buffer) => chunks.push(d));
  const code = await new Promise<number | null>((r) => proc.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

const rms = (x: Float32Array, rate: number, from: number, to: number) => {
  let sum = 0;
  const a = Math.round(from * rate);
  const b = Math.round(to * rate);
  for (let i = a; i < b; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / (b - a));
};
const db = (v: number) => 20 * Math.log10(v);

async function render(t: Timeline, name: string) {
  const g = soundtrackGraph(t, { inputPath, stems: true });
  const out = (r: string) => join(dir, `${name}-${r}.flac`);
  await ff.run([...g.args, ...soundtrackEncodeArgs(), out('mix'), ...stemOutputArgs(g, out)]);
  return {
    mix: out('mix'),
    stems: Object.fromEntries(AUDIO_ROLES.map((r) => [r, out(r)])) as Record<string, string>,
  };
}

describe('the soundtrack graph (docs/design/post-audio.md#ducking)', () => {
  it('ducks the music under speech by the depth, with the shared envelope', async () => {
    const t = scene();
    const env = duckEnvelope(t)!;
    const { stems } = await render(t, 'duck');
    const m = await samples(stems.music!);
    const open = rms(m, 8000, 6, 7);
    const ducked = rms(m, 8000, 1.5, 3.5);
    expect(db(ducked / open)).toBeGreaterThan(-12.8);
    expect(db(ducked / open)).toBeLessThan(-11.2);
    // the ramps follow duckGainAt (its RMS over the same window) within a decibel
    const envelopeRms = (from: number, to: number) => {
      let sum = 0;
      const n = 200;
      for (let k = 0; k < n; k++) sum += duckGainAt(env, from + ((k + 0.5) / n) * (to - from)) ** 2;
      return Math.sqrt(sum / n);
    };
    for (const at of [0.95, 4.3]) {
      const measured = rms(m, 8000, at - 0.05, at + 0.05) / open;
      expect(Math.abs(db(measured) - db(envelopeRms(at - 0.05, at + 0.05)))).toBeLessThan(1);
    }
    // without ducking the music is untouched
    const flat = await render(applyOps(t, [{ op: 'set_mix', ducking: { enabled: false } }]), 'flat');
    const fm = await samples(flat.stems.music!);
    expect(Math.abs(db(rms(fm, 8000, 1.5, 3.5) / rms(fm, 8000, 6, 7)))).toBeLessThan(0.3);
  });

  it('renders stems that sum to the mix', async () => {
    const { mix, stems } = await render(scene(), 'sum');
    const total = await samples(mix, 48000, 2);
    const parts = await Promise.all(AUDIO_ROLES.map((r) => samples(stems[r]!, 48000, 2)));
    expect(parts.every((p) => Math.abs(p.length - total.length) <= 2)).toBe(true);
    let worst = 0;
    for (let i = 0; i < total.length; i += 7) {
      const sum = parts.reduce((s, p) => s + (p[i] ?? 0), 0);
      worst = Math.max(worst, Math.abs(sum - total[i]!));
    }
    expect(worst).toBeLessThan(0.002);
    // the effects stem is silence
    const fx = parts[2]!;
    expect(rms(fx, 48000 * 2, 0, 5)).toBeLessThan(1e-4);
  });
});

describe('loudness normalization (docs/design/post-audio.md#loudness)', () => {
  async function measure(path: string) {
    const log = await ff.run(['-i', path, '-af', loudnormFilter('streaming'), '-f', 'null', '-'], {
      logLevel: 'info',
    });
    return parseLoudnorm(log)!;
  }

  it('normalizes to the streaming and broadcast targets; stems keep summing to the mix', async () => {
    const { mix, stems } = await render(scene(), 'loud');
    const before = await measure(mix);
    for (const [target, lufs] of [
      ['streaming', -14],
      ['broadcast', -23],
    ] as const) {
      const work = await mkdtemp(join(dir, `${target}-`));
      const r = await normalizeSoundtrack(
        { ff },
        { soundtrack: mix, stems: stems as never, target, dir: work },
      );
      expect(r.loudness).toMatchObject({ target, mode: 'linear' });
      expect(r.loudness.inputLufs).toBeCloseTo(before.inputI, 0);
      expect(Math.abs(r.loudness.integratedLufs! - lufs)).toBeLessThan(1);
      expect(r.loudness.truePeakDb!).toBeLessThanOrEqual(-0.9);
      const after = await measure(r.audio);
      expect(Math.abs(after.inputI - lufs)).toBeLessThan(1);
      // stems with the mix's gain still sum to the normalized mix
      const total = await samples(r.audio, 48000, 2);
      const parts = await Promise.all(AUDIO_ROLES.map((role) => samples(r.stems![role], 48000, 2)));
      let worst = 0;
      for (let i = 0; i < total.length; i += 11) {
        worst = Math.max(worst, Math.abs(parts.reduce((s, p) => s + (p[i] ?? 0), 0) - total[i]!));
      }
      expect(worst).toBeLessThan(0.01);
    }
  });

  it('leaves silence and "off" alone', async () => {
    const silent = join(dir, 'silent.flac');
    await ff.run(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3', '-c:a', 'flac', silent]);
    const s = await normalizeSoundtrack(
      { ff },
      { soundtrack: silent, stems: null, target: 'streaming', dir: await mkdtemp(join(dir, 'silent-')) },
    );
    expect(s.loudness).toMatchObject({ mode: 'silent', integratedLufs: null });
    const { mix } = await render(scene(), 'off');
    const off = await normalizeSoundtrack(
      { ff },
      { soundtrack: mix, stems: null, target: 'off', dir: await mkdtemp(join(dir, 'off-')) },
    );
    expect(off.loudness).toMatchObject({ target: 'off', mode: 'off' });
    expect((await ff.probe(off.audio)).hasAudio).toBe(true);
  });
});

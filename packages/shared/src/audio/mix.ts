import type { Timeline } from '../schemas/timeline';
import { audioSegments } from '../timeline/query';

/**
 * Ducking (docs/design/post-audio.md#ducking): the music bus dips under speech. The breakpoints and the ffmpeg
 * expression come from one envelope, so the preview (WebAudio) and the render (ffmpeg) duck the same way.
 */

export type Span = [number, number];

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Sorted spans, merging those that overlap or are closer than `gap` seconds. */
export function mergeSpans(spans: readonly Span[], gap = 0): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a - last[1] < gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Where speech is heard, in timeline seconds: the speech spans of every audible dialogue-stem source, and whole
 * dialogue-track items that do not say where their speech is (a voice-over).
 */
export function speechIntervals(t: Timeline, gap = 0): Span[] {
  const spans: Span[] = [];
  for (const seg of audioSegments(t)) {
    if (seg.role !== 'dialogue' || seg.volume <= 0 || seg.media.hasAudio === false) continue;
    if (seg.speech) {
      for (const [a, b] of seg.speech) {
        const lo = Math.max(a, seg.in);
        const hi = Math.min(b, seg.out);
        if (hi - lo <= 1e-3) continue;
        spans.push([
          seg.start + (lo - seg.in) / seg.speed,
          Math.min(seg.end, seg.start + (hi - seg.in) / seg.speed),
        ]);
      }
    } else if (!seg.primary) spans.push([seg.start, seg.end]);
  }
  return mergeSpans(spans, gap);
}

export interface DuckEnvelope {
  /** Linear music gain under speech. */
  floor: number;
  attack: number;
  release: number;
  /** Merged speech spans (timeline seconds); ramps of neighbours never overlap. */
  spans: Span[];
}

/** The music duck of a cut, or null when it has no ducking, no music or no speech. */
export function duckEnvelope(t: Timeline): DuckEnvelope | null {
  const d = t.mix?.ducking;
  if (!d?.enabled || d.depthDb >= 0) return null;
  if (!audioSegments(t).some((s) => s.role === 'music' && s.volume > 0)) return null;
  const spans = speechIntervals(t, d.attackSec + d.releaseSec);
  if (!spans.length) return null;
  return { floor: 10 ** (d.depthDb / 20), attack: d.attackSec, release: d.releaseSec, spans };
}

/** The music gain at `time` (1 = untouched): the reference the preview and the render are tested against. */
export function duckGainAt(env: DuckEnvelope | null, time: number): number {
  if (!env) return 1;
  let sum = 0;
  for (const [a, b] of env.spans) {
    sum += clamp01((time - (a - env.attack)) / env.attack) * clamp01((b + env.release - time) / env.release);
  }
  return 1 - (1 - env.floor) * Math.min(1, sum);
}

/** `t - x` with a readable sign. */
const minus = (x: number) => (x >= 0 ? `t-${n(x)}` : `t+${n(-x)}`);

/** The envelope as an ffmpeg expression of `t` (timeline seconds), for `volume=…:eval=frame`. */
export function duckExpression(env: DuckEnvelope): string {
  const terms = env.spans.map(
    ([a, b]) =>
      `clip((${minus(a - env.attack)})/${n(env.attack)},0,1)*clip((${n(b + env.release)}-t)/${n(env.release)},0,1)`,
  );
  return `1-${n(1 - env.floor)}*min(1,${terms.join('+')})`;
}

/**
 * Breakpoints of the music gain from `from` on, for `linearRampToValueAtTime`: the gain is linear between
 * consecutive points and holds after the last one.
 */
export function duckPoints(env: DuckEnvelope, from = 0): { time: number; gain: number }[] {
  const points = [{ time: from, gain: duckGainAt(env, from) }];
  for (const [a, b] of env.spans)
    for (const time of [a - env.attack, a, b, b + env.release])
      if (time > from + 1e-6) points.push({ time, gain: duckGainAt(env, time) });
  return points;
}

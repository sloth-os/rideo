import { z } from 'zod';

/**
 * Speed ramps (docs/design/editor.md#speed-ramps): the speed at points of the source, linear in between and held
 * outside. The item's time map (item seconds ↔ source seconds) is exact at the ramp points and sampled in between,
 * and the preview, the compositor and the ffmpeg `setpts` all read the same piecewise-linear map.
 */

export const RampPointSchema = z.object({
  /** Source seconds. */
  at: z.number().min(0).max(360_000),
  speed: z.number().min(0.1).max(8),
});
export const RampSchema = z.object({ points: z.array(RampPointSchema).min(2).max(50) });
export type Ramp = z.infer<typeof RampSchema>;

export interface TimeMap {
  /** `[item seconds, source seconds]`, increasing in both. */
  points: [number, number][];
  /** The item's length on the timeline. */
  duration: number;
}

/** At most this many points in a time map (they become nested `if`s in ffmpeg). */
const MAX_POINTS = 64;
const cache = new Map<string, TimeMap>();

function sortedPoints(ramp: Ramp): { at: number; speed: number }[] {
  return [...ramp.points].sort((a, b) => a.at - b.at);
}

/** Speed at a source time. */
export function rampSpeedAt(ramp: Ramp, src: number): number {
  const pts = sortedPoints(ramp);
  if (src <= pts[0]!.at) return pts[0]!.speed;
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i]!;
    if (src <= b.at) {
      const a = pts[i - 1]!;
      return b.at - a.at < 1e-9 ? b.speed : a.speed + ((src - a.at) * (b.speed - a.speed)) / (b.at - a.at);
    }
  }
  return pts.at(-1)!.speed;
}

/** Item seconds spent playing source `[s0, s1]` where the speed goes linearly from `v0` (at s0) to `v1` (at s1). */
function spent(s0: number, s1: number, v0: number, v1: number, s: number): number {
  if (s1 - s0 < 1e-12) return 0;
  const b = (v1 - v0) / (s1 - s0);
  if (Math.abs(b) < 1e-12) return (s - s0) / v0;
  return Math.log((v0 + b * (s - s0)) / v0) / b;
}

/** The time map of an item: linear for a constant speed, exact at the ramp's points and sampled between them. */
export function timeMapOf(item: { in: number; out: number; speed: number; ramp?: Ramp | null }): TimeMap {
  if (!item.ramp) {
    const duration = (item.out - item.in) / item.speed;
    return {
      points: [
        [0, item.in],
        [duration, item.out],
      ],
      duration,
    };
  }
  const key = `${item.in}|${item.out}|${JSON.stringify(item.ramp.points)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // Constant-speed or linearly changing pieces of the source range
  const pts = sortedPoints(item.ramp);
  const knots = [item.in, ...pts.map((p) => p.at).filter((a) => a > item.in && a < item.out), item.out];
  const pieces = knots.length - 1;
  const per = Math.max(1, Math.floor((MAX_POINTS - 1) / pieces));
  const points: [number, number][] = [[0, item.in]];
  let local = 0;
  for (let k = 0; k < pieces; k++) {
    const s0 = knots[k]!;
    const s1 = knots[k + 1]!;
    const v0 = rampSpeedAt(item.ramp, s0);
    const v1 = rampSpeedAt(item.ramp, s1);
    const steps = Math.abs(v1 - v0) < 1e-9 ? 1 : per;
    for (let j = 1; j <= steps; j++) {
      const s = s0 + ((s1 - s0) * j) / steps;
      points.push([local + spent(s0, s1, v0, v1, s), s]);
    }
    local += spent(s0, s1, v0, v1, s1);
  }
  const map = { points, duration: local };
  if (cache.size > 500) cache.clear();
  cache.set(key, map);
  return map;
}

function along(points: readonly [number, number][], v: number, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  const first = points[0]!;
  if (v <= first[from])
    return first[to] + (v - first[from]) * slope(points[0]!, points[1] ?? points[0]!, from);
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (v <= b[from]) {
      const a = points[i - 1]!;
      return b[from] - a[from] < 1e-12
        ? b[to]
        : a[to] + ((v - a[from]) * (b[to] - a[to])) / (b[from] - a[from]);
    }
  }
  const last = points.at(-1)!;
  return last[to] + (v - last[from]) * slope(points.at(-2) ?? last, last, from);
}

function slope(a: [number, number], b: [number, number], from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  return b[from] - a[from] < 1e-12 ? 1 : (b[to] - a[to]) / (b[from] - a[from]);
}

/** Source seconds shown `local` seconds into the item. */
export function sourceAtLocal(map: TimeMap, local: number): number {
  return along(map.points, local, 0);
}

/** Item seconds at which a source time is shown. */
export function localAtSource(map: TimeMap, src: number): number {
  return along(map.points, src, 1);
}

/** The part of a time map between two item times, both axes shifted to start at 0 (a chunk's piece of an item). */
export function sliceTimeMap(map: TimeMap, fromLocal: number, toLocal: number): [number, number][] {
  const s0 = sourceAtLocal(map, fromLocal);
  const inner = map.points.filter(([l]) => l > fromLocal + 1e-9 && l < toLocal - 1e-9);
  const pts: [number, number][] = [[fromLocal, s0], ...inner, [toLocal, sourceAtLocal(map, toLocal)]];
  return pts.map(([l, s]) => [l - fromLocal, s - s0]);
}

/** Presets of the inspector. */
export function rampPreset(
  kind: 'ease_in' | 'ease_out' | 'speed_up_middle',
  range: { in: number; out: number },
): Ramp {
  const mid = (range.in + range.out) / 2;
  if (kind === 'ease_in')
    return {
      points: [
        { at: range.in, speed: 0.5 },
        { at: range.out, speed: 2 },
      ],
    };
  if (kind === 'ease_out')
    return {
      points: [
        { at: range.in, speed: 2 },
        { at: range.out, speed: 0.5 },
      ],
    };
  return {
    points: [
      { at: range.in, speed: 1 },
      { at: mid, speed: 3 },
      { at: range.out, speed: 1 },
    ],
  };
}

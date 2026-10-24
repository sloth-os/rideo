import type { Timeline } from '../schemas/timeline';
import { itemEnd } from './ops';
import { timelineDuration } from './query';

/** What a snap target is: where it comes from, for the guide's label and for tests. */
export type SnapKind = 'origin' | 'end' | 'item' | 'marker' | 'playhead';

export interface SnapTarget {
  t: number;
  kind: SnapKind;
}

/**
 * Where dragged things snap (docs/design/editing-tools.md#snapping): 0, the end of the cut, every item's start and end
 * (but the excluded items'), every marker and the playhead. Sorted by time, one target per time.
 */
export function snapTargets(
  t: Timeline,
  opts: { exclude?: readonly string[]; playhead?: number } = {},
): SnapTarget[] {
  const exclude = new Set(opts.exclude ?? []);
  const out: SnapTarget[] = [{ t: 0, kind: 'origin' }];
  for (const track of t.tracks)
    for (const item of track.items) {
      if (exclude.has(item.id)) continue;
      out.push({ t: item.start, kind: 'item' }, { t: itemEnd(item), kind: 'item' });
    }
  for (const m of t.markers ?? []) out.push({ t: m.t, kind: 'marker' });
  if (opts.playhead !== undefined) out.push({ t: opts.playhead, kind: 'playhead' });
  out.push({ t: timelineDuration(t), kind: 'end' });
  out.sort((a, b) => a.t - b.t);
  return out.filter((x, i) => i === 0 || Math.abs(x.t - out[i - 1]!.t) > 1e-6);
}

/** The nearest target within `tolerance` seconds of `t`, or null. */
export function nearestTarget(
  t: number,
  targets: readonly SnapTarget[],
  tolerance: number,
): SnapTarget | null {
  let best: SnapTarget | null = null;
  for (const x of targets) {
    const d = Math.abs(x.t - t);
    if (d <= tolerance && (!best || d < Math.abs(best.t - t))) best = x;
  }
  return best;
}

/** `t` moved onto the nearest target within `tolerance` seconds, else `t`. */
export function snapTime(t: number, targets: readonly SnapTarget[], tolerance: number): number {
  return nearestTarget(t, targets, tolerance)?.t ?? t;
}

/**
 * Snaps a span that keeps its length (a dragged item): by its start or its end, whichever lands nearer a target.
 * Returns the snapped start and the target it met (null when neither edge is near one).
 */
export function snapSpan(
  start: number,
  length: number,
  targets: readonly SnapTarget[],
  tolerance: number,
): { start: number; target: SnapTarget | null } {
  const a = nearestTarget(start, targets, tolerance);
  const b = nearestTarget(start + length, targets, tolerance);
  const da = a ? Math.abs(a.t - start) : Number.POSITIVE_INFINITY;
  const db = b ? Math.abs(b.t - (start + length)) : Number.POSITIVE_INFINITY;
  if (a && da <= db) return { start: a.t, target: a };
  if (b) return { start: Math.max(0, b.t - length), target: b };
  return { start, target: null };
}

/**
 * The edit points ↑ and ↓ go to (docs/design/editing-tools.md#shortcuts): 0, every item's start and end on any track
 * and every marker, in time order.
 */
export function editPoints(t: Timeline): number[] {
  const set = new Set<number>([0]);
  for (const track of t.tracks)
    for (const item of track.items) {
      set.add(Math.round(item.start * 1e6) / 1e6);
      set.add(Math.round(itemEnd(item) * 1e6) / 1e6);
    }
  for (const m of t.markers ?? []) set.add(m.t);
  return [...set].sort((a, b) => a - b);
}

/** The first edit point more than a hundredth of a second after `time`. */
export function nextEditPoint(t: Timeline, time: number): number | null {
  return editPoints(t).find((x) => x > time + 0.01) ?? null;
}

/** The last edit point more than a hundredth of a second before `time`. */
export function previousEditPoint(t: Timeline, time: number): number | null {
  const points = editPoints(t);
  for (let i = points.length - 1; i >= 0; i--) if (points[i]! < time - 0.01) return points[i]!;
  return null;
}

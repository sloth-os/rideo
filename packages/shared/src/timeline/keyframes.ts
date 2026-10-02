import { z } from 'zod';

/**
 * Transforms and keyframes (docs/design/editor.md#multitrack-transforms-and-keyframes): a video item's position,
 * scale, rotation and opacity over its time, interpolated linearly between the keyframes that set each property.
 */

export const KeyframeSchema = z.object({
  /** Seconds from the item's start on the timeline. */
  t: z.number().min(0).max(36_000),
  /** Centre of the picture, fractions of the frame. */
  x: z.number().min(-1).max(2).optional(),
  y: z.number().min(-1).max(2).optional(),
  /** 1 = the picture fitted to the frame. */
  scale: z.number().min(0.05).max(4).optional(),
  /** Degrees, clockwise. */
  rotation: z.number().min(-720).max(720).optional(),
  opacity: z.number().min(0).max(1).optional(),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

/** Keyframes in any order (readers sort them; `set_transform` stores them sorted). */
export const TransformSchema = z.object({ keyframes: z.array(KeyframeSchema).min(1).max(100) });
export type Transform = z.infer<typeof TransformSchema>;

export interface TransformState {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}
export type TransformProp = keyof TransformState;
export const TRANSFORM_PROPS: TransformProp[] = ['x', 'y', 'scale', 'rotation', 'opacity'];
export const IDENTITY_TRANSFORM: TransformState = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 };

/** The points of one property in time order (a later keyframe at the same time wins), or null when none sets it. */
export function propertyCurve(
  transform: Transform | null | undefined,
  prop: TransformProp,
): [number, number][] | null {
  const pts: [number, number][] = [];
  const sorted = [...(transform?.keyframes ?? [])].sort((a, b) => a.t - b.t);
  for (const k of sorted) {
    const v = k[prop];
    if (v === undefined) continue;
    if (pts.length && Math.abs(pts.at(-1)![0] - k.t) < 1e-9) pts[pts.length - 1] = [k.t, v];
    else pts.push([k.t, v]);
  }
  return pts.length ? pts : null;
}

/** Piecewise-linear value at `t`, held before the first point and after the last. */
export function interpolate(points: readonly [number, number][], t: number): number {
  const first = points[0]!;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]!;
    if (t <= t1) {
      const [t0, v0] = points[i - 1]!;
      return t1 - t0 < 1e-9 ? v1 : v0 + ((t - t0) * (v1 - v0)) / (t1 - t0);
    }
  }
  return points.at(-1)![1];
}

/** Whether a transform changes anything (a single default keyframe does not). */
export function isIdentity(transform: Transform | null | undefined): boolean {
  if (!transform) return true;
  return TRANSFORM_PROPS.every((p) => {
    const c = propertyCurve(transform, p);
    return !c || c.every(([, v]) => Math.abs(v - IDENTITY_TRANSFORM[p]) < 1e-9);
  });
}

/** Every property at `local` seconds of the item. */
export function transformAt(transform: Transform | null | undefined, local: number): TransformState {
  const out = { ...IDENTITY_TRANSFORM };
  for (const p of TRANSFORM_PROPS) {
    const c = propertyCurve(transform, p);
    if (c) out[p] = interpolate(c, local);
  }
  return out;
}

/** Whether a property varies over `[0, duration]`. */
export function isAnimated(transform: Transform | null | undefined, prop: TransformProp): boolean {
  const c = propertyCurve(transform, prop);
  return !!c && c.length > 1 && c.some(([, v]) => Math.abs(v - c[0]![1]) > 1e-9);
}

const num = (v: number) => (Math.round(v * 1e5) / 1e5).toString();

/**
 * A piecewise-linear function of `variable` as an ffmpeg expression (nested `if`s, commas escaped for a quoted
 * filter option). `shift` is added to the variable first (item time = chunk time + shift).
 */
export function linearExpression(points: readonly [number, number][], variable = 't', shift = 0): string {
  const v = shift === 0 ? variable : `(${variable}${shift > 0 ? '+' : '-'}${num(Math.abs(shift))})`;
  if (points.length === 1 || points.every(([, y]) => Math.abs(y - points[0]![1]) < 1e-12))
    return num(points[0]![1]);
  let expr = num(points.at(-1)![1]);
  for (let i = points.length - 1; i >= 1; i--) {
    const [t0, v0] = points[i - 1]!;
    const [t1, v1] = points[i]!;
    const seg = t1 - t0 < 1e-9 ? num(v1) : `${num(v0)}+(${v}-${num(t0)})*${num((v1 - v0) / (t1 - t0))}`;
    expr = `if(lt(${v}\\,${num(t1)})\\,${seg}\\,${expr})`;
  }
  const [t0, v0] = points[0]!;
  return `if(lt(${v}\\,${num(t0)})\\,${num(v0)}\\,${expr})`;
}

/**
 * The opacity of an overlay item over its time: its opacity keyframes times the fades, which fade overlays to
 * transparent (docs/design/editor.md#timeline-model). Points every frame while it changes, for `sendcmd`.
 */
export function opacityAt(
  transform: Transform | null | undefined,
  fades: { fadeIn?: number; fadeOut?: number },
  duration: number,
  local: number,
): number {
  let o = transformAt(transform, local).opacity;
  if (fades.fadeIn && local < fades.fadeIn) o *= Math.max(0, local / fades.fadeIn);
  if (fades.fadeOut && duration - local < fades.fadeOut) o *= Math.max(0, (duration - local) / fades.fadeOut);
  return Math.min(1, Math.max(0, o));
}

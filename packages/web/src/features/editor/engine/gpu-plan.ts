import {
  type ChromaKey,
  type CubeLut,
  channelGains,
  type Effects,
  hasAdjustments,
  hexRgb,
  hueMatrix,
  vignetteAngle,
  wipeEdge,
} from '@rideo/shared';

/**
 * The CPU half of WebGPU compositing (docs/design/engine-performance.md#webgpu-compositing): where each quad goes,
 * which part of its texture it shows and the numbers its shader reads. Pure, so it is tested without a GPU.
 */

/** Where a picture goes, in output pixels: its centre, size and rotation (degrees, clockwise as the canvas). */
export interface Placement {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

/** A part of a texture: left, top, width, height, from 0 to 1. */
export type UvRect = [number, number, number, number];

/**
 * The affine map from quad corners (u, v from 0 to 1) to clip space, as `[a, b, c, d, e, f]`:
 * `x = a·u + b·v + c`, `y = d·u + e·v + f` (canvas pixels have y down, clip space y up).
 */
export function placementToClip(
  p: Placement,
  out: { width: number; height: number },
): [number, number, number, number, number, number] {
  const t = (p.rotation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const W = out.width;
  const H = out.height;
  // pixel(u, v) = (cx, cy) + R(t)·((u − ½)·w, (v − ½)·h)
  const x0 = p.cx - (cos * p.w) / 2 + (sin * p.h) / 2;
  const y0 = p.cy - (sin * p.w) / 2 - (cos * p.h) / 2;
  return [
    (2 * cos * p.w) / W,
    (-2 * sin * p.h) / W,
    (2 * x0) / W - 1,
    (-2 * sin * p.w) / H,
    (-2 * cos * p.h) / H,
    1 - (2 * y0) / H,
  ];
}

/** Where a corner of the quad lands in clip space (the vertex shader's arithmetic). */
export function clipOf(m: ReturnType<typeof placementToClip>, u: number, v: number): [number, number] {
  return [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]];
}

/** A rectangle of a source image as a part of it. */
export function uvOf(
  rect: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): UvRect {
  return [rect.x / size.width, rect.y / size.height, rect.width / size.width, rect.height / size.height];
}

/** A UV rectangle mirrored left–right and/or upside down (docs/design/editing-tools.md#mirror). */
export function flipUv(uv: UvRect, flip: { x?: boolean; y?: boolean } | undefined): UvRect {
  let [u, v, w, h] = uv;
  if (flip?.x) [u, w] = [u + w, -w];
  if (flip?.y) [v, h] = [v + h, -h];
  return [u, v, w, h];
}

/** The part of the output a sliding frame covers: the frame moved by whole pixels, inside the output. */
export function slideClip(
  offset: readonly [number, number],
  w: number,
  h: number,
): [number, number, number, number] {
  const x0 = Math.max(0, offset[0]);
  const y0 = Math.max(0, offset[1]);
  return [x0, y0, Math.max(0, Math.min(w, w + offset[0]) - x0), Math.max(0, Math.min(h, h + offset[1]) - y0)];
}

/**
 * Where a vignette is computed (docs/design/editing-tools.md#color-adjustments): over the frame for a letterboxed
 * primary picture (output pixels less the frame's origin), over the picture's own pixels otherwise.
 */
export interface GpuVignette {
  angle: number;
  space: 'frame' | 'picture';
  width: number;
  height: number;
  origin: [number, number];
}

export function vignetteOf(
  effects: Effects | undefined,
  at: { picture: [number, number] } | { frame: [number, number]; origin: [number, number] },
): GpuVignette | null {
  const angle = vignetteAngle(effects);
  if (angle <= 0) return null;
  return 'picture' in at
    ? { angle, space: 'picture', width: at.picture[0], height: at.picture[1], origin: [0, 0] }
    : { angle, space: 'frame', width: at.frame[0], height: at.frame[1], origin: at.origin };
}

/** The picture fitted inside the frame, centred (the canvas path's `drawContain`). */
export function containPlacement(img: { width: number; height: number }, w: number, h: number): Placement {
  const k = Math.min(w / img.width, h / img.height);
  return { cx: w / 2, cy: h / 2, w: img.width * k, h: img.height * k, rotation: 0 };
}

/** A picture drawn by the WebGPU compositor. */
export interface GpuPicture {
  kind: 'picture';
  source: CanvasImageSource & { width: number; height: number };
  uv: UvRect;
  placement: Placement;
  effects?: Effects;
  opacity: number;
  lut?: { cube: CubeLut; intensity: number } | null;
  matte?: {
    source: CanvasImageSource & { width: number; height: number };
    uv: UvRect;
    invert: boolean;
  } | null;
  key?: ChromaKey | null;
  vignette?: GpuVignette | null;
  /** The wipe's progress: the draw shows right of its edge (the canvas path's clip). */
  wipe?: number;
  /** Output pixels the draw is limited to (a sliding frame). */
  clip?: [number, number, number, number];
}

/** A draw of the WebGPU compositor: a picture, or black over the frame (a fade). */
export type GpuDraw =
  | GpuPicture
  | { kind: 'fill'; opacity: number; wipe?: number; clip?: [number, number, number, number] };

/** Floats per draw in the uniform buffer: sixteen vec4s (see gpu.ts's `Layer`). */
export const LAYER_FLOATS = 64;

/** The shader's numbers of a draw, laid out as the WGSL `Layer` struct. */
export function layerUniforms(draw: GpuDraw, out: { width: number; height: number }): Float32Array {
  const u = new Float32Array(LAYER_FLOATS);
  if (draw.kind === 'fill') {
    // a black quad over the whole frame
    u.set([2, 0, -1, 0, 0, -2, 1, 0], 0);
    u.set([0, 0, 1, 1], 8);
    u.set([0, 0, 1, 1], 12);
    u.set([1, 1, 1, draw.opacity], 16);
    u.set([0, 2, 0, 1], 20);
    return u;
  }
  const m = placementToClip(draw.placement, out);
  u.set([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0], 0);
  u.set(draw.uv, 8);
  u.set(draw.matte?.uv ?? [0, 0, 1, 1], 12);
  const e = draw.effects;
  u.set([1 + (e?.brightness ?? 0), e?.contrast ?? 1, e?.saturation ?? 1, draw.opacity], 16);
  const lut = draw.lut;
  u.set(
    [
      lut ? Math.min(1, Math.max(0, lut.intensity)) : 0,
      lut ? lut.cube.size : 2,
      draw.matte ? (draw.matte.invert ? 2 : 1) : 0,
      0,
    ],
    20,
  );
  u.set([...(lut?.cube.domainMin ?? [0, 0, 0]), 0], 24);
  u.set([...(lut?.cube.domainMax ?? [1, 1, 1]), 0], 28);
  // The RGB adjustments in the ffmpeg chain's integer steps: gains, tone, hue, vignette
  // (docs/design/editing-tools.md#color-adjustments)
  const adjust = hasAdjustments(e);
  const gains = channelGains(e) ?? [1, 1, 1];
  const hue = hueMatrix(e?.hue ?? 0) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const vig = draw.vignette;
  const key = draw.key;
  u.set([...gains, adjust ? 1 : 0], 32);
  u.set([e?.shadows ?? 0, e?.highlights ?? 0, vig?.angle ?? 0, vig?.space === 'picture' ? 1 : 0], 36);
  u.set([hue[0]!, hue[1]!, hue[2]!, key ? 1 : 0], 40);
  u.set([hue[3]!, hue[4]!, hue[5]!, key?.similarity ?? 0], 44);
  u.set([hue[6]!, hue[7]!, hue[8]!, key?.blend ?? 0], 48);
  u.set([...(key ? hexRgb(key.color).map((c) => c / 255) : [0, 0, 0]), 0], 52);
  u.set([vig?.width ?? 1, vig?.height ?? 1, vig?.origin[0] ?? 0, vig?.origin[1] ?? 0], 56);
  return u;
}

/**
 * The scissor of a draw: the part right of a wipe's edge (xfade's wipeleft), inside a sliding frame's clip, else the
 * whole output.
 */
export function scissorOf(
  draw: Pick<GpuPicture, 'wipe' | 'clip'>,
  w: number,
  h: number,
): [number, number, number, number] {
  let x0 = 0;
  let y0 = 0;
  let x1 = w;
  let y1 = h;
  if (draw.wipe !== undefined) x0 = Math.min(w, wipeEdge(draw.wipe, w));
  if (draw.clip) {
    x0 = Math.max(x0, draw.clip[0]);
    y0 = Math.max(y0, draw.clip[1]);
    x1 = Math.min(x1, draw.clip[0] + draw.clip[2]);
    y1 = Math.min(y1, draw.clip[1] + draw.clip[3]);
  }
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

/** IEEE half floats (the LUT texture's `rgba16float`), rounded to nearest. */
export function toHalf(value: number): number {
  const f = new Float32Array([value]);
  const x = new Uint32Array(f.buffer)[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    return sign | ((mant + (1 << (shift - 1))) >> shift);
  }
  const half = sign | (exp << 10) | (mant >> 13);
  return mant & 0x1000 ? half + 1 : half;
}

/** A cube's table as `rgba16float` texels, red fastest (the texture's x), then green (y), then blue (z). */
export function lutTexels(cube: CubeLut): Uint16Array {
  const n = cube.size ** 3;
  const out = new Uint16Array(n * 4);
  const one = toHalf(1);
  for (let i = 0; i < n; i++) {
    out[i * 4] = toHalf(cube.table[i * 3]!);
    out[i * 4 + 1] = toHalf(cube.table[i * 3 + 1]!);
    out[i * 4 + 2] = toHalf(cube.table[i * 3 + 2]!);
    out[i * 4 + 3] = one;
  }
  return out;
}

/** The compositor a browser uses: a forced choice, else WebGPU when it has an adapter. */
export type CompositorKind = 'webgpu' | 'canvas';
export function compositorChoice(preference: string | null, hasAdapter: boolean): CompositorKind {
  if (preference === 'canvas') return 'canvas';
  return hasAdapter ? 'webgpu' : 'canvas';
}

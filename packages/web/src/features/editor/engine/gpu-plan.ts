import type { CubeLut, Effects } from '@rideo/shared';

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

/** The picture fitted inside the frame, centred (the canvas path's `drawContain`). */
export function containPlacement(img: { width: number; height: number }, w: number, h: number): Placement {
  const k = Math.min(w / img.width, h / img.height);
  return { cx: w / 2, cy: h / 2, w: img.width * k, h: img.height * k, rotation: 0 };
}

/** A draw of the WebGPU compositor. */
export type GpuDraw =
  | {
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
      /** The share of the frame's width left of the wipe (the canvas path's clip). */
      wipe?: number;
    }
  | { kind: 'fill'; opacity: number; wipe?: number };

/** Floats per draw in the uniform buffer: eight vec4s (see gpu.ts's `Layer`). */
export const LAYER_FLOATS = 32;

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
  return u;
}

/** The scissor of a wiped draw (the canvas path clips to the left part of the frame). */
export function wipeScissor(
  wipe: number | undefined,
  w: number,
  h: number,
): [number, number, number, number] {
  if (wipe === undefined) return [0, 0, w, h];
  return [0, 0, Math.max(0, Math.min(w, Math.round(w * wipe))), h];
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

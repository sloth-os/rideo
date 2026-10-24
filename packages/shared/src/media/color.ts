import type { TransitionType } from '../schemas/analysis';
import type { ChromaKey, Effects } from '../schemas/timeline';

/**
 * The arithmetic of the editing tools' pixels (docs/design/editing-tools.md), written after the ffmpeg filters that
 * render them (FFmpeg 5.1: colorchannelmixer, lutrgb, vignette, colorkey, xfade) so that the canvas compositor and
 * WebGPU draw what the export renders. Pure; tests compare it with the filters.
 */

/** The C library's `lrint`: to the nearest integer, halves to even (colorchannelmixer's tables). */
export function lrint(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const ADJUSTMENTS = ['exposure', 'temperature', 'tint', 'hue', 'shadows', 'highlights', 'vignette'] as const;

/** Whether effects carry any RGB adjustment (exposure, temperature, tint, hue, shadows, highlights, vignette). */
export function hasAdjustments(e: Effects | undefined): boolean {
  return !!e && ADJUSTMENTS.some((k) => (e[k] ?? 0) !== 0);
}

/**
 * Coefficients are kept to nine decimals: the graph prints them exactly and ffmpeg parses back the same doubles, so
 * the canvas computes with the numbers the filters use.
 */
const q9 = (v: number) => Math.round(v * 1e9) / 1e9;

/** Exposure, temperature and tint as gains of red, green and blue; null when they change nothing. */
export function channelGains(e: Effects | undefined): [number, number, number] | null {
  const k = 2 ** (e?.exposure ?? 0);
  const t = e?.temperature ?? 0;
  const u = e?.tint ?? 0;
  const g: [number, number, number] = [
    q9(k * (1 + 0.3 * t) * (1 + 0.1 * u)),
    q9(k * (1 - 0.2 * u)),
    q9(k * (1 - 0.3 * t) * (1 + 0.1 * u)),
  ];
  return g.every((v) => v === 1) ? null : g;
}

/** A channel's gain table as lutrgb computes `val*g`: truncated, clipped to 0–255. */
export function gainTable(g: number): Uint8Array {
  const out = new Uint8Array(256);
  for (let v = 0; v < 256; v++) out[v] = Math.min(255, Math.max(0, Math.trunc(v * g)));
  return out;
}

/** The CSS `hue-rotate()` matrix (Filter Effects 1), rows of output r, g, b; null at 0°. */
export function hueMatrix(degrees: number): number[] | null {
  if (degrees === 0) return null;
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + 0.787 * c - 0.213 * s,
    0.715 - 0.715 * c - 0.715 * s,
    0.072 - 0.072 * c + 0.928 * s,
    0.213 - 0.213 * c + 0.143 * s,
    0.715 + 0.285 * c + 0.14 * s,
    0.072 - 0.072 * c - 0.283 * s,
    0.213 - 0.213 * c - 0.787 * s,
    0.715 - 0.715 * c + 0.715 * s,
    0.072 + 0.928 * c + 0.072 * s,
  ].map(q9);
}

/** The tone curve of shadows and highlights at a value 0–255, before truncation (the lutrgb expression's order). */
function tone(v: number, s: number, h: number): number {
  return v + 0.6 * v * (1 - v / 255) * (s * (1 - v / 255) + (h * v) / 255);
}

/** The tone table (lutrgb: the curve truncated and clipped), or null when flat. */
export function toneTable(e: Effects | undefined): Uint8Array | null {
  const s = e?.shadows ?? 0;
  const h = e?.highlights ?? 0;
  if (s === 0 && h === 0) return null;
  const out = new Uint8Array(256);
  for (let v = 0; v < 256; v++) out[v] = Math.min(255, Math.max(0, Math.trunc(tone(v, s, h))));
  return out;
}

/** The lutrgb expression of the tone curve (the same formula as `toneTable`; numbers at full precision). */
export function toneExpression(e: Effects): string {
  return `val+0.6*val*(1-val/255)*(${e.shadows ?? 0}*(1-val/255)+${e.highlights ?? 0}*val/255)`;
}

/** The vignette's lens angle (0: none). */
export function vignetteAngle(e: Effects | undefined): number {
  return q9(((e?.vignette ?? 0) * Math.PI) / 2);
}

/**
 * The adjustments as ffmpeg filters on `rgb24`, in their order (docs/design/editing-tools.md#color-adjustments): the
 * gains, the tone curve, the hue (colorchannelmixer takes gains up to 2 only, so the gains are a table) and the
 * vignette.
 */
export function adjustmentFilters(e: Effects | undefined): string[] {
  const out: string[] = [];
  const g = channelGains(e);
  if (g) out.push(`lutrgb=r='val*${g[0]}':g='val*${g[1]}':b='val*${g[2]}'`);
  if (e && toneTable(e)) {
    const x = toneExpression(e);
    out.push(`lutrgb=r='${x}':g='${x}':b='${x}'`);
  }
  const m = hueMatrix(e?.hue ?? 0);
  if (m) {
    const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
    out.push(`colorchannelmixer=${names.map((k, i) => `${k}=${m[i]}`).join(':')}`);
  }
  const a = vignetteAngle(e);
  if (a > 0) out.push(`vignette=angle=${a}:dither=0`);
  return out;
}

/**
 * ffmpeg `vignette`'s factor at pixel (x, y) of a w × h picture (centre, natural mode). The filter clips the angle as
 * a C float and keeps the factors as floats.
 */
export function vignetteFactor(x: number, y: number, w: number, h: number, angle: number): number {
  const xx = Math.trunc(x - w / 2);
  const yy = Math.trunc(y - h / 2);
  const d = Math.hypot(xx, yy) / Math.hypot(w / 2, h / 2);
  if (d > 1) return 0;
  const c = Math.cos(Math.fround(Math.min(Math.PI / 2, Math.max(0, angle))) * d);
  return Math.fround(c * c * (c * c));
}

/** A key color as 0–255 channels. */
export function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** ffmpeg `colorkey`'s alpha of a pixel (it replaces the pixel's alpha). */
export function keyAlpha(r: number, g: number, b: number, key: ChromaKey): number {
  const [kr, kg, kb] = hexRgb(key.color);
  const dr = r - kr;
  const dg = g - kg;
  const db = b - kb;
  const diff = Math.sqrt((dr * dr + dg * dg + db * db) / (255 * 255 * 3));
  const similarity = Math.fround(key.similarity);
  const iblend = Math.fround(1 / Math.fround(key.blend));
  if (iblend < 10000) return Math.trunc(Math.min(1, Math.max(0, (diff - similarity) * iblend)) * 255);
  return diff > similarity ? 255 : 0;
}

/** The ffmpeg `colorkey` color option. */
export function keyColorOption(key: ChromaKey): string {
  return `0x${key.color.slice(1).toUpperCase()}`;
}

const factorMaps = new Map<string, Float32Array>();

/** Vignette factors of a whole w × h space, kept for the last two (a 4K map is 33 MB). */
function factorMap(w: number, h: number, angle: number): Float32Array {
  const id = `${w}x${h}@${angle}`;
  let map = factorMaps.get(id);
  if (!map) {
    map = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) map[y * w + x] = vignetteFactor(x, y, w, h, angle);
    if (factorMaps.size >= 2) factorMaps.delete(factorMaps.keys().next().value as string);
    factorMaps.set(id, map);
  }
  return map;
}

/**
 * Where a picture sits in the space its vignette is computed over: the frame for a letterboxed primary picture (its
 * bars included, as ffmpeg sees it), the picture itself otherwise.
 */
export interface VignetteSpace {
  /** The picture's top-left corner in the space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Applies the RGB adjustments to RGBA pixels of a w × h picture in place, in the ffmpeg chain's order: the gain
 * tables, the tone table (lutrgb: truncated), the hue (colorchannelmixer: rounded products, summed, clipped), the
 * vignette (truncated).
 */
export function applyAdjustments(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  e: Effects,
  space: VignetteSpace = { x: 0, y: 0, width: w, height: h },
): void {
  const g = channelGains(e);
  const gains = g ? g.map(gainTable) : null;
  const t = toneTable(e);
  const m = hueMatrix(e.hue ?? 0);
  const angle = vignetteAngle(e);
  let mix: Int32Array | null = null;
  if (m) {
    // mix[(out·3 + in)·256 + v] = lrint(v·M[out][in]), as colorchannelmixer builds its tables
    mix = new Int32Array(9 * 256);
    for (let i = 0; i < 9; i++) for (let v = 0; v < 256; v++) mix[i * 256 + v] = lrint(v * m[i]!);
  }
  const fmap = angle > 0 ? factorMap(space.width, space.height, angle) : null;
  for (let y = 0; y < h; y++) {
    const sy = y + space.y;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = px[i]!;
      let gg = px[i + 1]!;
      let b = px[i + 2]!;
      if (gains) {
        r = gains[0]![r]!;
        gg = gains[1]![gg]!;
        b = gains[2]![b]!;
      }
      if (t) {
        r = t[r]!;
        gg = t[gg]!;
        b = t[b]!;
      }
      if (mix) {
        const rr = mix[r]! + mix[256 + gg]! + mix[512 + b]!;
        const go = mix[768 + r]! + mix[1024 + gg]! + mix[1280 + b]!;
        const bb = mix[1536 + r]! + mix[1792 + gg]! + mix[2048 + b]!;
        r = rr < 0 ? 0 : rr > 255 ? 255 : rr;
        gg = go < 0 ? 0 : go > 255 ? 255 : go;
        b = bb < 0 ? 0 : bb > 255 ? 255 : bb;
      }
      if (fmap) {
        const sx = x + space.x;
        const f =
          sx >= 0 && sy >= 0 && sx < space.width && sy < space.height ? fmap[sy * space.width + sx]! : 0;
        r = Math.trunc(Math.fround(r * f));
        gg = Math.trunc(Math.fround(gg * f));
        b = Math.trunc(Math.fround(b * f));
      }
      px[i] = r;
      px[i + 1] = gg;
      px[i + 2] = b;
    }
  }
}

/** Applies a chroma key to RGBA pixels in place (the key's alpha replaces the pixel's, as colorkey does). */
export function applyKey(px: Uint8ClampedArray, key: ChromaKey): void {
  for (let i = 0; i < px.length; i += 4) px[i + 3] = keyAlpha(px[i]!, px[i + 1]!, px[i + 2]!, key);
}

/**
 * The weights of a dip (xfade `fadeblack` / `fadewhite`) at progress q (0 → 1): the outgoing frame's and the incoming
 * frame's; the color takes the rest.
 */
export function dipWeights(q: number): { out: number; in: number } {
  const g = 1 - q;
  return { out: g * smoothstep(0.8, 1, g), in: q * (1 - smoothstep(0.2, 1, g)) };
}

/** xfade `circleopen`: the incoming frame's weight at pixel (x, y) of a w × h frame at progress q. */
export function circleWeight(x: number, y: number, w: number, h: number, q: number): number {
  const cx = Math.trunc(w / 2);
  const cy = Math.trunc(h / 2);
  const z = Math.hypot(cx, cy);
  const p = (1 - q - 0.5) * 3;
  return 1 - smoothstep(0, 1, Math.hypot(x - cx, y - cy) / z + p);
}

/**
 * The circle as a radial gradient (the canvas): its centre (xfade's whole-pixel centre, at the pixel's middle), its
 * radius (the frame's corner) and the incoming frame's weight at 16 evenly spaced radii, close enough to the smooth
 * edge to stay within a level of it.
 */
export function circleStops(
  w: number,
  h: number,
  q: number,
): { cx: number; cy: number; radius: number; stops: { offset: number; weight: number }[] } {
  const cx = Math.trunc(w / 2);
  const cy = Math.trunc(h / 2);
  const radius = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  const stops = Array.from({ length: 16 }, (_, k) => {
    const offset = k / 15;
    return { offset, weight: circleWeight(cx + offset * radius, cy, w, h, q) };
  });
  return { cx: cx + 0.5, cy: cy + 0.5, radius, stops };
}

/** xfade `wipeleft` at progress q: the first column of the incoming frame, which shows right of the moving edge. */
export function wipeEdge(q: number, w: number): number {
  return Math.trunc(Math.fround(w * Math.fround(1 - q))) + 1;
}

export type SlideType = Extract<TransitionType, 'slide_left' | 'slide_right' | 'slide_up' | 'slide_down'>;
export const SLIDE_TYPES: readonly SlideType[] = ['slide_left', 'slide_right', 'slide_up', 'slide_down'];

/** xfade's slides at progress q: where the outgoing and the incoming frames are drawn, whole pixels. */
export function slideOffsets(
  type: SlideType,
  q: number,
  w: number,
  h: number,
): { out: [number, number]; in: [number, number] } {
  const g = Math.fround(1 - q);
  if (type === 'slide_left' || type === 'slide_right') {
    const p = Math.trunc(Math.fround(g * w));
    return type === 'slide_left' ? { in: [p, 0], out: [p - w, 0] } : { in: [-p, 0], out: [w - p, 0] };
  }
  const p = Math.trunc(Math.fround(g * h));
  return type === 'slide_up' ? { in: [0, p], out: [0, p - h] } : { in: [0, -p], out: [0, h - p] };
}

/** The xfade transition of each transition type. */
export const XFADE_TRANSITIONS: Record<TransitionType, string> = {
  crossfade: 'fade',
  wipe: 'wipeleft',
  dip_to_black: 'fadeblack',
  dip_to_white: 'fadewhite',
  slide_left: 'slideleft',
  slide_right: 'slideright',
  slide_up: 'slideup',
  slide_down: 'slidedown',
  circle_open: 'circleopen',
};

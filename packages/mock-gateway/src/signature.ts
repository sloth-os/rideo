import type { Rgba } from './png';

/**
 * Deterministic consistency model (docs/design/ai-gateway.md#mock-gateway): each character name maps to a
 * saturated "signature colour". Mock references paint it, mock generations copy the signatures of the
 * reference images they receive, and the mock judge looks for them in candidate frames.
 */
export type Rgb = [number, number, number];

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function signatureColor(name: string): Rgb {
  return hslToRgb(fnv1a(name.trim().toLowerCase()) % 360, 0.85, 0.5);
}

export function saturation([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** Average of strongly saturated pixels — the signature of a mock reference image, or null. */
export function dominantSignature(img: Rgba): Rgb | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const hueBuckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i < img.data.length; i += 4) {
    const px: Rgb = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    if (saturation(px) < 0.55 || Math.max(...px) < 60) continue;
    const key = Math.round(Math.atan2(Math.sqrt(3) * (px[1] - px[2]), 2 * px[0] - px[1] - px[2]) * 6);
    const bucket = hueBuckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += px[0];
    bucket.g += px[1];
    bucket.b += px[2];
    bucket.n++;
    hueBuckets.set(key, bucket);
  }
  for (const bucket of hueBuckets.values()) {
    if (bucket.n > n) {
      r = bucket.r;
      g = bucket.g;
      b = bucket.b;
      n = bucket.n;
    }
  }
  if (n < 20) return null;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Every distinct signature colour in an image (used when a cast sheet carries several characters). */
export function signaturesIn(img: Rgba, known: Rgb[], tolerance = 60): Rgb[] {
  return known.filter((sig) => presenceRatio(img, sig, tolerance) > 0.002);
}

export function presenceRatio(img: Rgba, sig: Rgb, tolerance = 60): number {
  let hits = 0;
  const total = img.width * img.height;
  const step = total > 400_000 ? 2 : 1;
  for (let i = 0; i < img.data.length; i += 4 * step) {
    const px: Rgb = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    if (colorDistance(px, sig) <= tolerance) hits++;
  }
  return (hits * step) / total;
}

/** All saturated colour clusters with enough pixels (a cast sheet carries several). Largest first. */
export function allSignatures(img: Rgba, minRatio = 0.003): Rgb[] {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i < img.data.length; i += 4) {
    const px: Rgb = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    if (saturation(px) < 0.55 || Math.max(...px) < 60) continue;
    const hue = Math.atan2(Math.sqrt(3) * (px[1] - px[2]), 2 * px[0] - px[1] - px[2]);
    const key = Math.round(((hue + Math.PI) / (2 * Math.PI)) * 36);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += px[0];
    bucket.g += px[1];
    bucket.b += px[2];
    bucket.n++;
    buckets.set(key, bucket);
  }
  const total = img.width * img.height;
  const clusters = [...buckets.values()]
    .filter((b) => b.n / total >= minRatio)
    .sort((a, b) => b.n - a.n)
    .map((b) => [Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)] as Rgb);
  const merged: Rgb[] = [];
  for (const c of clusters) if (!merged.some((m) => colorDistance(m, c) < 40)) merged.push(c);
  return merged;
}

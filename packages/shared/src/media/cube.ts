/**
 * 3D LUTs in the `.cube` format (Resolve/Adobe; docs/design/editor.md#luts): parsing and the trilinear lookup the
 * WebCodecs compositor applies (ffmpeg's `lut3d` does the same with `interp=trilinear`).
 */

export interface CubeLut {
  title: string | null;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** `size³` RGB triples, red changing fastest. */
  table: Float32Array;
}

export class CubeError extends Error {}

/** Parses a `.cube` file; throws a CubeError naming the problem. */
export function parseCube(text: string): CubeLut {
  let title: string | null = null;
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const rows: number[] = [];
  const lines = text.split(/\r?\n/);
  for (const [n, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0]!.toUpperCase();
    const triple = (): [number, number, number] => {
      const v = parts.slice(1, 4).map(Number);
      if (v.length !== 3 || v.some((x) => !Number.isFinite(x)))
        throw new CubeError(`line ${n + 1}: ${key} needs three numbers`);
      return v as [number, number, number];
    };
    if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '').slice(0, 200);
    else if (key === 'LUT_3D_SIZE') {
      size = Number(parts[1]);
      if (!Number.isInteger(size) || size < 2 || size > 65) throw new CubeError('LUT_3D_SIZE must be 2–65');
    } else if (key === 'LUT_1D_SIZE') throw new CubeError('1D LUTs are not supported; export a 3D LUT');
    else if (key === 'DOMAIN_MIN') domainMin = triple();
    else if (key === 'DOMAIN_MAX') domainMax = triple();
    else if (key === 'LUT_3D_INPUT_RANGE') {
      const [lo, hi] = parts.slice(1, 3).map(Number);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new CubeError(`line ${n + 1}: bad input range`);
      domainMin = [lo!, lo!, lo!];
      domainMax = [hi!, hi!, hi!];
    } else if (/^[-+.\d]/.test(key)) {
      const v = parts.slice(0, 3).map(Number);
      if (parts.length < 3 || v.some((x) => !Number.isFinite(x)))
        throw new CubeError(`line ${n + 1}: not an RGB row`);
      rows.push(v[0]!, v[1]!, v[2]!);
    }
    // other keywords (comments of other tools) are ignored
  }
  if (!size) throw new CubeError('missing LUT_3D_SIZE');
  if (rows.length !== size ** 3 * 3)
    throw new CubeError(`expected ${size ** 3} rows, found ${rows.length / 3}`);
  if (domainMin.some((v, i) => v >= domainMax[i]!))
    throw new CubeError('DOMAIN_MIN must be below DOMAIN_MAX');
  return { title, size, domainMin, domainMax, table: Float32Array.from(rows) };
}

/** Applies a LUT to RGBA pixels in place (trilinear), mixed with the original by `intensity`. */
export function applyCube(lut: CubeLut, pixels: Uint8ClampedArray, intensity = 1): void {
  const { size: N, table, domainMin, domainMax } = lut;
  const max = N - 1;
  const scale = [0, 1, 2].map((c) => max / (255 * (domainMax[c]! - domainMin[c]!)));
  const offset = [0, 1, 2].map((c) => (domainMin[c]! * max) / (domainMax[c]! - domainMin[c]!));
  const k = Math.min(1, Math.max(0, intensity));
  const N2 = N * N;
  for (let p = 0; p < pixels.length; p += 4) {
    const r = Math.min(max, Math.max(0, pixels[p]! * scale[0]! - offset[0]!));
    const g = Math.min(max, Math.max(0, pixels[p + 1]! * scale[1]! - offset[1]!));
    const b = Math.min(max, Math.max(0, pixels[p + 2]! * scale[2]! - offset[2]!));
    const r0 = Math.min(max - 1, Math.floor(r));
    const g0 = Math.min(max - 1, Math.floor(g));
    const b0 = Math.min(max - 1, Math.floor(b));
    const fr = r - r0;
    const fg = g - g0;
    const fb = b - b0;
    const base = (r0 + g0 * N + b0 * N2) * 3;
    for (let c = 0; c < 3; c++) {
      const at = (dr: number, dg: number, db: number) => table[base + (dr + dg * N + db * N2) * 3 + c]!;
      const c00 = at(0, 0, 0) * (1 - fr) + at(1, 0, 0) * fr;
      const c10 = at(0, 1, 0) * (1 - fr) + at(1, 1, 0) * fr;
      const c01 = at(0, 0, 1) * (1 - fr) + at(1, 0, 1) * fr;
      const c11 = at(0, 1, 1) * (1 - fr) + at(1, 1, 1) * fr;
      const v = (c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb;
      pixels[p + c] = pixels[p + c]! * (1 - k) + v * 255 * k;
    }
  }
}

/** An identity LUT of a size (tests and the inspector's "none" preview). */
export function identityCube(size = 2): string {
  const rows: string[] = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) rows.push([r, g, b].map((v) => (v / (size - 1)).toFixed(6)).join(' '));
  return `${rows.join('\n')}\n`;
}

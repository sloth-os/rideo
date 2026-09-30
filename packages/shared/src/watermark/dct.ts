/** Orthonormal 8×8 DCT-II basis images φ(u,v), row-major (index = y*8 + x); u = horizontal frequency. */
const cache = new Map<string, Float64Array>();

export function dctBasis(u: number, v: number): Float64Array {
  const key = `${u},${v}`;
  let b = cache.get(key);
  if (b) return b;
  b = new Float64Array(64);
  const au = u === 0 ? Math.SQRT1_2 / 2 : 0.5;
  const av = v === 0 ? Math.SQRT1_2 / 2 : 0.5;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      b[y * 8 + x] =
        au * av * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
    }
  }
  cache.set(key, b);
  return b;
}

/** Full forward DCT of a block (tests / diagnostics; the embedder only projects onto two bases). */
export function forwardDct(block: ArrayLike<number>): Float64Array {
  const out = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      const phi = dctBasis(u, v);
      let s = 0;
      for (let i = 0; i < 64; i++) s += block[i]! * phi[i]!;
      out[v * 8 + u] = s;
    }
  }
  return out;
}

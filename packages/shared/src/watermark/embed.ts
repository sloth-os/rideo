import { dctBasis } from './dct';
import type { WatermarkLayout } from './layout';
import { PAYLOAD_BITS } from './payload';

export interface WatermarkParams {
  /** Base embedding margin T (orthonormal DCT units). */
  strength: number;
  /** The two coefficients (u, v) whose magnitude difference carries the symbol. */
  pair: [[number, number], [number, number]];
  /** Perceptual masking: T_blk = T · clamp(σ / maskRef, maskMin, maskMax). */
  maskRef: number;
  maskMin: number;
  maskMax: number;
  /** Per-coefficient change cap when embedding, in multiples of T_blk. */
  capFactor: number;
  /** Extraction soft-vote clamp, in multiples of T (limits host interference from strong edges). */
  softClamp: number;
}

export const DEFAULT_WATERMARK_PARAMS: WatermarkParams = {
  strength: 16,
  pair: [
    [2, 1],
    [1, 2],
  ],
  maskRef: 12,
  maskMin: 0.5,
  maskMax: 2,
  capFactor: 3,
  softClamp: 1.5,
};

export interface EmbedStats {
  blocks: number;
  modified: number;
  /** Sum of squared pixel changes (for PSNR). */
  sse: number;
}

/**
 * Embeds the 64 payload bits into one luma plane in place. `stride` is the row pitch in bytes.
 * Only two DCT coefficients per block change; the update is applied directly with their basis images.
 */
export function embedLuma(
  y: Uint8Array | Uint8ClampedArray,
  stride: number,
  layout: WatermarkLayout,
  bits: Uint8Array,
  params: WatermarkParams = DEFAULT_WATERMARK_PARAMS,
): EmbedStats {
  if (bits.length !== PAYLOAD_BITS) throw new Error('payload must have 64 bits');
  const phiA = dctBasis(params.pair[0][0], params.pair[0][1]);
  const phiB = dctBasis(params.pair[1][0], params.pair[1][1]);
  const block = new Float64Array(64);
  let modified = 0;
  let sse = 0;
  for (let j = 0; j < layout.count; j++) {
    const b = layout.blockIndex[j]!;
    const x0 = (b % layout.blocksX) * 8;
    const y0 = Math.floor(b / layout.blocksX) * 8;
    let sum = 0;
    let sum2 = 0;
    let A = 0;
    let B = 0;
    for (let r = 0; r < 8; r++) {
      const row = (y0 + r) * stride + x0;
      for (let c = 0; c < 8; c++) {
        const v = y[row + c]!;
        const k = r * 8 + c;
        block[k] = v;
        sum += v;
        sum2 += v * v;
        A += v * phiA[k]!;
        B += v * phiB[k]!;
      }
    }
    const mean = sum / 64;
    const sigma = Math.sqrt(Math.max(0, sum2 / 64 - mean * mean));
    const T = params.strength * Math.min(params.maskMax, Math.max(params.maskMin, sigma / params.maskRef));
    const sym = bits[j % PAYLOAD_BITS]! ^ (layout.chips[j]! < 0 ? 1 : 0);
    const absA = Math.abs(A);
    const absB = Math.abs(B);
    const d = absA - absB;
    let nA = absA;
    let nB = absB;
    if (sym === 1 && d < T) {
      const g = T - d;
      nA = absA + g / 2;
      nB = absB - g / 2;
      if (nB < 0) {
        nA -= nB;
        nB = 0;
      }
    } else if (sym === 0 && d > -T) {
      const g = T + d;
      nA = absA - g / 2;
      nB = absB + g / 2;
      if (nA < 0) {
        nB -= nA;
        nA = 0;
      }
    } else {
      continue;
    }
    const cap = params.capFactor * T;
    const dA = Math.max(-cap, Math.min(cap, nA - absA)) * (A >= 0 ? 1 : -1);
    const dB = Math.max(-cap, Math.min(cap, nB - absB)) * (B >= 0 ? 1 : -1);
    for (let r = 0; r < 8; r++) {
      const row = (y0 + r) * stride + x0;
      for (let c = 0; c < 8; c++) {
        const k = r * 8 + c;
        const old = block[k]!;
        const nv = Math.round(old + dA * phiA[k]! + dB * phiB[k]!);
        const clamped = nv < 0 ? 0 : nv > 255 ? 255 : nv;
        y[row + c] = clamped;
        sse += (clamped - old) * (clamped - old);
      }
    }
    modified++;
  }
  return { blocks: layout.count, modified, sse };
}

export function psnr(sse: number, pixels: number): number {
  if (sse <= 0) return Number.POSITIVE_INFINITY;
  return 10 * Math.log10((255 * 255) / (sse / pixels));
}

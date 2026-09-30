import { dctBasis } from './dct';
import { DEFAULT_WATERMARK_PARAMS, type WatermarkParams } from './embed';
import type { WatermarkLayout } from './layout';
import { decodePayload, PAYLOAD_BITS } from './payload';

export const DETECTION_MIN_MEAN_MARGIN = 2.5;

export interface ExtractionResult {
  frames: number;
  bits: Uint8Array;
  margins: Float64Array;
  meanMargin: number;
  id: string;
  payloadHex: string;
  crcOk: boolean;
  detected: boolean;
  confidence: number;
}

/** Accumulates soft votes over frames; call result() once enough frames were added. */
export class WatermarkAccumulator {
  private readonly sums = new Float64Array(PAYLOAD_BITS);
  private readonly sumsSq = new Float64Array(PAYLOAD_BITS);
  private readonly phiA: Float64Array;
  private readonly phiB: Float64Array;
  frames = 0;

  constructor(
    private readonly layout: WatermarkLayout,
    private readonly params: WatermarkParams = DEFAULT_WATERMARK_PARAMS,
  ) {
    this.phiA = dctBasis(params.pair[0][0], params.pair[0][1]);
    this.phiB = dctBasis(params.pair[1][0], params.pair[1][1]);
  }

  addFrame(y: Uint8Array | Uint8ClampedArray, stride: number): void {
    const { layout } = this;
    const limit = this.params.capFactor * this.params.strength;
    for (let j = 0; j < layout.count; j++) {
      const b = layout.blockIndex[j]!;
      const x0 = (b % layout.blocksX) * 8;
      const y0 = Math.floor(b / layout.blocksX) * 8;
      let A = 0;
      let B = 0;
      for (let r = 0; r < 8; r++) {
        const row = (y0 + r) * stride + x0;
        for (let c = 0; c < 8; c++) {
          const v = y[row + c]!;
          const k = r * 8 + c;
          A += v * this.phiA[k]!;
          B += v * this.phiB[k]!;
        }
      }
      const d = Math.abs(A) - Math.abs(B);
      const soft = layout.chips[j]! * Math.max(-limit, Math.min(limit, d));
      const bit = j % PAYLOAD_BITS;
      this.sums[bit] = this.sums[bit]! + soft;
      this.sumsSq[bit] = this.sumsSq[bit]! + soft * soft;
    }
    this.frames++;
  }

  result(): ExtractionResult {
    const bits = new Uint8Array(PAYLOAD_BITS);
    const margins = new Float64Array(PAYLOAD_BITS);
    let total = 0;
    for (let k = 0; k < PAYLOAD_BITS; k++) {
      bits[k] = this.sums[k]! > 0 ? 1 : 0;
      const denom = Math.sqrt(this.sumsSq[k]!);
      margins[k] = denom > 0 ? Math.abs(this.sums[k]!) / denom : 0;
      total += margins[k]!;
    }
    const meanMargin = total / PAYLOAD_BITS;
    const decoded = decodePayload(bits);
    const detected = this.frames > 0 && decoded.crcOk && meanMargin >= DETECTION_MIN_MEAN_MARGIN;
    return {
      frames: this.frames,
      bits,
      margins,
      meanMargin,
      ...decoded,
      detected,
      confidence: detected ? Math.min(1, meanMargin / 6) : 0,
    };
  }
}

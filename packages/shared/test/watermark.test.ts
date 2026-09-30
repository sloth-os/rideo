import { describe, expect, it } from 'vitest';
import {
  crc16,
  createLayout,
  DEFAULT_WATERMARK_PARAMS,
  dctBasis,
  decodePayload,
  embedLuma,
  encodePayload,
  forwardDct,
  psnr,
  WatermarkAccumulator,
  watermarkIdFromBytes,
  Xoshiro128,
} from '../src';

const SEED = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
const OTHER_SEED = Uint8Array.from({ length: 16 }, (_, i) => (i * 91 + 3) & 0xff);

/** Textured synthetic luma frame: gradients + deterministic noise (a stand-in for natural video). */
function frame(width: number, height: number, t = 0): Uint8Array {
  const rng = new Xoshiro128(Uint8Array.from({ length: 16 }, (_, i) => (i + 1 + t) & 0xff));
  const y = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const base = 60 + 80 * Math.sin((c + t * 2) / 23) * Math.cos(r / 17) + (c / width) * 60;
      y[r * width + c] = Math.max(0, Math.min(255, Math.round(base + ((rng.nextU32() % 21) - 10))));
    }
  }
  return y;
}

function degrade(y: Uint8Array, noise: number, seed: number): Uint8Array {
  const rng = new Xoshiro128(Uint8Array.from({ length: 16 }, (_, i) => (i * 13 + seed) & 0xff));
  return y.map((v) => {
    const n = ((rng.nextU32() % 2001) / 1000 - 1) * noise;
    return Math.max(0, Math.min(255, Math.round(v + n)));
  });
}

describe('watermark primitives', () => {
  it('computes CRC-16/CCITT-FALSE', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1);
  });

  it('round-trips the payload and detects corruption', () => {
    const id = watermarkIdFromBytes(Uint8Array.from([0x3f, 0x2a, 0x9c, 0x01, 0xbe, 0x77]));
    const bits = encodePayload(id);
    expect(decodePayload(bits)).toMatchObject({ id, crcOk: true });
    bits[5] = bits[5]! ^ 1;
    expect(decodePayload(bits).crcOk).toBe(false);
  });

  it('uses an orthonormal DCT basis', () => {
    const a = dctBasis(2, 1);
    const b = dctBasis(1, 2);
    const dot = (x: Float64Array, z: Float64Array) => x.reduce((s, v, i) => s + v * z[i]!, 0);
    expect(dot(a, a)).toBeCloseTo(1, 10);
    expect(dot(a, b)).toBeCloseTo(0, 10);
    const block = Array.from({ length: 64 }, (_, i) => (i * 7) % 255);
    const coeffs = forwardDct(block);
    const energy = block.reduce((s, v) => s + v * v, 0);
    expect(coeffs.reduce((s, v) => s + v * v, 0)).toBeCloseTo(energy, 6);
  });

  it('derives the same layout from the same seed and a different one otherwise', () => {
    const a = createLayout(SEED, 320, 180);
    const b = createLayout(SEED, 320, 180);
    const c = createLayout(OTHER_SEED, 320, 180);
    expect(a.count % 64).toBe(0);
    expect([...a.blockIndex.slice(0, 32)]).toEqual([...b.blockIndex.slice(0, 32)]);
    expect([...a.blockIndex.slice(0, 32)]).not.toEqual([...c.blockIndex.slice(0, 32)]);
    expect(() => createLayout(SEED, 32, 32)).toThrow(/too small/);
  });
});

describe('embed / extract', () => {
  const W = 320;
  const H = 180;
  const id = 'wm_0123456789ab';

  it('is invisible (PSNR >= 45 dB) and recoverable from a single frame', () => {
    const layout = createLayout(SEED, W, H);
    const y = frame(W, H);
    const stats = embedLuma(y, W, layout, encodePayload(id));
    expect(psnr(stats.sse, W * H)).toBeGreaterThan(45);
    const acc = new WatermarkAccumulator(layout);
    acc.addFrame(y, W);
    const r = acc.result();
    expect(r.detected).toBe(true);
    expect(r.id).toBe(id);
    // margin = |Σ soft| / sqrt(Σ soft²) ≈ sqrt(blocks per bit) = sqrt(13) at 320x180 for one clean frame
    expect(r.meanMargin).toBeGreaterThan(3);
  });

  it('survives noise across frames and rejects unmarked or wrongly keyed content', () => {
    const layout = createLayout(SEED, W, H);
    const acc = new WatermarkAccumulator(layout);
    const clean = new WatermarkAccumulator(layout);
    const wrongKey = new WatermarkAccumulator(createLayout(OTHER_SEED, W, H));
    for (let t = 0; t < 6; t++) {
      const original = frame(W, H, t);
      clean.addFrame(original, W);
      const marked = original.slice();
      embedLuma(marked, W, layout, encodePayload(id));
      const noisy = degrade(marked, 6, t);
      acc.addFrame(noisy, W);
      wrongKey.addFrame(noisy, W);
    }
    expect(acc.result()).toMatchObject({ detected: true, id });
    expect(clean.result().detected).toBe(false);
    expect(clean.result().meanMargin).toBeLessThan(2.5);
    expect(wrongKey.result().detected).toBe(false);
  });

  it('honours a custom stride', () => {
    const layout = createLayout(SEED, W, H);
    const stride = W + 16;
    const padded = new Uint8Array(stride * H);
    const y = frame(W, H);
    for (let r = 0; r < H; r++) padded.set(y.subarray(r * W, (r + 1) * W), r * stride);
    embedLuma(padded, stride, layout, encodePayload(id), { ...DEFAULT_WATERMARK_PARAMS, strength: 8 });
    const acc = new WatermarkAccumulator(layout, { ...DEFAULT_WATERMARK_PARAMS, strength: 8 });
    acc.addFrame(padded, stride);
    expect(acc.result().id).toBe(id);
  });
});

describe('list decoding', () => {
  it('recovers ids with a few unreliable bit errors', async () => {
    const { listDecode } = await import('../src');
    const id = 'wm_a1b2c3d4e5f6';
    const bits = encodePayload(id);
    const margins = new Float64Array(64).fill(8);
    for (const i of [3, 17, 40]) {
      bits[i] = bits[i]! ^ 1;
      margins[i] = 0.2 + i / 100;
    }
    expect(decodePayload(bits).crcOk).toBe(false);
    const candidates = listDecode(bits, margins, { maxFlips: 3, pool: 12 });
    expect(candidates[0]).toMatchObject({ id, flips: 3 });
    expect(listDecode(bits, margins, { maxFlips: 2, pool: 12 }).some((c) => c.id === id)).toBe(false);
  });
});

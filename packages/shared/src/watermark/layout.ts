import { PAYLOAD_BITS } from './payload';
import { Xoshiro128 } from './prng';

/** Keyed block layout for one frame size: which block carries which payload bit, whitened by a chip. */
export interface WatermarkLayout {
  width: number;
  height: number;
  blocksX: number;
  blocksY: number;
  /** Number of positions used (a multiple of 64, so every bit gets the same number of blocks). */
  count: number;
  blockIndex: Uint32Array;
  chips: Int8Array;
}

/** Message the server HMACs with the secret key to derive the 16-byte layout seed. */
export function layoutSeedMessage(width: number, height: number): string {
  return `rideo-wm-v1:${width}x${height}`;
}

export function createLayout(seed: Uint8Array, width: number, height: number): WatermarkLayout {
  const blocksX = Math.floor(width / 8);
  const blocksY = Math.floor(height / 8);
  const total = blocksX * blocksY;
  if (total < PAYLOAD_BITS) throw new Error(`frame ${width}x${height} is too small for a watermark`);
  const rng = new Xoshiro128(seed);
  const perm = new Uint32Array(total);
  for (let i = 0; i < total; i++) perm[i] = i;
  for (let i = total - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  const count = total - (total % PAYLOAD_BITS);
  const chips = new Int8Array(count);
  for (let i = 0; i < count; i++) chips[i] = rng.nextU32() & 1 ? 1 : -1;
  return { width, height, blocksX, blocksY, count, blockIndex: perm.subarray(0, count), chips };
}

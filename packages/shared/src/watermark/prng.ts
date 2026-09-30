/** xoshiro128** — small, fast, well-distributed PRNG with a 128-bit state seeded from 16 bytes. */
function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Xoshiro128 {
  private readonly s = new Uint32Array(4);

  constructor(seed: Uint8Array) {
    if (seed.length < 16) throw new Error('xoshiro128 needs a 16-byte seed');
    const view = new DataView(seed.buffer, seed.byteOffset, 16);
    for (let i = 0; i < 4; i++) this.s[i] = view.getUint32(i * 4, true);
    if (this.s[0] === 0 && this.s[1] === 0 && this.s[2] === 0 && this.s[3] === 0) this.s[0] = 1;
  }

  nextU32(): number {
    const s = this.s;
    const s0 = s[0]!;
    const s1 = s[1]!;
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    let s2 = (s[2]! ^ s0) >>> 0;
    let s3 = (s[3]! ^ s1) >>> 0;
    const n1 = (s1 ^ s2) >>> 0;
    const n0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    s[0] = n0;
    s[1] = n1;
    s[2] = s2;
    s[3] = s3;
    return result;
  }

  /** Unbiased integer in [0, n). */
  nextInt(n: number): number {
    if (n <= 0) throw new Error('n must be positive');
    const limit = 0x100000000 - (0x100000000 % n);
    let x = this.nextU32();
    while (x >= limit) x = this.nextU32();
    return x % n;
  }
}

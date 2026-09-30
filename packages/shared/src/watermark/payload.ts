import { crc16 } from './crc16';

/** 64-bit payload = 48-bit watermark id + CRC-16 of the id bytes, MSB first. */
export const PAYLOAD_BITS = 64;
export const ID_BYTES = 6;
export const WATERMARK_ID_PATTERN = /^wm_[0-9a-f]{12}$/;

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function watermarkIdFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== ID_BYTES) throw new Error('watermark id needs 6 bytes');
  return `wm_${toHex(bytes)}`;
}

export function watermarkIdBytes(id: string): Uint8Array {
  if (!WATERMARK_ID_PATTERN.test(id)) throw new Error(`invalid watermark id ${id}`);
  return fromHex(id.slice(3));
}

export function payloadBytes(idBytes: Uint8Array): Uint8Array {
  const crc = crc16(idBytes);
  return Uint8Array.from([...idBytes, (crc >> 8) & 0xff, crc & 0xff]);
}

export function encodePayload(id: string): Uint8Array {
  const bytes = payloadBytes(watermarkIdBytes(id));
  const bits = new Uint8Array(PAYLOAD_BITS);
  for (let i = 0; i < PAYLOAD_BITS; i++) bits[i] = (bytes[i >> 3]! >> (7 - (i & 7))) & 1;
  return bits;
}

export function decodePayload(bits: ArrayLike<number>): { id: string; payloadHex: string; crcOk: boolean } {
  const bytes = new Uint8Array(PAYLOAD_BITS / 8);
  for (let i = 0; i < PAYLOAD_BITS; i++) if (bits[i]) bytes[i >> 3] = bytes[i >> 3]! | (1 << (7 - (i & 7)));
  const idBytes = bytes.slice(0, ID_BYTES);
  const crc = (bytes[6]! << 8) | bytes[7]!;
  return { id: watermarkIdFromBytes(idBytes), payloadHex: toHex(bytes), crcOk: crc16(idBytes) === crc };
}

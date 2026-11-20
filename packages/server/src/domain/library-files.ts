import { open } from 'node:fs/promises';
import { LIBRARY_LIMITS } from '@rideo/shared';
import { invalid } from '../errors';

/**
 * What rideo reads of the files a library upload brings (docs/design/library.md#surfaces): a 3D unit file's 16-byte
 * prefix and JSON header (never its body), and a thumbnail's PNG signature and `IHDR`.
 */

/** `3DUNIT` CR LF: the first 8 bytes of every 3D unit file (the 3D-Editor's `UNIT_MAGIC`). */
export const DESK_UNIT_MAGIC = Buffer.from([0x33, 0x44, 0x55, 0x4e, 0x49, 0x54, 0x0d, 0x0a]);
/** The container version of the prefix (byte 8). */
export const DESK_UNIT_CONTAINER_VERSION = 1;
const PREFIX_BYTES = 16;

/** What a unit file's header declares, as far as rideo checks it. */
export interface DeskUnitHeaderInfo {
  format: string;
  version: number;
  kind: string;
  name: string | null;
}

const notAUnit = (why: string) => invalid(`not a 3D unit file: ${why}`, [{ reason: 'unit' }]);

/**
 * Reads a 3D unit file's prefix (bytes 0–7 the magic, byte 8 the container version, byte 9 the codec: 0 none or 1
 * gzip, bytes 12–15 the header's length, little-endian) and its JSON header, of at most 64 KiB. `validation_error`
 * (reason `unit`) when the file is not one.
 */
export async function readDeskUnitHeader(path: string, size: number): Promise<DeskUnitHeaderInfo> {
  if (size < PREFIX_BYTES + 2) throw notAUnit('it is too short');
  const fh = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(PREFIX_BYTES);
    await fh.read(prefix, 0, PREFIX_BYTES, 0);
    if (!prefix.subarray(0, 8).equals(DESK_UNIT_MAGIC)) throw notAUnit('its first bytes are not 3DUNIT');
    if (prefix[8] !== DESK_UNIT_CONTAINER_VERSION) throw notAUnit(`container version ${prefix[8]} is not 1`);
    if (prefix[9] !== 0 && prefix[9] !== 1) throw notAUnit(`codec ${prefix[9]} is unknown`);
    const length = prefix.readUInt32LE(12);
    if (length < 2 || length > LIBRARY_LIMITS.deskUnitHeaderBytes)
      throw notAUnit(`its header of ${length} bytes is not 2 bytes to 64 KiB`);
    if (PREFIX_BYTES + length > size) throw notAUnit('its header runs past the end of the file');
    const raw = Buffer.alloc(length);
    await fh.read(raw, 0, length, PREFIX_BYTES);
    let header: unknown;
    try {
      header = JSON.parse(raw.toString('utf8'));
    } catch {
      throw notAUnit('its header is not JSON');
    }
    const h = header as Record<string, unknown>;
    if (!h || typeof h !== 'object' || Array.isArray(h)) throw notAUnit('its header is not a JSON object');
    if (typeof h.format !== 'string' || typeof h.kind !== 'string')
      throw notAUnit('its header names no format or kind');
    if (typeof h.version !== 'number' || !Number.isInteger(h.version))
      throw notAUnit('its header names no version');
    return {
      format: h.format,
      version: h.version,
      kind: h.kind,
      name: typeof h.name === 'string' ? h.name : null,
    };
  } finally {
    await fh.close();
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's size from its signature and its first chunk, `IHDR`; null when the bytes are not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * What an image resource's bytes are (docs/design/library.md#limits): one of the raster formats rideo's media probe
 * reads as a still (PNG, JPEG, WebP, GIF, BMP, TIFF), by its signature; null for anything else (an SVG, a page, a video).
 */
export function rasterImageMime(head: Buffer): string | null {
  const ascii = head.toString('latin1', 0, 12);
  if (head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('BM') && head.length >= 14) return 'image/bmp';
  if (ascii.startsWith('II*\0') || ascii.startsWith('MM\0*')) return 'image/tiff';
  return null;
}

/** The first `n` bytes of a file (fewer when it is shorter). */
export async function fileHead(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

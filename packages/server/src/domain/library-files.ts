import { open } from 'node:fs/promises';
import {
  DESK_UNIT_FILE,
  DeskUnitFileError,
  type DeskUnitFileHeader,
  type ResourceKind,
  readDeskUnitHeaderJson,
  readDeskUnitPrefix,
  withArticle,
} from '@rideo/shared';
import { invalid } from '../errors';

/**
 * What rideo reads of the files a library upload brings (docs/design/library.md#surfaces): a 3D unit file's 16-byte
 * prefix and JSON header (never its body), and a thumbnail's PNG signature and `IHDR`.
 */

/** `3DUNIT` CR LF: the first 8 bytes of every 3D unit file (the 3D-Editor's `UNIT_MAGIC`). */
export const DESK_UNIT_MAGIC = Buffer.from(DESK_UNIT_FILE.magic);

const notAUnit = (why: string) => invalid(`not a 3D unit file: ${why}`, [{ reason: 'unit' }]);

/**
 * Reads a 3D unit file's prefix and JSON header from disk, as the 3D-Editor's contract lays them out (the shared
 * reader, `packages/shared/src/library/unit-file.ts`; docs/design/library.md#what-it-holds), never its body.
 * `validation_error` (reason `unit`) when the file is not one.
 */
export async function readDeskUnitHeader(path: string, size: number): Promise<DeskUnitFileHeader> {
  const prefixBytes = DESK_UNIT_FILE.prefixBytes;
  if (size < prefixBytes + 2) throw notAUnit('it is too short');
  const fh = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(prefixBytes);
    await fh.read(prefix, 0, prefixBytes, 0);
    const { headerBytes } = readDeskUnitPrefix(prefix);
    if (prefixBytes + headerBytes > size) throw notAUnit('its header runs past the end of the file');
    const raw = Buffer.alloc(headerBytes);
    await fh.read(raw, 0, headerBytes, prefixBytes);
    return readDeskUnitHeaderJson(raw);
  } catch (err) {
    if (err instanceof DeskUnitFileError) throw notAUnit(err.message);
    throw err;
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

/** RFC 6838's restricted name: a subtype is one token, so no list, space, quote or parameter follows the type. */
const MEDIA_SUBTYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The type a video or an audio resource is kept and served with (docs/design/library.md#surfaces): the type its client
 * gave, when it is one `video/…` or `audio/…` of the resource's kind once its parameters are dropped (`video/mp4;
 * codecs=…` is `video/mp4`); null for anything else, a list such as `video/mp4, text/html` among it (a browser reads a
 * list as its last type).
 */
export function mediaResourceMime(kind: 'video' | 'audio', declared: string): string | null {
  const essence = (declared.split(';', 1)[0] ?? '').trim().toLowerCase();
  const slash = essence.indexOf('/');
  if (slash < 0 || essence.slice(0, slash) !== kind) return null;
  return MEDIA_SUBTYPE.test(essence.slice(slash + 1)) ? essence : null;
}

/**
 * The type a resource's file is kept and served with in the library (docs/design/library.md#surfaces), or null when
 * the library does not take it under the type it was given: a picture is what its bytes are, never its given type (a
 * page or an SVG served from the library would run in the studio's origin); a video or a sound keeps its one type
 * (`mediaResourceMime`); a LUT is `application/x-cube`. For an upload and for Save to library alike.
 */
export async function resourceFileMime(
  kind: ResourceKind,
  declared: string,
  path: string,
): Promise<string | null> {
  if (kind === 'image') return rasterImageMime(await fileHead(path, 16));
  if (kind === 'lut') return 'application/x-cube';
  return mediaResourceMime(kind, declared);
}

/** Why the library does not take a resource's file under the type it was given (`reason: payload`). */
export function resourceTypeRefusal(kind: ResourceKind, declared: string): string {
  return kind === 'image'
    ? 'an image resource is a PNG, JPEG, WebP, GIF, BMP or TIFF file'
    : `${withArticle(kind)} resource has one ${kind}/… type, not ${JSON.stringify(declared)}`;
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

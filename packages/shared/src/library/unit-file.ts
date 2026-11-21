import { DESK_UNIT_FILE_KINDS, type DeskUnitFileKind } from '../schemas/desk';
import { LIBRARY_LIMITS } from '../schemas/library';
import { plural } from '../util/text';

/**
 * The unit file a host may read (docs/design/library.md#what-it-holds): the 3D-Editor's contract, the section "The
 * unit file" of its docs/embedding.md (sloth-os/3D-Editor), stable for format `3d-editor.desk-unit` version 1. One
 * reader for the server (an upload) and the browser (a desk's open), so both read a file as the contract lays it out:
 *
 * | Bytes  | Content                                                                                       |
 * | ------ | --------------------------------------------------------------------------------------------- |
 * | 0–7    | the magic `3DUNIT` CR LF                                                                      |
 * | 8      | the container version: 1                                                                      |
 * | 9      | the body's compression: 0 none, 1 gzip                                                        |
 * | 10–11  | both 0                                                                                        |
 * | 12–15  | the header's length in bytes (unsigned 32-bit, little-endian), at most 64 KiB                 |
 * | header | UTF-8 JSON holding at least `format`, `version`, `kind` (set, prop, figure), `name` (1–120)   |
 * | body   | the unit itself, the desk's own: never read here                                              |
 *
 * The header's other fields are the desk's own. What the contract fixes is checked here; whether the format is
 * `3d-editor.desk-unit` and the version 1 is the caller's to decide (an upload keeps only those, an open says what the
 * file says).
 */
export const DESK_UNIT_FILE = {
  /** `3DUNIT` CR LF (the 3D-Editor's `UNIT_MAGIC`). */
  magic: [0x33, 0x44, 0x55, 0x4e, 0x49, 0x54, 0x0d, 0x0a],
  containerVersion: 1,
  prefixBytes: 16,
  maxHeaderBytes: LIBRARY_LIMITS.deskUnitHeaderBytes,
  maxNameLength: 120,
} as const;

/** What the prefix and the header of a unit file say. */
export interface DeskUnitFileHeader {
  format: string;
  version: number;
  kind: DeskUnitFileKind;
  name: string;
}

/** Bytes that are not a unit file as the contract lays it out; the message says why ("its first bytes are not 3DUNIT"). */
export class DeskUnitFileError extends Error {
  override name = 'DeskUnitFileError';
}

/** The prefix (the first 16 bytes): the header's length and whether the body is gzipped. */
export function readDeskUnitPrefix(prefix: Uint8Array): { headerBytes: number; gzip: boolean } {
  const { magic, containerVersion, prefixBytes, maxHeaderBytes } = DESK_UNIT_FILE;
  if (prefix.length < prefixBytes) throw new DeskUnitFileError('it is too short');
  if (magic.some((b, i) => prefix[i] !== b)) throw new DeskUnitFileError('its first bytes are not 3DUNIT');
  if (prefix[8] !== containerVersion) throw new DeskUnitFileError(`container version ${prefix[8]} is not 1`);
  if (prefix[9] !== 0 && prefix[9] !== 1) throw new DeskUnitFileError(`codec ${prefix[9]} is unknown`);
  if (prefix[10] !== 0 || prefix[11] !== 0) throw new DeskUnitFileError('its bytes 10 and 11 are not 0');
  const headerBytes = new DataView(prefix.buffer, prefix.byteOffset, prefixBytes).getUint32(12, true);
  if (headerBytes < 2 || headerBytes > maxHeaderBytes)
    throw new DeskUnitFileError(`its header of ${plural(headerBytes, 'byte')} is not 2 bytes to 64 KiB`);
  return { headerBytes, gzip: prefix[9] === 1 };
}

/** The header (the bytes after the prefix, as long as the prefix says): UTF-8 JSON with its format, version, kind, name. */
export function readDeskUnitHeaderJson(bytes: Uint8Array): DeskUnitFileHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new DeskUnitFileError('its header is not UTF-8 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new DeskUnitFileError('its header is not a JSON object');
  const h = parsed as Record<string, unknown>;
  if (typeof h.format !== 'string' || !h.format) throw new DeskUnitFileError('its header names no format');
  if (typeof h.version !== 'number' || !Number.isInteger(h.version) || h.version < 1)
    throw new DeskUnitFileError('its header names no version');
  if (typeof h.kind !== 'string' || !(DESK_UNIT_FILE_KINDS as readonly string[]).includes(h.kind))
    throw new DeskUnitFileError('its header names no kind of set, prop or figure');
  if (typeof h.name !== 'string' || h.name.length < 1 || h.name.length > DESK_UNIT_FILE.maxNameLength)
    throw new DeskUnitFileError('its header names no name of 1 to 120 characters');
  return { format: h.format, version: h.version, kind: h.kind as DeskUnitFileKind, name: h.name };
}

/** A unit file in memory, its prefix and header read (the body is not). */
export function readDeskUnitFile(bytes: Uint8Array): DeskUnitFileHeader & { gzip: boolean } {
  const { headerBytes, gzip } = readDeskUnitPrefix(bytes.subarray(0, DESK_UNIT_FILE.prefixBytes));
  const end = DESK_UNIT_FILE.prefixBytes + headerBytes;
  if (end > bytes.length) throw new DeskUnitFileError('its header runs past the end of the file');
  return { ...readDeskUnitHeaderJson(bytes.subarray(DESK_UNIT_FILE.prefixBytes, end)), gzip };
}

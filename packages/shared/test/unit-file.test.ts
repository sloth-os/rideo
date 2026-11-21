import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESK_UNIT_FILE, DeskUnitFileError, readDeskUnitFile } from '../src';

/**
 * The unit file a host may read (docs/design/library.md#what-it-holds): the 3D-Editor's contract, its
 * docs/embedding.md section "The unit file", against a unit file its core wrote (`units/unit-file-prop.json`, a
 * verbatim copy of the 3D-Editor's fixture: a red kite).
 */
const FIXTURE = join(import.meta.dirname, 'fixtures/desk-protocol/units/unit-file-prop.json');
const editorUnit = () =>
  new Uint8Array(
    Buffer.from((JSON.parse(readFileSync(FIXTURE, 'utf8')) as { $bytes: string }).$bytes, 'base64'),
  );

/** A unit file: the prefix (the magic, container 1, codec 0, two zero bytes, the header's length), the header, a body. */
function unit(header: unknown, prefix: Record<number, number> = {}): Uint8Array {
  const json =
    header instanceof Uint8Array
      ? header
      : new TextEncoder().encode(typeof header === 'string' ? header : JSON.stringify(header));
  const out = new Uint8Array(16 + json.length + 4);
  out.set(DESK_UNIT_FILE.magic, 0);
  out[8] = 1;
  new DataView(out.buffer).setUint32(12, json.length, true);
  for (const [i, v] of Object.entries(prefix)) out[Number(i)] = v;
  out.set(json, 16);
  return out;
}
const header = { format: '3d-editor.desk-unit', version: 1, kind: 'prop', name: 'Red kite' };
const why = (bytes: Uint8Array) => {
  try {
    readDeskUnitFile(bytes);
    return 'read';
  } catch (err) {
    if (err instanceof DeskUnitFileError) return err.message;
    throw err;
  }
};

describe('the unit file a host may read', () => {
  it("reads the 3D-Editor's own unit file: a prop named Red kite, version 1, gzipped", () => {
    const bytes = editorUnit();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '839114263baa77e854f16ee63db032f7b01f0a2a7b1f103a6e732dc9732ef16c',
    );
    expect(readDeskUnitFile(bytes)).toEqual({
      format: '3d-editor.desk-unit',
      version: 1,
      kind: 'prop',
      name: 'Red kite',
      gzip: true,
    });
    expect(readDeskUnitFile(unit(header))).toEqual({ ...header, gzip: false });
  });

  it('refuses every file the contract does not lay out, saying why', () => {
    const real = editorUnit();
    const changed = (i: number, v: number) => {
      const b = real.slice();
      b[i] = v;
      return b;
    };
    expect(why(changed(0, 0x34))).toBe('its first bytes are not 3DUNIT');
    expect(why(changed(8, 2))).toBe('container version 2 is not 1');
    expect(why(changed(9, 2))).toBe('codec 2 is unknown');
    // bytes 10 and 11 are both 0
    expect(why(changed(10, 1))).toBe('its bytes 10 and 11 are not 0');
    expect(why(changed(11, 1))).toBe('its bytes 10 and 11 are not 0');
    expect(why(real.slice(0, 12))).toBe('it is too short');
    expect(why(real.slice(0, 200))).toBe('its header runs past the end of the file');
    const long = real.slice();
    new DataView(long.buffer).setUint32(12, 64 * 1024 + 1, true);
    expect(why(long)).toBe('its header of 65537 bytes is not 2 bytes to 64 KiB');
    // the header's length counted with its noun (docs/brand.md#voice): one byte, and none
    const headerOf = (n: number) => {
      const b = real.slice();
      new DataView(b.buffer).setUint32(12, n, true);
      return b;
    };
    expect(why(headerOf(1))).toBe('its header of 1 byte is not 2 bytes to 64 KiB');
    expect(why(headerOf(0))).toBe('its header of 0 bytes is not 2 bytes to 64 KiB');
    // the header: UTF-8 JSON with a format, version, kind of the three and a name of 1–120 characters
    const notUtf8 = new TextEncoder().encode(JSON.stringify({ ...header, name: 'Red XX' }));
    notUtf8.set([0xc3, 0x28], notUtf8.indexOf(0x58));
    expect(why(unit(notUtf8))).toBe('its header is not UTF-8 JSON');
    expect(why(unit('{"format": '))).toBe('its header is not UTF-8 JSON');
    expect(why(unit('[1, 2]'))).toBe('its header is not a JSON object');
    expect(why(unit({ ...header, format: undefined }))).toBe('its header names no format');
    expect(why(unit({ ...header, version: 1.5 }))).toBe('its header names no version');
    expect(why(unit({ ...header, kind: 'tree' }))).toBe('its header names no kind of set, prop or figure');
    expect(why(unit({ ...header, name: undefined }))).toBe('its header names no name of 1 to 120 characters');
    expect(why(unit({ ...header, name: '' }))).toBe('its header names no name of 1 to 120 characters');
    expect(why(unit({ ...header, name: 'k'.repeat(121) }))).toBe(
      'its header names no name of 1 to 120 characters',
    );
    // what the contract does not fix is read as it is: another version, a gzipped body, a long name
    expect(readDeskUnitFile(unit({ ...header, version: 3, name: 'k'.repeat(120) }, { 9: 1 }))).toMatchObject({
      version: 3,
      gzip: true,
    });
  });
});

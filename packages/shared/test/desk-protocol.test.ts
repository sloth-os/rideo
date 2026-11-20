import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_MOVES,
  CameraSchema,
  DESK_MOVES,
  DESK_PUBLISH_REFUSALS,
  DESK_RESULT_LIMITS,
  DESK_STATE_MAX_BYTES,
  DESK_TO_HOST_TYPES,
  DESK_UNIT_FILE_KINDS,
  DESK_UNIT_FORMAT,
  DESK_UNIT_LIMITS,
  DESK_UNIT_PENDING_REASONS,
  DESK_UNIT_REFUSED_REASONS,
  DeskConnectSchema,
  DeskHelloSchema,
  DeskProtocolMessageSchema,
  DeskStateSchema,
  DeskToHostMessageSchema,
  deskOrigin,
  deskUrlProblem,
  HostToDeskMessageSchema,
  LIBRARY_LIMITS,
} from '../src';

/**
 * The desk embed protocol against the 3D-Editor's fixtures (docs/design/director-desk.md#the-protocol): a verbatim
 * copy of its contract's one valid example of every message and some invalid ones. A change on either side that
 * breaks the other shows up here.
 */
const DIR = join(import.meta.dirname, 'fixtures/desk-protocol');

/** JSON fixtures write an ArrayBuffer as {"$bytes": "<base64>"}. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.$bytes === 'string' && Object.keys(o).length === 1) {
      const b = Buffer.from(o.$bytes, 'base64');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const valid = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f, read(join(DIR, f))] as const);
const invalid = readdirSync(join(DIR, 'invalid'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f, read(join(DIR, 'invalid', f))] as const);
/**
 * Invalid for the desk that sends them, read leniently by rideo (docs/design/director-desk.md#what-a-stored-state-uses):
 * a state whose units do not validate is a state whose units are not known.
 */
const LENIENT = new Set(['state-units-bad-staged.json']);
const fixture = (name: string) => {
  const found = valid.find(([n]) => n === name) ?? invalid.find(([n]) => `invalid/${n}` === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return revive(found[1]) as any;
};
const sha256 = (data: ArrayBuffer) => createHash('sha256').update(new Uint8Array(data)).digest('hex');

describe('the desk protocol fixtures', () => {
  it('has a valid example of every message type and invalid ones', () => {
    const types = new Set(valid.map(([, m]) => m.type));
    for (const t of [
      'hello',
      'connect',
      'open',
      'export',
      'cancel',
      'save',
      'result-ack',
      'unit-ack',
      ...DESK_TO_HOST_TYPES,
    ])
      expect(types.has(t), t).toBe(true);
    expect(invalid.length).toBeGreaterThanOrEqual(10);
  });

  it.each(valid)('parses %s', (_name, json) => {
    const message = revive(json);
    expect(DeskProtocolMessageSchema.safeParse(message).success).toBe(true);
    // and in its own direction
    const type = String(json.type);
    const schema =
      type === 'hello'
        ? DeskHelloSchema
        : type === 'connect'
          ? DeskConnectSchema
          : DESK_TO_HOST_TYPES.includes(type)
            ? DeskToHostMessageSchema
            : HostToDeskMessageSchema;
    const parsed = schema.safeParse(message);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it.each(invalid.filter(([name]) => !LENIENT.has(name)))('rejects invalid/%s', (_name, json) => {
    expect(DeskProtocolMessageSchema.safeParse(revive(json)).success).toBe(false);
  });

  it('takes bytes as ArrayBuffers only: an undecoded {"$bytes"} or a string is refused', () => {
    const [, state] = valid.find(([n]) => n === 'state.json')!;
    expect(DeskProtocolMessageSchema.safeParse(state).success).toBe(false);
    const parsed = DeskToHostMessageSchema.parse(revive(state));
    expect(parsed.type === 'state' && parsed.state.data).toBeInstanceOf(ArrayBuffer);
    expect(
      DeskStateSchema.safeParse({ format: '3d-editor.desk-state', version: 1, data: 'AAEC' }).success,
    ).toBe(false);
  });

  it('keeps a desk state within 64 MiB', () => {
    const ok = { format: '3d-editor.desk-state', version: 1, data: new ArrayBuffer(16) };
    expect(DeskStateSchema.safeParse(ok).success).toBe(true);
    const big = { ...ok, data: new ArrayBuffer(DESK_STATE_MAX_BYTES + 1) };
    expect(DeskStateSchema.safeParse(big).success).toBe(false);
    expect(DeskStateSchema.safeParse({ ...ok, version: 2 }).success).toBe(false);
  });

  it('bounds a result: at most 200 shots, 800 files and file names of 200 characters', () => {
    const [, fixture] = valid.find(([n]) => n === 'result.json')!;
    const result = revive(fixture) as {
      shots: { shotId: string; references: Record<string, string>; still: string | null }[];
      files: { name: string; mime: string; data: ArrayBuffer }[];
    };
    const ok = DeskToHostMessageSchema.safeParse(result);
    expect(ok.success).toBe(true);
    expect(DESK_RESULT_LIMITS).toEqual({ shots: 200, files: 800, name: 200 });
    const shot = result.shots[0]!;
    const file = result.files[0]!;
    const shots = (n: number) => ({ ...result, shots: Array.from({ length: n }, () => shot) });
    expect(DeskToHostMessageSchema.safeParse(shots(200)).success).toBe(true);
    expect(DeskToHostMessageSchema.safeParse(shots(201)).success).toBe(false);
    const files = (n: number) => ({ ...result, files: Array.from({ length: n }, () => file) });
    expect(DeskToHostMessageSchema.safeParse(files(800)).success).toBe(true);
    expect(DeskToHostMessageSchema.safeParse(files(801)).success).toBe(false);
    const named = (name: string) => ({ ...result, files: [{ ...file, name }, ...result.files.slice(1)] });
    expect(DeskToHostMessageSchema.safeParse(named('n'.repeat(200))).success).toBe(true);
    expect(DeskToHostMessageSchema.safeParse(named('n'.repeat(201))).success).toBe(false);
    const referenced = (name: string) => ({
      ...result,
      shots: [{ ...shot, references: { camera: name }, still: name }, ...result.shots.slice(1)],
    });
    expect(DeskToHostMessageSchema.safeParse(referenced('n'.repeat(200))).success).toBe(true);
    expect(DeskToHostMessageSchema.safeParse(referenced('n'.repeat(201))).success).toBe(false);
  });

  it('names the same 20 moves and framings as rideo', () => {
    expect([...DESK_MOVES].sort()).toEqual(CAMERA_MOVES.map((m) => m.id).sort());
    const framings = CameraSchema.shape.framing.unwrap().options;
    const [, open] = valid.find(([n]) => n === 'open.json')!;
    for (const f of framings) {
      const message = revive(open) as any;
      message.scene.shots[0].framing = f;
      expect(HostToDeskMessageSchema.safeParse(message).success, f).toBe(true);
    }
  });
});

describe('library units in the protocol (docs/design/director-desk.md#library-units)', () => {
  it("keeps the contract's constants", () => {
    expect(DESK_UNIT_FORMAT).toBe('3d-editor.desk-unit');
    expect(DESK_UNIT_FILE_KINDS).toEqual(['set', 'prop', 'figure']);
    expect(DESK_UNIT_LIMITS).toMatchObject({
      unitBytes: 33554432,
      openBytes: 48 * 1024 * 1024,
      openUnits: 81,
      thumbnailBytes: 65536,
      metaBytes: 16384,
      stateUnits: 128,
    });
    // the library's own limits are the protocol's
    expect(LIBRARY_LIMITS.deskUnitBytes).toBe(DESK_UNIT_LIMITS.unitBytes);
    expect(LIBRARY_LIMITS.thumbnailBytes).toBe(DESK_UNIT_LIMITS.thumbnailBytes);
    expect(LIBRARY_LIMITS.deskMetaBytes).toBe(DESK_UNIT_LIMITS.metaBytes);
    expect(DESK_PUBLISH_REFUSALS).toEqual([
      'refused',
      'conflict',
      'too_large',
      'invalid',
      'unavailable',
      'failed',
    ]);
    expect(DESK_UNIT_PENDING_REASONS).toEqual(['missing', 'mismatch', 'unavailable']);
    expect(DESK_UNIT_REFUSED_REASONS).toHaveLength(8);
  });

  it('reads the capability leniently: unknown kinds dropped, anything it cannot use is no units, never a failed ready', () => {
    const ready = fixture('ready-units.json');
    const parsed = DeskToHostMessageSchema.parse(ready) as any;
    expect(parsed.capabilities.units).toEqual({
      versions: [1],
      kinds: ['set', 'prop', 'figure'],
      maxBytes: 33554432,
      publish: true,
    });
    const units = (u: unknown) => {
      const r = DeskToHostMessageSchema.safeParse({
        ...ready,
        capabilities: { ...ready.capabilities, units: u },
      });
      expect(r.success).toBe(true);
      return (r.data as any).capabilities.units;
    };
    expect(units({ ...ready.capabilities.units, kinds: ['set', 'vehicle'] })?.kinds).toEqual(['set']);
    expect(units({ ...ready.capabilities.units, versions: [1, 2] })?.versions).toEqual([1, 2]);
    // only a newer version, only unknown kinds, garbage: no units
    expect(units({ ...ready.capabilities.units, versions: [2] })).toBeUndefined();
    expect(units({ ...ready.capabilities.units, kinds: ['vehicle'] })).toBeUndefined();
    expect(units({ ...ready.capabilities.units, maxBytes: -1 })).toBeUndefined();
    expect(units('units please')).toBeUndefined();
    expect(units(null)).toBeUndefined();
    // a desk from before units
    expect((DeskToHostMessageSchema.parse(fixture('ready.json')) as any).capabilities.units).toBeUndefined();
  });

  it('reads state.units leniently: rows that do not validate are units not known, and the state still parses', () => {
    const good = DeskToHostMessageSchema.parse(fixture('state-units.json')) as any;
    expect(good.units).toHaveLength(3);
    expect(good.units[0]).toMatchObject({ slot: 'cast:chr_0123456789mira', staged: 'unit', local: true });
    expect(good.units[1]).toMatchObject({ staged: 'pending', why: 'missing' });
    // the contract's invalid fixture (a row staged 'words'): the state is kept, its units are unknown
    const bad = DeskToHostMessageSchema.safeParse(fixture('invalid/state-units-bad-staged.json'));
    expect(bad.success).toBe(true);
    expect(bad.data?.type).toBe('state');
    expect((bad.data as any).units).toBeUndefined();
    expect((bad.data as any).state.data).toBeInstanceOf(ArrayBuffer);
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ...good.units[2], slot: `el:e${i}` }));
    expect((DeskToHostMessageSchema.parse({ ...good, units: rows(128) }) as any).units).toHaveLength(128);
    expect((DeskToHostMessageSchema.parse({ ...good, units: rows(129) }) as any).units).toBeUndefined();
    // a reason the units header could not carry reads as unknown too
    const odd = { ...good, units: [{ ...good.units[1], why: 'not, a code' }] };
    expect((DeskToHostMessageSchema.parse(odd) as any).units).toBeUndefined();
  });

  it('reads state.units naming a slot twice as units not known (no header could carry them); the state still parses', () => {
    const good = DeskToHostMessageSchema.parse(fixture('state-units.json')) as any;
    const [mira, kite, set] = good.units;
    const twice = DeskToHostMessageSchema.safeParse({
      ...good,
      units: [mira, kite, set, { ...set, version: 4 }],
    });
    expect(twice.success).toBe(true);
    expect((twice.data as any).units).toBeUndefined();
    expect((twice.data as any).state.data).toBeInstanceOf(ArrayBuffer);
    // each slot once, in another order: read as they come
    const shuffled = DeskToHostMessageSchema.parse({ ...good, units: [set, mira, kite] }) as any;
    expect(shuffled.units.map((u: { slot: string }) => u.slot)).toEqual([set.slot, mira.slot, kite.slot]);
  });

  it('carries the pins and the unit files of an open, with real sha256 values', () => {
    const open = fixture('open-units.json');
    const parsed = HostToDeskMessageSchema.parse(open) as any;
    expect(parsed.scene.set.unit).toEqual({
      ref: 'lib_0123456789mead',
      version: 3,
      sha256: 'f6cd47ae2c534ee3445559d6be6a77bf502b58a73c15e9bb8dfcac54717c9011',
    });
    expect(parsed.options.units).toEqual({ version: 1, publish: true });
    for (const u of parsed.units) expect(sha256(u.unit.data)).toBe(u.sha256);
    const hints = HostToDeskMessageSchema.parse(fixture('open-units-figure-hints.json')) as any;
    expect(hints.scene.cast[0]).toMatchObject({ kind: 'child', heightM: 1.24 });
    // a 63-character sha256 in a pin: the brief is refused
    expect(HostToDeskMessageSchema.safeParse(fixture('invalid/open-units-bad-pin.json')).success).toBe(false);
  });

  it('bounds the units of an open: 81 entries, each ref@version once, 48 MiB in all, a file of 32 MiB', () => {
    const open = fixture('open-units.json');
    const entry = (ref: string, bytes: number) => ({
      ref,
      version: 1,
      sha256: 'a'.repeat(64),
      unit: { format: '3d-editor.desk-unit', version: 1, data: new ArrayBuffer(bytes) },
    });
    const withUnits = (units: unknown[]) => HostToDeskMessageSchema.safeParse({ ...open, units }).success;
    expect(withUnits(Array.from({ length: 81 }, (_, i) => entry(`lib_x${i}`, 4)))).toBe(true);
    expect(withUnits(Array.from({ length: 82 }, (_, i) => entry(`lib_x${i}`, 4)))).toBe(false);
    expect(withUnits([entry('lib_a', 4), entry('lib_a', 4)])).toBe(false);
    const mib = 1024 * 1024;
    expect(withUnits([entry('lib_a', 32 * mib), entry('lib_b', 16 * mib)])).toBe(true);
    expect(withUnits([entry('lib_a', 32 * mib), entry('lib_b', 16 * mib + 1)])).toBe(false);
    expect(withUnits([entry('lib_a', 32 * mib + 1)])).toBe(false);
    expect(withUnits([entry('lib_a', 0)])).toBe(false);
  });

  it('reads a publish: one slot it came from, a lowercase sha256, a thumbnail of 64 KiB at most', () => {
    const set = DeskToHostMessageSchema.parse(fixture('unit-publish-set.json')) as any;
    expect(set).toMatchObject({ type: 'unit-publish', id: 'pub-1', kind: 'set', from: { set: true } });
    expect(sha256(set.unit.data)).toBe(set.sha256);
    const figure = DeskToHostMessageSchema.parse(fixture('unit-publish-figure-new-version.json')) as any;
    expect(figure.newVersionOf).toEqual({ ref: 'lib_0123456789mira', version: 2 });
    expect(figure.meta.actor).toEqual({ kind: 'child', heightM: 1.24 });
    for (const name of [
      'invalid/unit-publish-two-from.json',
      'invalid/unit-publish-bad-sha.json',
      'invalid/unit-publish-thumbnail-too-large.json',
    ])
      expect(DeskToHostMessageSchema.safeParse(fixture(name)).success, name).toBe(false);
  });

  it('sends an ack with its item, version and link when ok, and a code when not', () => {
    for (const name of ['unit-ack-linked.json', 'unit-ack-unlinked.json', 'unit-ack-refused.json'])
      expect(HostToDeskMessageSchema.safeParse(fixture(name)).success, name).toBe(true);
    expect(HostToDeskMessageSchema.safeParse(fixture('invalid/unit-ack-ok-without-ref.json')).success).toBe(
      false,
    );
    const ack = {
      type: 'unit-ack',
      id: 'pub-1',
      ok: true,
      ref: 'lib_0123456789mead',
      version: 4,
      linked: true,
    };
    const { linked: _linked, ...withoutLinked } = ack;
    expect(HostToDeskMessageSchema.safeParse(withoutLinked).success).toBe(false);
    expect(HostToDeskMessageSchema.safeParse({ ...ack, id: '' }).success).toBe(false);
    expect(
      HostToDeskMessageSchema.safeParse({ type: 'unit-ack', id: 'pub-1', ok: false, code: 'conflict' })
        .success,
    ).toBe(true);
  });
});

describe('the desk URL (RIDEO_DESK_URL)', () => {
  it('is an https page, or an http one on localhost', () => {
    expect(deskUrlProblem('https://desk.example.com/desk.html')).toBeNull();
    expect(deskUrlProblem('http://localhost:5174/desk.html')).toBeNull();
    expect(deskUrlProblem('http://127.0.0.1:5174/desk.html')).toBeNull();
    expect(deskUrlProblem('http://desk.example.com/desk.html')).toMatch(/https/);
    expect(deskUrlProblem('ftp://desk.example.com/desk.html')).toMatch(/https/);
    expect(deskUrlProblem('https://desk.example.com/')).toMatch(/not a folder/);
    expect(deskUrlProblem('https://desk.example.com')).toMatch(/not a folder/);
    expect(deskUrlProblem('https://me:secret@desk.example.com/desk.html')).toMatch(/password/);
    expect(deskUrlProblem('desk.html')).toMatch(/URL like/);
    expect(deskOrigin('https://desk.example.com:8443/app/desk.html?x=1')).toBe(
      'https://desk.example.com:8443',
    );
  });
});

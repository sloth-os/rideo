import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_MOVES,
  CameraSchema,
  DESK_MOVES,
  DESK_RESULT_LIMITS,
  DESK_STATE_MAX_BYTES,
  DESK_TO_HOST_TYPES,
  DeskConnectSchema,
  DeskHelloSchema,
  DeskProtocolMessageSchema,
  DeskStateSchema,
  DeskToHostMessageSchema,
  deskOrigin,
  deskUrlProblem,
  HostToDeskMessageSchema,
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

  it.each(invalid)('rejects invalid/%s', (_name, json) => {
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

import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import { LIBRARY_LIMITS, LibraryUploadMetaSchema, newId } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import type { LibraryUploadFiles } from '../../src/domain/library';
import {
  DESK_UNIT_MAGIC,
  mediaResourceMime,
  pngSize,
  rasterImageMime,
  readDeskUnitHeader,
} from '../../src/domain/library-files';
import { createStudio, type Studio } from '../../src/domain/studio';
import { AppError } from '../../src/errors';
import { byteRange, receiveLibraryUpload } from '../../src/http/library-routes';
import { MemoryBackend } from '../../src/storage/memory';

/** Library uploads (docs/design/library.md#surfaces): the multipart parts, their limits and what rideo checks. */

const dirs: string[] = [];
const tmpDir = async () => {
  const d = await mkdtemp(join(tmpdir(), 'rideo-libup-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function unitFile(
  kind: string,
  body = 'body',
  opts: { header?: unknown; magic?: Buffer; container?: number; codec?: number; length?: number } = {},
) {
  const json = Buffer.isBuffer(opts.header)
    ? opts.header
    : Buffer.from(
        typeof opts.header === 'string'
          ? opts.header
          : JSON.stringify(
              opts.header ?? { format: '3d-editor.desk-unit', version: 1, kind, name: 'Harbor' },
            ),
      );
  const prefix = Buffer.alloc(16);
  (opts.magic ?? DESK_UNIT_MAGIC).copy(prefix, 0);
  prefix[8] = opts.container ?? 1;
  prefix[9] = opts.codec ?? 0;
  prefix.writeUInt32LE(opts.length ?? json.length, 12);
  return Buffer.concat([prefix, json, Buffer.from(body)]);
}
const META = {
  dimensionsM: [12, 8, 4],
  objects: 14,
  triangles: 20_000,
  actor: null,
  credits: [],
  deskVersion: '1.4.0',
  digest: 'a'.repeat(64),
};
const setMeta = (extra: Record<string, unknown> = {}) => ({
  kind: 'desk-set',
  name: 'Harbor',
  unit: { format: '3d-editor.desk-unit', formatVersion: 1, meta: META },
  ...extra,
});
const png = (w: number, h: number) => Buffer.from(f.pngBytes(w, h));
/** A unit file the 3D-Editor's core wrote: a red kite (`units/unit-file-prop.json`, a verbatim copy of its fixture). */
const editorUnit = () =>
  Buffer.from(
    (
      JSON.parse(
        readFileSync(
          join(import.meta.dirname, '../../../shared/test/fixtures/desk-protocol/units/unit-file-prop.json'),
          'utf8',
        ),
      ) as { $bytes: string }
    ).$bytes,
    'base64',
  );

describe('the multipart parts', () => {
  let app: FastifyInstance;
  let url: string;
  let tmp: string;
  const refused = vi.fn((_kind: string, _reason: string, err: AppError) => err);
  let received: LibraryUploadFiles | null = null;
  /** How the last receive ended: pending while it runs. */
  let outcome = '';
  beforeAll(async () => {
    app = Fastify();
    await app.register(multipart, { limits: { fileSize: 4 * 1024 ** 3, files: 2 } });
    app.setErrorHandler((err: Error, _req, reply) =>
      reply.code(err instanceof AppError ? err.status : 500).send({
        code: err instanceof AppError ? err.code : 'internal',
        errors: err instanceof AppError ? err.errors : [],
      }),
    );
    app.post('/upload', async (req) => {
      outcome = 'pending';
      try {
        received = await receiveLibraryUpload(req, (ext) => join(tmp, `${newId('job')}.${ext}`), refused);
        outcome = 'resolved';
      } catch (err) {
        outcome = `rejected: ${(err as Error).message}`;
        throw err;
      }
      return {
        kind: received.meta.kind,
        payload: received.payload.size,
        thumbnail: received.thumbnail?.size ?? null,
      };
    });
    url = `${await app.listen({ port: 0, host: '127.0.0.1' })}/upload`;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    tmp = await tmpDir();
    refused.mockClear();
    received = null;
  });
  const send = async (parts: [string, string | Buffer, string?][]) => {
    const form = new FormData();
    for (const [name, value, type] of parts)
      if (typeof value === 'string' && !type) form.append(name, value);
      else
        form.append(
          name,
          new Blob([typeof value === 'string' ? value : new Uint8Array(value)], {
            type: type ?? 'application/octet-stream',
          }),
          `${name}.bin`,
        );
    const res = await fetch(url, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  };

  it('takes meta, then the payload, then a thumbnail, each to a temporary file', async () => {
    const r = await send([
      ['meta', JSON.stringify(setMeta())],
      ['payload', unitFile('set')],
      ['thumbnail', png(64, 64), 'image/png'],
    ]);
    expect(r).toEqual({
      status: 200,
      body: { kind: 'desk-set', payload: unitFile('set').length, thumbnail: 33 },
    });
    expect(await readdir(tmp)).toHaveLength(2);
  });

  it('refuses parts out of order, a missing payload and bad meta with 422', async () => {
    const order = await send([
      ['payload', unitFile('set')],
      ['meta', JSON.stringify(setMeta())],
    ]);
    expect(order).toMatchObject({
      status: 422,
      body: { code: 'validation_error', errors: [{ reason: 'order' }] },
    });
    expect(
      await send([
        ['meta', JSON.stringify(setMeta())],
        ['thumbnail', png(8, 8), 'image/png'],
      ]),
    ).toMatchObject({ status: 422 });
    expect(await send([['meta', JSON.stringify(setMeta())]])).toMatchObject({
      status: 422,
      body: { errors: [{ reason: 'order' }] },
    });
    expect(
      await send([
        ['meta', '{not json'],
        ['payload', unitFile('set')],
      ]),
    ).toMatchObject({
      status: 422,
      body: { errors: [{ reason: 'meta' }] },
    });
    // the 3D meta over 16 KiB of JSON (within the part's 32 KiB)
    const credits = Array.from({ length: 32 }, (_, i) => ({
      name: `model ${i}`,
      author: 'x'.repeat(200),
      license: 'CC-BY-4.0',
    }));
    const big = JSON.stringify(
      setMeta({
        unit: {
          format: '3d-editor.desk-unit',
          formatVersion: 1,
          meta: { ...META, credits: credits.map((c) => ({ ...c, name: '€'.repeat(120) })) },
        },
      }),
    );
    expect(Buffer.byteLength(big)).toBeLessThan(LIBRARY_LIMITS.uploadMetaBytes);
    expect(
      await send([
        ['meta', big],
        ['payload', unitFile('set')],
      ]),
    ).toMatchObject({ status: 422 });
    expect(refused.mock.calls.map((c) => c[1])).toEqual(['order', 'order', 'order', 'meta', 'meta']);
    expect(await readdir(tmp)).toEqual([]);
  });

  it('refuses a unit of 32 MiB + 1 byte, a thumbnail over 64 KiB and meta over 32 KiB with 413, removing what it wrote', async () => {
    const huge = Buffer.alloc(LIBRARY_LIMITS.deskUnitBytes + 1, 7);
    const r = await send([
      ['meta', JSON.stringify(setMeta())],
      ['payload', huge],
    ]);
    expect(r).toMatchObject({ status: 413, body: { code: 'validation_error' } });
    expect(refused).toHaveBeenLastCalledWith('desk-set', 'size', expect.any(AppError));
    expect(await readdir(tmp)).toEqual([]);
    // exactly 32 MiB is fine
    const exact = await send([
      ['meta', JSON.stringify(setMeta())],
      ['payload', huge.subarray(0, LIBRARY_LIMITS.deskUnitBytes)],
    ]);
    expect(exact.status).toBe(200);
    const thumb = await send([
      ['meta', JSON.stringify(setMeta())],
      ['payload', unitFile('set')],
      ['thumbnail', Buffer.concat([png(64, 64), Buffer.alloc(LIBRARY_LIMITS.thumbnailBytes)]), 'image/png'],
    ]);
    expect(thumb).toMatchObject({ status: 413 });
    expect(refused).toHaveBeenLastCalledWith('desk-set', 'thumbnail', expect.any(AppError));
    const meta = await send([
      ['meta', JSON.stringify({ ...setMeta(), description: 'x'.repeat(LIBRARY_LIMITS.uploadMetaBytes) })],
      ['payload', unitFile('set')],
    ]);
    expect(meta).toMatchObject({ status: 413 });
  });

  it('rejects and removes what it wrote when the client goes away in the middle of a part', async () => {
    const boundary = 'cut-short';
    const meta = JSON.stringify({
      kind: 'resource',
      name: 'Long take',
      resource: { kind: 'video', role: 'source', name: 'take.mp4' },
    });
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="payload"; filename="take.mp4"\r\n` +
        'Content-Type: video/mp4\r\n\r\n',
    );
    const target = new URL(url);
    // 2 MiB of a body announced as 8 MiB, then the socket is gone
    await new Promise<void>((resolve) => {
      const req = request({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(head.length + 8 * 1024 * 1024),
        },
      });
      req.on('error', () => undefined);
      req.write(head);
      req.write(Buffer.alloc(2 * 1024 * 1024, 1), () =>
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 200),
      );
    });
    await vi.waitFor(() => expect(outcome).toMatch(/^rejected/), { timeout: 3000, interval: 50 });
    expect(await readdir(tmp)).toEqual([]);
  });
});

describe('what rideo reads of a unit file and a thumbnail', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await tmpDir();
  });
  const header = async (bytes: Buffer) => {
    const p = join(dir, `${newId('job')}.bin`);
    await writeFile(p, bytes);
    return readDeskUnitHeader(p, bytes.length);
  };
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (err: AppError) => `${err.status} ${(err.errors as { reason?: string }[])[0]?.reason}`,
    );

  it('reads the prefix and the JSON header, never the body', async () => {
    expect(await header(unitFile('set', 'x'.repeat(1000)))).toEqual({
      format: '3d-editor.desk-unit',
      version: 1,
      kind: 'set',
      name: 'Harbor',
    });
    // gzip as codec is fine: the body is not read
    expect((await header(unitFile('prop', 'body', { codec: 1 }))).kind).toBe('prop');
    // the 3D-Editor's own unit file, as its contract lays it out
    expect(await header(editorUnit())).toEqual({
      format: '3d-editor.desk-unit',
      version: 1,
      kind: 'prop',
      name: 'Red kite',
    });
  });

  it('refuses what is not a unit file', async () => {
    expect(await refusal(header(unitFile('set', 'b', { magic: Buffer.from('GLTFDATA') })))).toBe('422 unit');
    expect(await refusal(header(unitFile('set', 'b', { container: 2 })))).toBe('422 unit');
    expect(await refusal(header(unitFile('set', 'b', { codec: 7 })))).toBe('422 unit');
    expect(await refusal(header(unitFile('set', 'b', { header: '{"format": ' })))).toBe('422 unit');
    expect(await refusal(header(unitFile('set', 'b', { header: { version: 1, kind: 'set' } })))).toBe(
      '422 unit',
    );
    expect(await refusal(header(unitFile('set', '', { length: 70_000 })))).toBe('422 unit');
    expect(await refusal(header(unitFile('set', '', { length: 5000 })))).toBe('422 unit');
    // the refusal says why, the header's length counted with its noun (docs/brand.md#voice)
    await expect(header(unitFile('set', 'b', { length: 1 }))).rejects.toThrow(
      'not a 3D unit file: its header of 1 byte is not 2 bytes to 64 KiB',
    );
    expect(await refusal(header(Buffer.from('3DUNIT')))).toBe('422 unit');
    // what the 3D-Editor's contract adds (docs/embedding.md, "The unit file"): bytes 10 and 11 both 0, a UTF-8 header
    // naming a kind of the three and a name of 1–120 characters
    const withByte = (i: number) => {
      const b = editorUnit();
      b[i] = 1;
      return b;
    };
    expect(await refusal(header(withByte(10)))).toBe('422 unit');
    expect(await refusal(header(withByte(11)))).toBe('422 unit');
    const named = (name: unknown) => ({ format: '3d-editor.desk-unit', version: 1, kind: 'set', name });
    expect(await refusal(header(unitFile('set', 'b', { header: named(undefined) })))).toBe('422 unit');
    expect(await refusal(header(unitFile('set', 'b', { header: named('') })))).toBe('422 unit');
    expect(await refusal(header(unitFile('set', 'b', { header: named('k'.repeat(121)) })))).toBe('422 unit');
    expect(await refusal(header(unitFile('tree', 'b')))).toBe('422 unit');
    // a name written in Latin-1, not UTF-8
    const latin1 = Buffer.from(JSON.stringify(named('Caf_')));
    latin1[latin1.indexOf('_')] = 0xe9;
    expect(await refusal(header(unitFile('set', 'b', { header: latin1 })))).toBe('422 unit');
  });

  it('reads a PNG size from its IHDR and nothing else', () => {
    expect(pngSize(png(256, 128))).toEqual({ width: 256, height: 128 });
    expect(pngSize(Buffer.from('GIF89a...........................'))).toBeNull();
    expect(pngSize(png(0, 10))).toBeNull();
  });

  it('knows a raster picture by its signature, whatever it is called', () => {
    const bytes = (text: string) => Buffer.from(text, 'latin1');
    expect([
      rasterImageMime(png(4, 4)),
      rasterImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])),
      rasterImageMime(bytes('RIFF\x10\x00\x00\x00WEBPVP8 ')),
      rasterImageMime(bytes('GIF89a\x01\x00\x01\x00')),
      rasterImageMime(bytes('BM\x46\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00')),
      rasterImageMime(bytes('II*\x00\x08\x00\x00\x00')),
      rasterImageMime(bytes('MM\x00*\x00\x00\x00\x08')),
    ]).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/bmp',
      'image/tiff',
      'image/tiff',
    ]);
    const pages = [
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      '\ufeff<svg/>',
      '<!doctype html><p>',
      'RIFF\x10\x00\x00\x00AVI LIST',
      'BM',
      '',
    ];
    expect(pages.map((p) => rasterImageMime(Buffer.from(p)))).toEqual(pages.map(() => null));
  });

  it('takes a video or an audio type as one type of its kind, parameters dropped', () => {
    expect([
      mediaResourceMime('video', 'video/mp4'),
      mediaResourceMime('video', ' Video/MP4 ; codecs="avc1.42E01E, mp4a.40.2"'),
      mediaResourceMime('video', 'video/x-matroska'),
      mediaResourceMime('audio', 'audio/mpeg;rate=44100'),
      mediaResourceMime('audio', 'audio/vnd.wave'),
    ]).toEqual(['video/mp4', 'video/mp4', 'video/x-matroska', 'audio/mpeg', 'audio/vnd.wave']);
    const refused: ['video' | 'audio', string][] = [
      ['video', 'video/mp4, text/html'],
      ['video', 'video/mp4,text/html'],
      ['video', 'video/mp4 text/html'],
      ['video', 'video/"mp4"'],
      ['video', 'video/'],
      ['video', 'video'],
      ['video', '/mp4'],
      ['video', 'text/html'],
      ['video', 'audio/mpeg'],
      ['video', 'image/svg+xml'],
      ['video', ''],
      ['audio', 'audio/*'],
      ['audio', `audio/${'a'.repeat(128)}`],
    ];
    expect(refused.map(([kind, mime]) => mediaResourceMime(kind, mime))).toEqual(refused.map(() => null));
  });

  it('answers byte ranges as HTTP does', () => {
    expect(byteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(byteRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(byteRange('items=0-1', 100)).toBeNull();
    expect(byteRange(undefined, 100)).toBeNull();
  });
});

describe('the service checks an upload', () => {
  let studio: Studio;
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir();
    const config = loadConfig({
      RIDEO_DATA_DIR: dir,
      RIDEO_STORAGE: 'embedded',
      NODE_ENV: 'test',
      RIDEO_WATERMARK_KEY: 'unit-test-key',
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
    studio = createStudio(config, { log, storage: new MemoryBackend() });
    await studio.deps.accounts.init();
  });
  afterEach(async () => {
    await studio.stop().catch(() => undefined);
  });
  const upload = async (
    meta: Record<string, unknown>,
    bytes: Buffer,
    thumb?: Buffer,
  ): Promise<LibraryUploadFiles> => {
    const p = join(dir, `${newId('job')}.bin`);
    await writeFile(p, bytes);
    let thumbnail: LibraryUploadFiles['thumbnail'] = null;
    if (thumb) {
      const t = join(dir, `${newId('job')}.png`);
      await writeFile(t, thumb);
      thumbnail = { path: t, size: thumb.length, mime: 'image/png' };
    }
    return {
      meta: LibraryUploadMetaSchema.parse(meta),
      payload: { path: p, size: bytes.length, filename: 'u.bin', mime: 'application/octet-stream' },
      thumbnail,
    };
  };
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (err: AppError) => `${err.status} ${(err.errors as { reason?: string }[])[0]?.reason ?? err.code}`,
    );
  const actor = { kind: 'user' as const, id: 'local', name: 'You' };

  it('refuses a file of another kind, format or version than the meta declares, counted as refused', async () => {
    const lib = studio.library;
    expect(await outcome(lib.create(actor, await upload(setMeta(), unitFile('prop'))))).toBe('422 kind');
    expect(
      await outcome(
        lib.create(
          actor,
          await upload(
            setMeta(),
            unitFile('set', 'b', { header: { format: 'other', version: 1, kind: 'set' } }),
          ),
        ),
      ),
    ).toBe('422 unit');
    expect(
      await outcome(
        lib.create(
          actor,
          await upload(
            setMeta(),
            unitFile('set', 'b', { header: { format: '3d-editor.desk-unit', version: 2, kind: 'set' } }),
          ),
        ),
      ),
    ).toBe('422 unit');
    expect(
      await outcome(lib.create(actor, await upload(setMeta(), Buffer.from('not a unit at all, no')))),
    ).toBe('422 unit');
    expect(studio.deps.metrics.library.get({ event: 'refused', kind: 'desk-set' })).toBe(4);
    expect((await lib.list({ archived: false, sort: 'updated', limit: 100 })).items).toEqual([]);
  });

  it("keeps the 3D-Editor's own unit file as a desk-prop under its sha256, and no version but 1", async () => {
    const lib = studio.library;
    const propMeta = (formatVersion: number) => ({
      kind: 'desk-prop',
      name: 'Red kite',
      unit: { format: '3d-editor.desk-unit', formatVersion, meta: META },
    });
    const bytes = editorUnit();
    const out = await lib.create(actor, await upload(propMeta(1), bytes));
    const snap = out.version.payload as { format: string; formatVersion: number; payload: { hash: string } };
    expect([out.item.kind, snap.format, snap.formatVersion, snap.payload.hash, out.version.digest]).toEqual([
      'desk-prop',
      '3d-editor.desk-unit',
      1,
      '839114263baa77e854f16ee63db032f7b01f0a2a7b1f103a6e732dc9732ef16c',
      '839114263baa77e854f16ee63db032f7b01f0a2a7b1f103a6e732dc9732ef16c',
    ]);
    // the contract lays out version 1: a header and meta that agree on another version are not kept either
    const v3 = unitFile('prop', 'b', {
      header: { format: '3d-editor.desk-unit', version: 3, kind: 'prop', name: 'K' },
    });
    expect(await outcome(lib.create(actor, await upload(propMeta(3), v3)))).toBe('422 unit');
  });

  it('keeps a PNG thumbnail of at most 256 px and refuses other pictures', async () => {
    const lib = studio.library;
    expect(
      await outcome(
        lib.create(actor, await upload(setMeta(), unitFile('set'), Buffer.from('GIF89a, not a png at all'))),
      ),
    ).toBe('422 thumbnail');
    expect(await outcome(lib.create(actor, await upload(setMeta(), unitFile('set'), png(257, 100))))).toBe(
      '422 thumbnail',
    );
    const ok = await lib.create(actor, await upload(setMeta(), unitFile('set'), png(256, 144)));
    expect(ok.item.thumbnail).toEqual({
      version: 1,
      hash: ok.version.thumbnail!.hash,
      mime: 'image/png',
      width: 256,
      height: 144,
    });
    expect((await lib.fileInfo(ok.item.id, 1, ok.version.thumbnail!.hash)).mime).toBe('image/png');
  });

  it('keeps a video or an audio resource only under one type of its kind, without its parameters', async () => {
    const lib = studio.library;
    const resource = async (kind: 'video' | 'audio', mime: string) => {
      const u = await upload(
        { kind: 'resource', name: 'Take', resource: { kind, role: 'reference', name: 'take' } },
        Buffer.from(`${kind} bytes, not decoded here`),
      );
      return { ...u, payload: { ...u.payload, mime } };
    };
    // a list is read by a browser as its last type: `text/html` here
    const refused = [
      ['video', 'video/mp4, text/html'],
      ['video', 'video/mp4,text/html'],
      ['video', 'text/html'],
      ['video', 'audio/mpeg'],
      ['video', 'video/'],
      ['video', 'video/mp4 text/html'],
      ['video', 'application/octet-stream'],
      ['audio', 'audio/mpeg, image/svg+xml'],
      ['audio', 'video/mp4'],
    ] as const;
    for (const [kind, mime] of refused)
      expect(`${mime}: ${await outcome(lib.create(actor, await resource(kind, mime)))}`).toBe(
        `${mime}: 422 payload`,
      );
    expect(studio.deps.metrics.library.get({ event: 'refused', kind: 'resource' })).toBe(refused.length);
    expect((await lib.list({ archived: false, sort: 'updated', limit: 100 })).items).toEqual([]);
    // the refusal names the kind with the article it is read with
    const refusal = async (kind: 'video' | 'audio', mime: string) =>
      lib.create(actor, await resource(kind, mime)).then(
        () => 'ok',
        (err: AppError) => err.message,
      );
    expect(await refusal('audio', 'video/mp4')).toBe(
      'an audio resource has one audio/… type, not "video/mp4"',
    );
    expect(await refusal('video', 'audio/mpeg')).toBe(
      'a video resource has one video/… type, not "audio/mpeg"',
    );

    const kept = async (kind: 'video' | 'audio', mime: string) => {
      const out = await lib.create(actor, await resource(kind, mime));
      const media = (out.version.payload as { media: { hash: string; mime: string } }).media;
      return [media.mime, (await lib.fileInfo(out.item.id, 1, media.hash)).mime];
    };
    expect(await kept('video', 'Video/MP4; codecs="avc1.42E01E"')).toEqual(['video/mp4', 'video/mp4']);
    expect(await kept('video', 'video/vnd.dlna.mpeg-tts')).toEqual([
      'video/vnd.dlna.mpeg-tts',
      'video/vnd.dlna.mpeg-tts',
    ]);
    expect(await kept('audio', 'audio/mpeg')).toEqual(['audio/mpeg', 'audio/mpeg']);
  });
});

import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from '../../src/metrics';
import { StorageError, WebDavBackend } from '../../src/storage/webdav';
import { type FlakyDav, startFlakyDav } from '../helpers/flaky-dav';

/** Slow and flaky WebDAV servers (docs/design/storage-webdav.md#slow-and-flaky-servers). */

let dav: FlakyDav;
let metrics: Metrics;
let storage: WebDavBackend;
const warn = vi.fn();

beforeAll(async () => {
  dav = await startFlakyDav();
});
afterAll(async () => {
  await dav?.close();
});
beforeEach(() => {
  dav.reset();
  metrics = new Metrics();
  warn.mockReset();
  storage = new WebDavBackend({
    url: dav.url,
    metrics,
    log: { warn },
    retry: { retries: 3, baseMs: 5, maxMs: 20 },
  });
});

const base = () => `/t-${Math.random().toString(36).slice(2, 10)}`;

describe('WebDAV retries', () => {
  it('tries busy, locked and failing answers and dropped connections again', async () => {
    const dir = base();
    dav.fail('PUT', /doc\.json$/, { status: 423 }, 2);
    await storage.write(`${dir}/doc.json`, '{"v":1}');
    dav.fail('GET', /doc\.json$/, { status: 503 }, 1);
    dav.fail('GET', /doc\.json$/, 'drop', 1);
    expect((await storage.read(`${dir}/doc.json`))!.toString()).toBe('{"v":1}');
    dav.fail('PROPFIND', /doc\.json$/, { status: 502 }, 1);
    expect(await storage.stat(`${dir}/doc.json`)).toMatchObject({ size: 7, isDir: false });
    dav.fail('PROPFIND', new RegExp(`${dir}/?$`), { status: 500 }, 1);
    expect((await storage.list(dir)).map((e) => e.name)).toEqual(['doc.json']);
    expect(metrics.storageRetries.get({ op: 'write', reason: '423' })).toBe(2);
    expect(metrics.storageRetries.get({ op: 'read', reason: '503' })).toBe(1);
    expect(metrics.storageRetries.get({ op: 'read', reason: 'ECONNRESET' })).toBe(1);
    expect(metrics.storageRetries.get({ op: 'stat', reason: '502' })).toBe(1);
    expect(metrics.storageRetries.get({ op: 'list', reason: '500' })).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives up after its retries, says so, and fails as before', async () => {
    const dir = base();
    await storage.write(`${dir}/doc.json`, 'x');
    dav.fail('GET', /doc\.json$/, { status: 500 }, 10);
    await expect(storage.read(`${dir}/doc.json`)).rejects.toBeInstanceOf(StorageError);
    expect(metrics.storageRetries.get({ op: 'read', reason: '500' })).toBe(3);
    expect(warn).toHaveBeenCalledWith(
      { op: 'read', path: `${dir}/doc.json`, reason: '500', tries: 4 },
      'WebDAV request kept failing',
    );
  });

  it('repeats a conditional write or a stream only when the server did not apply it', async () => {
    const dir = base();
    dav.fail('PUT', /cond\.json$/, { status: 500 }, 1);
    await expect(storage.write(`${dir}/cond.json`, 'x', { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
      StorageError,
    );
    dav.fail('PUT', /cond\.json$/, { status: 503 }, 1);
    await storage.write(`${dir}/cond.json`, 'x', { ifNoneMatch: '*' });
    expect(metrics.storageRetries.get({ op: 'write', reason: '503' })).toBe(1);
    dav.fail('PUT', /stream\.bin$/, { status: 503 }, 1);
    await expect(
      storage.write(`${dir}/stream.bin`, Readable.from([Buffer.from('abc')]), { size: 3 }),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('writes a file again after a 405, which a busy server answers to a PUT', async () => {
    const dir = base();
    dav.fail('PUT', /job\.json$/, { status: 405 }, 1);
    await storage.write(`${dir}/job.json`, '{"ok":true}');
    expect((await storage.read(`${dir}/job.json`))!.toString()).toBe('{"ok":true}');
    expect(metrics.storageRetries.get({ op: 'write', reason: '405' })).toBe(1);
    // A read that is not allowed is not tried again
    dav.fail('GET', /job\.json$/, { status: 405 }, 1);
    await expect(storage.read(`${dir}/job.json`)).rejects.toBeInstanceOf(StorageError);
    expect(metrics.storageRetries.get({ op: 'read', reason: '405' })).toBe(0);
  });

  it('honours Retry-After', async () => {
    const dir = base();
    await storage.write(`${dir}/doc.json`, 'x');
    dav.fail('GET', /doc\.json$/, { status: 429, headers: { 'retry-after': '1' } }, 1);
    const started = Date.now();
    await storage.read(`${dir}/doc.json`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });
});

describe('false 404s', () => {
  it('tries a 404 again for a file it wrote, and believes one for a file it never saw or deleted', async () => {
    const dir = base();
    await storage.write(`${dir}/known.json`, 'k');
    dav.fail('GET', /known\.json$/, { status: 404 }, 1);
    expect((await storage.read(`${dir}/known.json`))!.toString()).toBe('k');
    dav.fail('PROPFIND', /known\.json$/, { status: 404 }, 2);
    expect(await storage.stat(`${dir}/known.json`)).toMatchObject({ size: 1 });
    expect(metrics.storageRetries.get({ op: 'read', reason: 'missing' })).toBe(1);
    expect(metrics.storageRetries.get({ op: 'stat', reason: 'missing' })).toBe(2);

    const before = dav.seen.GET ?? 0;
    expect(await storage.read(`${dir}/never.json`)).toBeNull();
    expect((dav.seen.GET ?? 0) - before).toBe(1);

    await storage.delete(`${dir}/known.json`);
    const again = dav.seen.GET ?? 0;
    expect(await storage.read(`${dir}/known.json`)).toBeNull();
    expect((dav.seen.GET ?? 0) - again).toBe(1);

    // gone for good: believed after the retries, and not retried the next time
    await storage.write(`${dir}/gone.json`, 'g');
    dav.fail('GET', /gone\.json$/, { status: 404 }, 10);
    expect(await storage.read(`${dir}/gone.json`)).toBeNull();
    const next = dav.seen.GET ?? 0;
    expect(await storage.read(`${dir}/gone.json`)).toBeNull();
    expect((dav.seen.GET ?? 0) - next).toBe(1);
  });

  it('writes into a new folder with one MKCOL per level, however many writes at once', async () => {
    const dir = base();
    const before = dav.seen.MKCOL ?? 0;
    await Promise.all(Array.from({ length: 6 }, (_, i) => storage.write(`${dir}/a/b/f${i}.json`, String(i))));
    expect((dav.seen.MKCOL ?? 0) - before).toBe(3);
    expect((await storage.list(`${dir}/a/b`)).length).toBe(6);
  });
});

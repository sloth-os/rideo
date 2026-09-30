import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StorageBackend } from '../../src/storage/backend';
import { createEmbeddedDav } from '../../src/storage/embedded-dav';
import { MemoryBackend } from '../../src/storage/memory';
import { WebDavBackend } from '../../src/storage/webdav';

let server: Server;
let dir: string;
const backends: [string, () => StorageBackend][] = [['memory', () => new MemoryBackend()]];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rideo-dav-'));
  const dav = createEmbeddedDav({ root: dir });
  server = createServer((req, res) =>
    dav.matches(req.url) ? dav.handle(req, res) : res.writeHead(404).end(),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dav`;
  backends.push(['embedded webdav', () => new WebDavBackend({ url })]);
});
afterAll(async () => {
  server?.close();
  await rm(dir, { recursive: true, force: true });
});

// e.g. http://user:pass@localhost:8080/ — fetch rejects credentials in URLs, so pass them separately
const external = process.env.RIDEO_TEST_WEBDAV_URL;
if (external) {
  const u = new URL(external);
  const username = decodeURIComponent(u.username) || undefined;
  const password = decodeURIComponent(u.password) || undefined;
  u.username = '';
  u.password = '';
  backends.push(['external webdav', () => new WebDavBackend({ url: u.toString(), username, password })]);
}

describe.each([0, 1, 2])('storage conformance #%s', (i) => {
  it('satisfies the backend contract', async () => {
    const entry = backends[i];
    if (!entry) return;
    const [, make] = entry;
    const s = make();
    const base = `/conformance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    expect(await s.read(`${base}/missing.json`)).toBeNull();
    expect(await s.stat(`${base}/missing.json`)).toBeNull();
    await s.write(`${base}/a/b/c/doc.json`, '{"ok":true}', { contentType: 'application/json' });
    expect((await s.read(`${base}/a/b/c/doc.json`))!.toString()).toBe('{"ok":true}');
    const st = await s.stat(`${base}/a/b/c/doc.json`);
    expect(st).toMatchObject({ size: 11, isDir: false });
    expect((await s.stat(`${base}/a/b`))?.isDir).toBe(true);
    const big = Buffer.alloc(200_000, 7);
    await s.write(`${base}/media/big.bin`, Readable.from([big]), { size: big.length });
    const range = await s.readStream(`${base}/media/big.bin`, { start: 10, end: 19 });
    const chunks: Buffer[] = [];
    for await (const c of range!.stream) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).length).toBe(10);
    expect(range!.size).toBe(200_000);
    expect((await s.list(`${base}/a/b/c`)).map((e) => e.name)).toEqual(['doc.json']);
    expect(await s.list(`${base}/nope`)).toEqual([]);
    await s.move(`${base}/a/b/c/doc.json`, `${base}/moved/doc.json`);
    expect(await s.read(`${base}/a/b/c/doc.json`)).toBeNull();
    expect(await s.read(`${base}/moved/doc.json`)).not.toBeNull();
    await s.delete(`${base}/moved`);
    expect(await s.stat(`${base}/moved/doc.json`)).toBeNull();
    const caps = await s.capabilities();
    expect(typeof caps.conditionalWrites).toBe('boolean');
    await s.delete(base);
  });
});

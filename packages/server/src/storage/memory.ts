import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  type Entry,
  joinPath,
  PreconditionFailedError,
  type ReadResult,
  type Stat,
  type StorageBackend,
  type WriteOptions,
} from './backend';

interface FileRec {
  data: Buffer;
  etag: string;
  mtime: number;
}

async function toBuffer(data: Buffer | string | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data);
  const chunks: Buffer[] = [];
  for await (const c of data) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** In-memory backend with WebDAV semantics (including conditional writes) for unit tests. */
export class MemoryBackend implements StorageBackend {
  readonly kind = 'memory' as const;
  readonly files = new Map<string, FileRec>();
  ops = 0;

  private norm(path: string): string {
    return joinPath(path).replace(/\/+$/, '') || '/';
  }

  async read(path: string): Promise<Buffer | null> {
    this.ops++;
    return this.files.get(this.norm(path))?.data ?? null;
  }

  async readStream(path: string, range?: { start: number; end?: number }): Promise<ReadResult | null> {
    const f = this.files.get(this.norm(path));
    if (!f) return null;
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? f.data.length - 1, f.data.length - 1);
    return { stream: Readable.from([f.data.subarray(start, end + 1)]), size: f.data.length, start, end };
  }

  async write(
    path: string,
    data: Buffer | string | Readable,
    opts: WriteOptions = {},
  ): Promise<{ etag?: string }> {
    this.ops++;
    const p = this.norm(path);
    const existing = this.files.get(p);
    if (opts.ifNoneMatch === '*' && existing) throw new PreconditionFailedError(p);
    if (opts.ifMatch && existing?.etag !== opts.ifMatch) throw new PreconditionFailedError(p);
    const buf = await toBuffer(data);
    const etag = `"${createHash('md5').update(buf).digest('hex')}"`;
    this.files.set(p, { data: buf, etag, mtime: Date.now() });
    return { etag };
  }

  async stat(path: string): Promise<Stat | null> {
    this.ops++;
    const p = this.norm(path);
    const f = this.files.get(p);
    if (f) return { size: f.data.length, etag: f.etag, mtime: f.mtime, isDir: false };
    const prefix = `${p === '/' ? '' : p}/`;
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return { size: 0, mtime: 0, isDir: true };
    return null;
  }

  async list(dir: string): Promise<Entry[]> {
    this.ops++;
    const p = this.norm(dir);
    const prefix = `${p === '/' ? '' : p}/`;
    const out = new Map<string, Entry>();
    for (const [k, f] of this.files) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const [name, ...more] = rest.split('/');
      if (!name) continue;
      if (more.length === 0)
        out.set(name, { name, path: k, size: f.data.length, etag: f.etag, mtime: f.mtime, isDir: false });
      else if (!out.has(name))
        out.set(name, { name, path: `${prefix}${name}`, size: 0, mtime: 0, isDir: true });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(path: string): Promise<void> {
    this.ops++;
    const p = this.norm(path);
    this.files.delete(p);
    const prefix = `${p}/`;
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }

  async move(from: string, to: string): Promise<void> {
    const f = this.norm(from);
    const t = this.norm(to);
    for (const [k, v] of [...this.files]) {
      if (k === f || k.startsWith(`${f}/`)) {
        this.files.delete(k);
        this.files.set(t + k.slice(f.length), v);
      }
    }
  }

  async capabilities() {
    return { conditionalWrites: true };
  }
}

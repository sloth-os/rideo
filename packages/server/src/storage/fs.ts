import { createReadStream, createWriteStream } from 'node:fs';
import { stat as fsStat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomHex } from '../util/crypto';
import { KeyedMutex } from '../util/mutex';
import {
  type Entry,
  joinPath,
  PreconditionFailedError,
  type ReadResult,
  type Stat,
  type StorageBackend,
  type WriteOptions,
} from './backend';

/**
 * A StorageBackend over a local directory (docs/design/browser-storage.md#fsbackend): the studio-wide data when
 * projects live in browsers. Writes go to a temporary file and are renamed into place; conditional writes are checked
 * under an in-process lock per path (etag = size and mtime).
 */
export class FsBackend implements StorageBackend {
  readonly kind = 'fs' as const;
  private readonly locks = new KeyedMutex();

  constructor(readonly root: string) {}

  private local(path: string): string {
    const rel = joinPath(path).replace(/^\/+/, '');
    const full = resolve(this.root, rel);
    if (full !== resolve(this.root) && !full.startsWith(resolve(this.root) + sep))
      throw new Error(`path escapes the store: ${path}`);
    return full;
  }

  private static etag(size: number, mtimeMs: number): string {
    return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
  }

  async read(path: string): Promise<Buffer | null> {
    try {
      return await readFile(this.local(path));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async readStream(path: string, range?: { start: number; end?: number }): Promise<ReadResult | null> {
    const file = this.local(path);
    const info = await fsStat(file).catch((err) => (isMissing(err) ? null : Promise.reject(err)));
    if (!info || info.isDirectory()) return null;
    const start = Math.min(range?.start ?? 0, Math.max(0, info.size - 1));
    const end = Math.min(range?.end ?? info.size - 1, info.size - 1);
    const stream = info.size === 0 ? Readable.from([]) : createReadStream(file, { start, end });
    return { stream, size: info.size, start, end };
  }

  async write(
    path: string,
    data: Buffer | string | Readable,
    opts: WriteOptions = {},
  ): Promise<{ etag?: string }> {
    const file = this.local(path);
    return this.locks.run(file, async () => {
      if (opts.ifNoneMatch === '*' || opts.ifMatch) {
        const cur = await this.stat(path);
        if (opts.ifNoneMatch === '*' && cur) throw new PreconditionFailedError(path);
        if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new PreconditionFailedError(path);
      }
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${randomHex(4)}.part`;
      try {
        if (Buffer.isBuffer(data) || typeof data === 'string') await writeFile(tmp, data);
        else await pipeline(data, createWriteStream(tmp));
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      const info = await fsStat(file);
      return { etag: FsBackend.etag(info.size, info.mtimeMs) };
    });
  }

  async stat(path: string): Promise<Stat | null> {
    const info = await fsStat(this.local(path)).catch((err) => (isMissing(err) ? null : Promise.reject(err)));
    if (!info) return null;
    return info.isDirectory()
      ? { size: 0, mtime: info.mtimeMs, isDir: true }
      : { size: info.size, etag: FsBackend.etag(info.size, info.mtimeMs), mtime: info.mtimeMs, isDir: false };
  }

  async list(dir: string): Promise<Entry[]> {
    const base = joinPath(dir).replace(/\/+$/, '') || '/';
    let names: string[];
    try {
      names = await readdir(this.local(base));
    } catch (err) {
      if (isMissing(err) || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
      throw err;
    }
    const out: Entry[] = [];
    for (const name of names.sort()) {
      if (name.endsWith('.part')) continue;
      const path = joinPath(base, name);
      const s = await this.stat(path);
      if (s) out.push({ ...s, name, path });
    }
    return out;
  }

  async delete(path: string): Promise<void> {
    await rm(this.local(path), { recursive: true, force: true });
  }

  async move(from: string, to: string): Promise<void> {
    const target = this.local(to);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.local(from), target);
  }

  async capabilities() {
    return { conditionalWrites: true };
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** The directory an FsBackend for the embedded store uses: the same one the built-in WebDAV server serves. */
export function embeddedStoreDir(dataDir: string): string {
  return join(dataDir, 'dav');
}

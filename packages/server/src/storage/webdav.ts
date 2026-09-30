import type { Readable } from 'node:stream';
import { createClient, type FileStat, type WebDAVClient } from 'webdav';
import type { Metrics } from '../metrics';
import {
  type Entry,
  joinPath,
  PreconditionFailedError,
  parentOf,
  type ReadResult,
  type Stat,
  type StorageBackend,
  type WriteOptions,
} from './backend';

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}

function toStat(s: FileStat): Stat {
  return {
    size: s.size ?? 0,
    etag: s.etag ?? undefined,
    mtime: s.lastmod ? Date.parse(s.lastmod) : 0,
    isDir: s.type === 'directory',
  };
}

export class StorageError extends Error {
  readonly code = 'storage_error';
  readonly retryable = true;
}

/** Production backend: any WebDAV server (external or the embedded /dav). */
export class WebDavBackend implements StorageBackend {
  readonly kind = 'webdav' as const;
  private clientInstance?: WebDAVClient;
  private readonly knownDirs = new Set<string>(['/']);
  private caps?: Promise<{ conditionalWrites: boolean }>;

  /** `url` may be a function: the embedded /dav server's port is only known after listen. */
  constructor(
    private readonly opts: {
      url: string | (() => string);
      username?: string;
      password?: string;
      metrics?: Metrics;
    },
  ) {}

  private get client(): WebDAVClient {
    this.clientInstance ??= createClient(
      typeof this.opts.url === 'function' ? this.opts.url() : this.opts.url,
      {
        username: this.opts.username,
        password: this.opts.password,
        maxBodyLength: Number.POSITIVE_INFINITY,
        maxContentLength: Number.POSITIVE_INFINITY,
      },
    );
    return this.clientInstance;
  }

  private async timed<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.opts.metrics?.storageLatency.observe({ op }, (performance.now() - start) / 1000);
    }
  }

  private wrap(op: string, path: string, err: unknown): never {
    if (err instanceof PreconditionFailedError) throw err;
    throw new StorageError(
      `WebDAV ${op} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  async read(path: string): Promise<Buffer | null> {
    return this.timed('read', async () => {
      try {
        const data = await this.client.getFileContents(joinPath(path), { format: 'binary' });
        return Buffer.from(data as ArrayBuffer);
      } catch (err) {
        if (statusOf(err) === 404) return null;
        this.wrap('GET', path, err);
      }
    });
  }

  async readStream(path: string, range?: { start: number; end?: number }): Promise<ReadResult | null> {
    const st = await this.stat(path);
    if (!st || st.isDir) return null;
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? st.size - 1, st.size - 1);
    const stream = this.client.createReadStream(
      joinPath(path),
      range ? { range: { start, end } } : undefined,
    );
    return { stream: stream as unknown as Readable, size: st.size, start, end };
  }

  async ensureDir(dir: string): Promise<void> {
    const d = joinPath(dir).replace(/\/+$/, '') || '/';
    if (this.knownDirs.has(d)) return;
    const parent = parentOf(d);
    if (!this.knownDirs.has(parent)) await this.ensureDir(parent);
    try {
      await this.client.createDirectory(d);
    } catch (err) {
      const status = statusOf(err);
      // 405: already exists (RFC 4918); some servers answer 409/301 for existing collections.
      if (status !== 405 && status !== 301) {
        const st = await this.stat(d).catch(() => null);
        if (!st?.isDir) this.wrap('MKCOL', d, err);
      }
    }
    this.knownDirs.add(d);
  }

  async write(
    path: string,
    data: Buffer | string | Readable,
    opts: WriteOptions = {},
  ): Promise<{ etag?: string }> {
    return this.timed('write', async () => {
      const p = joinPath(path);
      await this.ensureDir(parentOf(p));
      const headers: Record<string, string> = {};
      if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
      if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
      if (opts.contentType) headers['Content-Type'] = opts.contentType;
      try {
        await this.client.putFileContents(p, data as Buffer, {
          overwrite: true,
          headers,
          ...(opts.size !== undefined
            ? { contentLength: opts.size }
            : typeof data === 'string' || Buffer.isBuffer(data)
              ? {}
              : { contentLength: false }),
        });
      } catch (err) {
        if (statusOf(err) === 412) throw new PreconditionFailedError(p);
        this.wrap('PUT', p, err);
      }
      return {};
    });
  }

  async stat(path: string): Promise<Stat | null> {
    return this.timed('stat', async () => {
      try {
        const s = (await this.client.stat(joinPath(path))) as FileStat;
        return toStat(s);
      } catch (err) {
        if (statusOf(err) === 404) return null;
        this.wrap('PROPFIND', path, err);
      }
    });
  }

  async list(dir: string): Promise<Entry[]> {
    return this.timed('list', async () => {
      try {
        const items = (await this.client.getDirectoryContents(joinPath(dir))) as FileStat[];
        return items
          .map((s) => ({ ...toStat(s), name: s.basename, path: s.filename }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        if (statusOf(err) === 404) return [];
        this.wrap('PROPFIND', dir, err);
      }
    });
  }

  async delete(path: string): Promise<void> {
    await this.timed('delete', async () => {
      try {
        await this.client.deleteFile(joinPath(path));
      } catch (err) {
        if (statusOf(err) === 404) return;
        this.wrap('DELETE', path, err);
      }
    });
    for (const d of [...this.knownDirs])
      if (d === joinPath(path) || d.startsWith(`${joinPath(path)}/`)) this.knownDirs.delete(d);
  }

  async move(from: string, to: string): Promise<void> {
    await this.ensureDir(parentOf(joinPath(to)));
    try {
      await this.client.moveFile(joinPath(from), joinPath(to));
    } catch (err) {
      this.wrap('MOVE', from, err);
    }
  }

  /** Probes conditional-write support once (If-None-Match: * twice; a 412 means preconditions work). */
  capabilities(): Promise<{ conditionalWrites: boolean }> {
    this.caps ??= (async () => {
      const probe = `/.rideo-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        await this.client.putFileContents(probe, 'probe', { overwrite: true });
        try {
          await this.client.putFileContents(probe, 'probe', { headers: { 'If-None-Match': '*' } });
          return { conditionalWrites: false };
        } catch (err) {
          return { conditionalWrites: statusOf(err) === 412 };
        }
      } catch {
        return { conditionalWrites: false };
      } finally {
        await this.client.deleteFile(probe).catch(() => undefined);
      }
    })();
    return this.caps;
  }
}

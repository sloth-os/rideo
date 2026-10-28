import { PassThrough, type Readable } from 'node:stream';
import { createClient, type FileStat, type WebDAVClient } from 'webdav';
import type { Metrics } from '../metrics';
import { sleep } from '../util/abort';
import { countStorageOp } from '../util/request-context';
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

/** How a request is retried (docs/design/storage-webdav.md#slow-and-flaky-servers). */
export interface RetryPolicy {
  /** Tries after the first one (0: none). */
  retries: number;
  /** The first wait; it doubles with every try, up to `maxMs`, with jitter. */
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 4, baseMs: 250, maxMs: 4000 };

/** Answers worth another try: the server is busy, locked, overloaded or failed on its side. */
const TRANSIENT_STATUS = new Set([423, 429, 500, 502, 503, 504]);
/** Answers that say the server did not apply the request: even a conditional write or a MOVE may go again. */
const NOT_APPLIED_STATUS = new Set([423, 429, 503]);
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
/** Files believed to exist (written or read by this process and not deleted since), at most this many. */
const PRESENT_MAX = 50_000;
/** The longest `Retry-After` honoured. */
const RETRY_AFTER_MAX_MS = 10_000;

/**
 * A file PUT is never a method a WebDAV server forbids: OpenList answered 405 to job records while it was flooded
 * after a restart (docs/design/storage-webdav.md#slow-and-flaky-servers). It was not applied, so it may go again.
 */
const WRITE_RETRY_STATUS = new Set([405]);

/** Why a failed request is worth another try, or null. */
function transientReason(
  err: unknown,
  replayable: 'always' | 'unapplied',
  extra?: ReadonlySet<number>,
): string | null {
  const status = statusOf(err);
  if (status !== undefined) {
    const set = replayable === 'always' ? TRANSIENT_STATUS : NOT_APPLIED_STATUS;
    return set.has(status) || extra?.has(status) ? String(status) : null;
  }
  if (replayable !== 'always') return null;
  const e = err as { code?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  return code && NETWORK_CODES.has(code) ? code : null;
}

function retryAfterMs(err: unknown): number | null {
  const headers = (err as { response?: { headers?: { get?: (name: string) => string | null } } })?.response
    ?.headers;
  const value = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (!value) return null;
  const sec = Number(value);
  const ms = Number.isFinite(sec) ? sec * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : null;
}

class NotFoundYet extends Error {
  readonly status = 404;
}

/** Production backend: any WebDAV server (external or the embedded /dav). */
export class WebDavBackend implements StorageBackend {
  readonly kind = 'webdav' as const;
  private clientInstance?: WebDAVClient;
  private readonly knownDirs = new Set<string>(['/']);
  private readonly creatingDirs = new Map<string, Promise<void>>();
  private readonly present = new Set<string>();
  private caps?: Promise<{ conditionalWrites: boolean }>;

  /** `url` may be a function: the embedded /dav server's port is only known after listen. */
  constructor(
    private readonly opts: {
      url: string | (() => string);
      username?: string;
      password?: string;
      metrics?: Metrics;
      log?: { warn: (o: unknown, m?: string) => void };
      retry?: RetryPolicy;
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
      const ms = performance.now() - start;
      this.opts.metrics?.storageLatency.observe({ op }, ms / 1000);
      countStorageOp(ms);
    }
  }

  /**
   * Runs a request, trying again after a transient failure (and, for a file believed to exist, after a 404: OpenList
   * answers 404 for files it holds while its upstream is overloaded). `replayable` says which failures may repeat
   * the request: any for idempotent ones, only those the server did not apply for conditional writes and moves.
   */
  private async retrying<T>(
    op: string,
    path: string,
    replayable: 'always' | 'unapplied' | 'never',
    fn: () => Promise<T>,
    /** More answers worth another try for this operation. */
    extra?: ReadonlySet<number>,
  ): Promise<T> {
    const policy = this.opts.retry ?? DEFAULT_RETRY;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const reason =
          err instanceof NotFoundYet
            ? 'missing'
            : replayable === 'never'
              ? null
              : transientReason(err, replayable, extra);
        if (!reason || attempt >= policy.retries) {
          if (reason)
            this.opts.log?.warn({ op, path, reason, tries: attempt + 1 }, 'WebDAV request kept failing');
          throw err;
        }
        this.opts.metrics?.storageRetries.inc({ op, reason });
        const backoff = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt) * (0.5 + Math.random() / 2);
        await sleep(Math.max(backoff, retryAfterMs(err) ?? 0));
      }
    }
  }

  private believe(path: string): void {
    this.present.delete(path);
    this.present.add(path);
    if (this.present.size > PRESENT_MAX) this.present.delete(this.present.values().next().value!);
  }

  private forget(path: string): void {
    for (const p of [...this.present]) if (p === path || p.startsWith(`${path}/`)) this.present.delete(p);
    for (const d of [...this.knownDirs]) if (d === path || d.startsWith(`${path}/`)) this.knownDirs.delete(d);
  }

  /** A 404 for a file believed to exist is tried again (NotFoundYet); else the file is missing. */
  private missing(path: string, err: unknown): boolean {
    if (statusOf(err) !== 404) return false;
    if (this.present.has(path)) throw new NotFoundYet(`${path} not found (yet)`);
    return true;
  }

  private wrap(op: string, path: string, err: unknown): never {
    if (err instanceof PreconditionFailedError) throw err;
    throw new StorageError(
      `WebDAV ${op} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  async read(path: string): Promise<Buffer | null> {
    const p = joinPath(path);
    return this.timed('read', async () => {
      try {
        const buf = await this.retrying('read', p, 'always', async () => {
          try {
            return Buffer.from((await this.client.getFileContents(p, { format: 'binary' })) as ArrayBuffer);
          } catch (err) {
            if (this.missing(p, err)) return null;
            throw err;
          }
        });
        if (buf) this.believe(p);
        else this.present.delete(p);
        return buf;
      } catch (err) {
        if (err instanceof NotFoundYet) {
          this.present.delete(p);
          return null;
        }
        this.wrap('GET', p, err);
      }
    });
  }

  async readStream(path: string, range?: { start: number; end?: number }): Promise<ReadResult | null> {
    const st = await this.stat(path);
    if (!st || st.isDir) return null;
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? st.size - 1, st.size - 1);
    const p = joinPath(path);
    // Tried again until the first byte arrives (docs/design/storage-webdav.md#slow-and-flaky-servers)
    const stream = await this.retrying('read', p, 'always', () =>
      this.openStream(p, range ? { start, end } : undefined),
    );
    return { stream, size: st.size, start, end };
  }

  /** A read stream that has delivered its first chunk (or ended): an error before it can be tried again. */
  private openStream(path: string, range?: { start: number; end: number }): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const source = this.client.createReadStream(path, range ? { range } : undefined) as unknown as Readable;
      const out = new PassThrough();
      const settle = () => {
        source.off('error', onError);
        source.off('data', onData);
        source.off('end', onEnd);
      };
      const onError = (err: Error) => {
        settle();
        source.destroy();
        reject(err);
      };
      const onData = (chunk: Buffer) => {
        source.pause();
        settle();
        out.write(chunk);
        // An error after the first byte ends the response, as before
        source.on('error', (err) => out.destroy(err));
        source.pipe(out);
        resolve(out);
      };
      const onEnd = () => {
        settle();
        out.end();
        resolve(out);
      };
      source.once('error', onError);
      source.once('data', onData);
      source.once('end', onEnd);
    });
  }

  /** Creates a collection and its parents once per process (concurrent callers share one MKCOL). */
  async ensureDir(dir: string): Promise<void> {
    const d = joinPath(dir).replace(/\/+$/, '') || '/';
    if (this.knownDirs.has(d)) return;
    let pending = this.creatingDirs.get(d);
    if (!pending) {
      pending = this.createDir(d).finally(() => this.creatingDirs.delete(d));
      this.creatingDirs.set(d, pending);
    }
    return pending;
  }

  private async createDir(d: string): Promise<void> {
    const parent = parentOf(d);
    if (!this.knownDirs.has(parent)) await this.ensureDir(parent);
    try {
      await this.retrying('mkcol', d, 'always', () => this.client.createDirectory(d));
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
      const buffered = typeof data === 'string' || Buffer.isBuffer(data);
      // A stream cannot be sent twice; a conditional write goes again only when it was not applied
      const replayable = !buffered ? 'never' : opts.ifMatch || opts.ifNoneMatch ? 'unapplied' : 'always';
      try {
        await this.retrying(
          'write',
          p,
          replayable,
          () =>
            this.client.putFileContents(p, data as Buffer, {
              overwrite: true,
              headers,
              ...(opts.size !== undefined
                ? { contentLength: opts.size }
                : buffered
                  ? {}
                  : { contentLength: false }),
            }),
          WRITE_RETRY_STATUS,
        );
      } catch (err) {
        if (statusOf(err) === 412) throw new PreconditionFailedError(p);
        this.wrap('PUT', p, err);
      }
      this.believe(p);
      return {};
    });
  }

  async stat(path: string): Promise<Stat | null> {
    const p = joinPath(path);
    return this.timed('stat', async () => {
      try {
        const st = await this.retrying('stat', p, 'always', async () => {
          try {
            return toStat((await this.client.stat(p)) as FileStat);
          } catch (err) {
            if (this.missing(p, err)) return null;
            throw err;
          }
        });
        if (st && !st.isDir) this.believe(p);
        else if (!st) this.present.delete(p);
        return st;
      } catch (err) {
        if (err instanceof NotFoundYet) {
          this.present.delete(p);
          return null;
        }
        this.wrap('PROPFIND', p, err);
      }
    });
  }

  async list(dir: string): Promise<Entry[]> {
    const d = joinPath(dir);
    return this.timed('list', async () => {
      try {
        const items = await this.retrying('list', d, 'always', async () => {
          try {
            return (await this.client.getDirectoryContents(d)) as FileStat[];
          } catch (err) {
            if (statusOf(err) === 404) return [];
            throw err;
          }
        });
        return items
          .map((s) => ({ ...toStat(s), name: s.basename, path: s.filename }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        this.wrap('PROPFIND', d, err);
      }
    });
  }

  async delete(path: string): Promise<void> {
    const p = joinPath(path);
    await this.timed('delete', async () => {
      try {
        await this.retrying('delete', p, 'always', async () => {
          try {
            await this.client.deleteFile(p);
          } catch (err) {
            if (statusOf(err) !== 404) throw err;
          }
        });
      } catch (err) {
        this.wrap('DELETE', p, err);
      }
    });
    this.forget(p);
  }

  async move(from: string, to: string): Promise<void> {
    const a = joinPath(from);
    const b = joinPath(to);
    await this.ensureDir(parentOf(b));
    await this.timed('move', async () => {
      try {
        await this.retrying('move', a, 'unapplied', () => this.client.moveFile(a, b));
      } catch (err) {
        this.wrap('MOVE', a, err);
      }
    });
    this.forget(a);
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

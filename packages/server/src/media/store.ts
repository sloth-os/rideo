import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MediaRef, Probe } from '@rideo/shared';
import { slugify } from '@rideo/shared';
import mime from 'mime-types';
import { z } from 'zod';
import { AppError } from '../errors';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { sleep } from '../util/abort';
import { randomHex, sha256, sha256File } from '../util/crypto';
import type { Ffmpeg } from './ffmpeg';
import { toPng } from './frames';

/** MediaRef fields from a probe (server ffprobe or a browser's `parseProbe`). */
export function mediaFields(
  p: Omit<Probe, 'formatName'> & { formatName?: string },
  mimeType: string,
): Partial<MediaRef> {
  const out: Partial<MediaRef> = {};
  if (p.width) out.width = p.width;
  if (p.height) out.height = p.height;
  if (!mimeType.startsWith('image/')) {
    out.durationSec = p.durationSec;
    out.hasAudio = p.hasAudio;
    if (p.fps && mimeType.startsWith('video/')) out.fps = p.fps;
    if (p.videoCodec && p.hasVideo) out.videoCodec = p.videoCodec;
    if (p.audioCodec && p.hasAudio) out.audioCodec = p.audioCodec;
  }
  return out;
}

export type MediaKind =
  | 'refs'
  | 'keyframes'
  | 'takes'
  | 'posters'
  | 'frames'
  | 'music'
  | 'uploads'
  | 'exports'
  | 'thumbs'
  | 'sheets'
  | 'voices'
  | 'dialogue'
  | 'sfx'
  | 'stems'
  | 'subtitles'
  | 'luts'
  | 'masks'
  | 'brand'
  /** Feedback reports (docs/design/feedback.md#the-report). */
  | 'reports';

export interface PutOptions {
  kind: MediaKind;
  name: string;
  mime?: string;
  /**
   * Media fields: `true`/omitted probes with ffprobe (generated media), a `Probe` uses a browser's probe of an
   * upload (no server-side media work), `false` stores the file without media fields.
   */
  probe?: boolean | Probe;
  /** Fixed filename stem instead of `<name>-<hash12>` (proxies are named by their original's hash). */
  stem?: string;
}

const EXT_OVERRIDES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'video/quicktime': 'mov',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  // 3D LUTs: ffmpeg's lut3d reads the format from the extension (docs/design/editor.md#luts)
  'application/x-cube': 'cube',
  // Brand fonts (docs/design/brand-kits.md)
  'font/ttf': 'ttf',
  'font/otf': 'otf',
};

export function extFor(mimeType: string, fallbackPath?: string): string {
  const fromMime = EXT_OVERRIDES[mimeType] ?? mime.extension(mimeType);
  if (fromMime) return fromMime === 'jpeg' ? 'jpg' : fromMime;
  const e = fallbackPath ? extname(fallbackPath).slice(1).toLowerCase() : '';
  return e || 'bin';
}

export function mimeFor(pathOrExt: string): string {
  const t = mime.lookup(pathOrExt);
  if (t) return t;
  if (pathOrExt.endsWith('.webm')) return 'video/webm';
  if (pathOrExt.toLowerCase().endsWith('.cube')) return 'application/x-cube';
  return 'application/octet-stream';
}

function parseDataUri(uri: string): { mime: string; data: Buffer } | null {
  const m = /^data:([^;,]+)?((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const body = m[4] ?? '';
  return {
    mime: m[1] || 'application/octet-stream',
    data: m[3] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body)),
  };
}

/**
 * Immutable, content-addressed media on WebDAV (`media/<kind>/<name>-<hash12>.<ext>`) with a verified,
 * size-bounded local cache for ffmpeg (docs/design/storage-webdav.md#media-references).
 */
/** Tries of a gateway output download (docs/design/ai-gateway.md#sdk-usage). */
const DOWNLOAD_TRIES = 3;

/** A cached file waiting to be written to storage (docs/design/storage-webdav.md#local-cache-and-staging). */
const PendingUploadSchema = z.object({
  projectId: z.string(),
  path: z.string(),
  cacheName: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  since: z.string(),
  attempts: z.number().int().nonnegative(),
});
type PendingUpload = z.infer<typeof PendingUploadSchema>;
/** The first wait after a failed upload; it doubles up to the longest. */
const UPLOAD_RETRY_MS = 30_000;
const UPLOAD_RETRY_MAX_MS = 600_000;

export class MediaStore {
  private readonly cacheDir: string;
  readonly tmpDir: string;
  private cacheIndex: Map<string, { size: number; used: number }> | null = null;
  private cacheBytes = 0;
  /** Uploads behind a ready file, by `<projectId>:<path>`: their cached files are never evicted. */
  private readonly pending = new Map<string, PendingUpload>();
  private readonly uploading = new Set<string>();
  /** A file waited for has reached storage. */
  onUploaded?: (projectId: string, path: string) => void;

  constructor(
    private readonly deps: {
      storage: StorageBackend;
      layout: Layout;
      ff: Ffmpeg;
      dataDir: string;
      maxCacheBytes: number;
      log?: { warn: (o: unknown, m?: string) => void; info?: (o: unknown, m?: string) => void };
      /** The wait between download tries (tests); else a second, then two. */
      downloadRetryMs?: number;
      metrics?: Metrics;
      /** The first wait after a failed background upload (tests); else 30 s. */
      uploadRetryMs?: number;
    },
  ) {
    this.cacheDir = join(deps.dataDir, 'cache', 'media');
    this.tmpDir = join(deps.dataDir, 'tmp');
  }

  async init(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    this.cacheIndex = new Map();
    this.cacheBytes = 0;
    for (const name of await readdir(this.cacheDir)) {
      const st = await stat(join(this.cacheDir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      this.cacheIndex.set(name, { size: st.size, used: st.atimeMs });
      this.cacheBytes += st.size;
    }
    // Uploads a restart interrupted (resumed by `resumeUploads`)
    try {
      const raw = JSON.parse(await readFile(this.uploadsFile, 'utf8')) as unknown[];
      for (const u of raw) {
        const up = PendingUploadSchema.safeParse(u);
        if (up.success && this.cacheIndex.has(up.data.cacheName))
          this.pending.set(`${up.data.projectId}:${up.data.path}`, up.data);
      }
    } catch {
      // none waiting
    }
    this.deps.metrics?.mediaUploadsPending.set({}, this.pending.size);
  }

  private get uploadsFile(): string {
    return join(this.deps.dataDir, 'uploads.json');
  }

  private async savePending(): Promise<void> {
    const tmp = `${this.uploadsFile}.${randomHex(4)}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.pending.values()]));
    await rename(tmp, this.uploadsFile);
    this.deps.metrics?.mediaUploadsPending.set({}, this.pending.size);
  }

  /** Files ready in the cache and not yet on storage. */
  pendingUploads(): { projectId: string; path: string; since: string; attempts: number }[] {
    return [...this.pending.values()].map(({ projectId, path, since, attempts }) => ({
      projectId,
      path,
      since,
      attempts,
    }));
  }

  /** Starts the uploads waiting from the last run (after `onUploaded` is set). */
  resumeUploads(): void {
    for (const key of this.pending.keys()) void this.upload(key);
  }

  /** A unique scratch path (caller deletes it, or it is swept on restart). */
  tmp(ext: string): string {
    return join(this.tmpDir, `${Date.now()}-${randomHex(6)}.${ext.replace(/^\./, '')}`);
  }

  async withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = join(this.tmpDir, `d-${Date.now()}-${randomHex(6)}`);
    await mkdir(dir, { recursive: true });
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private cacheName(hash: string, path: string): string {
    return `${hash}${extname(path)}`;
  }

  private async touchCache(name: string, size: number): Promise<void> {
    if (!this.cacheIndex) await this.init();
    const prev = this.cacheIndex!.get(name);
    if (!prev) this.cacheBytes += size;
    this.cacheIndex!.set(name, { size, used: Date.now() });
    if (this.cacheBytes > this.deps.maxCacheBytes) await this.evict();
  }

  private async evict(): Promise<void> {
    const waiting = new Set([...this.pending.values()].map((u) => u.cacheName));
    const entries = [...this.cacheIndex!.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [name, e] of entries) {
      if (this.cacheBytes <= this.deps.maxCacheBytes * 0.9) break;
      // The only copy of a file waiting for its upload
      if (waiting.has(name)) continue;
      await rm(join(this.cacheDir, name), { force: true });
      this.cacheIndex!.delete(name);
      this.cacheBytes -= e.size;
    }
  }

  async probeRef(file: string, mimeType: string): Promise<Partial<MediaRef>> {
    if (!/^(video|audio|image)\//.test(mimeType)) return {};
    try {
      return mediaFields(await this.deps.ff.probe(file), mimeType);
    } catch (err) {
      this.deps.log?.warn({ err, file }, 'probe failed');
      return {};
    }
  }

  async putFile(projectId: string, file: string, opts: PutOptions): Promise<MediaRef> {
    const hash = await sha256File(file);
    const size = (await stat(file)).size;
    const mimeType = opts.mime ?? mimeFor(file);
    const ext = extFor(mimeType, file);
    const stem = opts.stem ?? `${slugify(opts.name, 48)}-${hash.slice(0, 12)}`;
    const path = `media/${opts.kind}/${stem}.${ext}`;
    const target = this.deps.layout.media(projectId, path);
    const existing = await this.deps.storage.stat(target);
    if (!existing || existing.size !== size) {
      await this.deps.storage.write(target, createReadStream(file), { contentType: mimeType, size });
    }
    const cacheName = this.cacheName(hash, path);
    const cachePath = join(this.cacheDir, cacheName);
    if (!this.cacheIndex?.has(cacheName)) {
      await copyFile(file, cachePath);
      await this.touchCache(cacheName, size);
    }
    const probe =
      opts.probe === false
        ? {}
        : typeof opts.probe === 'object'
          ? mediaFields(opts.probe, mimeType)
          : await this.probeRef(file, mimeType);
    return { path, hash, mime: mimeType, size, ...probe };
  }

  /**
   * Like `putFile`, without waiting for storage (docs/design/storage-webdav.md#local-cache-and-staging): the file is
   * in the cache (served from there) when this returns, and written to storage in the background, again after a
   * failure, and after a restart; `onUploaded` says when it is there.
   */
  async putFileBehind(
    projectId: string,
    file: string,
    opts: PutOptions & {
      /** false: the upload waits for `startUpload` (after the document that says it is pending is committed). */
      start?: boolean;
    },
  ): Promise<MediaRef> {
    const hash = await sha256File(file);
    const size = (await stat(file)).size;
    const mimeType = opts.mime ?? mimeFor(file);
    const ext = extFor(mimeType, file);
    const stem = opts.stem ?? `${slugify(opts.name, 48)}-${hash.slice(0, 12)}`;
    const path = `media/${opts.kind}/${stem}.${ext}`;
    const cacheName = this.cacheName(hash, path);
    const key = `${projectId}:${path}`;
    // Listed (and so never evicted) before it enters the cache
    this.pending.set(key, {
      projectId,
      path,
      cacheName,
      mime: mimeType,
      size,
      since: new Date().toISOString(),
      attempts: 0,
    });
    if (!this.cacheIndex?.has(cacheName)) {
      await copyFile(file, join(this.cacheDir, cacheName));
      await this.touchCache(cacheName, size);
    }
    await this.savePending();
    const probe =
      opts.probe === false
        ? {}
        : typeof opts.probe === 'object'
          ? mediaFields(opts.probe, mimeType)
          : await this.probeRef(file, mimeType);
    if (opts.start !== false) void this.upload(key);
    return { path, hash, mime: mimeType, size, ...probe };
  }

  /** Starts a waiting upload (`putFileBehind` with `start: false`). */
  startUpload(projectId: string, path: string): void {
    void this.upload(`${projectId}:${path}`);
  }

  private async upload(key: string): Promise<void> {
    const up = this.pending.get(key);
    if (!up || this.uploading.has(key)) return;
    this.uploading.add(key);
    try {
      const target = this.deps.layout.media(up.projectId, up.path);
      const there = await this.deps.storage.stat(target).catch(() => null);
      if (!there || there.size !== up.size)
        await this.deps.storage.write(target, createReadStream(join(this.cacheDir, up.cacheName)), {
          contentType: up.mime,
          size: up.size,
        });
      this.pending.delete(key);
      await this.savePending();
      this.deps.metrics?.mediaUploads.inc({ outcome: 'done' });
      this.deps.log?.info?.(
        { projectId: up.projectId, path: up.path, ms: Date.now() - Date.parse(up.since) },
        'file written to storage behind its readiness',
      );
      this.onUploaded?.(up.projectId, up.path);
    } catch (err) {
      up.attempts++;
      await this.savePending().catch(() => undefined);
      const first = this.deps.uploadRetryMs ?? UPLOAD_RETRY_MS;
      const wait = Math.min(UPLOAD_RETRY_MAX_MS, first * 2 ** (up.attempts - 1));
      this.deps.metrics?.mediaUploads.inc({ outcome: 'retried' });
      this.deps.log?.warn(
        {
          projectId: up.projectId,
          path: up.path,
          attempts: up.attempts,
          waitMs: wait,
          err: (err as Error).message,
        },
        'background upload failed; trying again',
      );
      setTimeout(() => void this.upload(key), wait).unref?.();
    } finally {
      this.uploading.delete(key);
    }
  }

  async putBuffer(projectId: string, data: Buffer, opts: PutOptions): Promise<MediaRef> {
    const tmp = this.tmp(extFor(opts.mime ?? 'application/octet-stream'));
    await writeFile(tmp, data);
    try {
      return await this.putFile(projectId, tmp, opts);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * Downloads a gateway output to a local file (docs/design/ai-gateway.md#sdk-usage): again on a dropped connection or
   * a 5xx/429 from the provider's file host, up to `DOWNLOAD_TRIES`; then a retryable `gateway_error`.
   */
  private async fetchTo(uri: string, path: string, signal?: AbortSignal): Promise<Headers> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(uri, { signal });
        if (!res.ok || !res.body) {
          const retryable = res.status >= 500 || res.status === 429;
          if (retryable && attempt < DOWNLOAD_TRIES) {
            await res.body?.cancel().catch(() => undefined);
            await sleep(this.deps.downloadRetryMs ?? 1000 * attempt, signal);
            continue;
          }
          throw new AppError(
            'gateway_error',
            `download failed (${res.status}) for ${uri.slice(0, 120)}`,
            [],
            retryable,
          );
        }
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));
        return res.headers;
      } catch (err) {
        if (err instanceof AppError || signal?.aborted) throw err;
        if (attempt >= DOWNLOAD_TRIES) {
          const cause = (err as { cause?: { code?: string; message?: string } }).cause;
          throw new AppError(
            'gateway_error',
            `download failed for ${uri.slice(0, 120)}: ${(err as Error).message}${cause ? ` (${cause.code ?? cause.message})` : ''}`,
            [],
            true,
          );
        }
        await sleep(this.deps.downloadRetryMs ?? 1000 * attempt, signal);
      }
    }
  }

  /** Imports an https/http/data URI (gateway outputs, MCP resource_add). */
  async importUri(
    projectId: string,
    uri: string,
    opts: PutOptions & { signal?: AbortSignal; maxBytes?: number },
  ): Promise<MediaRef> {
    const data = parseDataUri(uri);
    if (data) return this.putBuffer(projectId, data.data, { ...opts, mime: opts.mime ?? data.mime });
    if (!/^https?:\/\//.test(uri))
      throw new AppError('validation_error', 'uri must be http(s) or a data URI');
    const pathname = new URL(uri).pathname;
    let tmp = this.tmp(extFor(opts.mime ?? mimeFor(pathname), pathname));
    try {
      const headers = await this.fetchTo(uri, tmp, opts.signal);
      const type = opts.mime ?? headers.get('content-type')?.split(';')[0]?.trim() ?? mimeFor(pathname);
      const named = this.tmp(extFor(type, pathname));
      if (extname(named) !== extname(tmp)) {
        await rename(tmp, named);
        tmp = named;
      }
      const size = (await stat(tmp)).size;
      if (opts.maxBytes && size > opts.maxBytes)
        throw new AppError('validation_error', `media larger than ${opts.maxBytes} bytes`);
      return await this.putFile(projectId, tmp, { ...opts, mime: type });
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Downloads a URI to a local path without storing it (raw, unwatermarked generations never reach WebDAV). */
  async downloadTo(uri: string, path: string, signal?: AbortSignal): Promise<{ mime: string; size: number }> {
    const data = parseDataUri(uri);
    if (data) {
      await writeFile(path, data.data);
      return { mime: data.mime, size: data.data.length };
    }
    if (!/^https?:\/\//.test(uri))
      throw new AppError('validation_error', 'uri must be http(s) or a data URI');
    const headers = await this.fetchTo(uri, path, signal);
    return {
      mime: headers.get('content-type')?.split(';')[0]?.trim() ?? mimeFor(new URL(uri).pathname),
      size: (await stat(path)).size,
    };
  }

  /** Local, hash-verified copy of a media file (downloaded once into the cache). */
  async localPath(projectId: string, ref: Pick<MediaRef, 'path' | 'hash'>): Promise<string> {
    if (!this.cacheIndex) await this.init();
    const name = this.cacheName(ref.hash, ref.path);
    const path = join(this.cacheDir, name);
    const hit = await stat(path).catch(() => null);
    if (hit?.isFile()) {
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      this.cacheIndex!.set(name, { size: hit.size, used: Date.now() });
      return path;
    }
    const res = await this.deps.storage.readStream(this.deps.layout.media(projectId, ref.path));
    if (!res) throw new AppError('not_found', `media ${ref.path} missing from storage`);
    const tmp = this.tmp(extname(ref.path).slice(1) || 'bin');
    await pipeline(res.stream, createWriteStream(tmp));
    const actual = await sha256File(tmp);
    if (actual !== ref.hash) {
      await rm(tmp, { force: true });
      throw new AppError('storage_error', `media ${ref.path} failed its hash check`);
    }
    await rename(tmp, path);
    await this.touchCache(name, res.size);
    return path;
  }

  async readBuffer(projectId: string, ref: Pick<MediaRef, 'path' | 'hash'>): Promise<Buffer> {
    return readFile(await this.localPath(projectId, ref));
  }

  /** PNG data URI of an image (optionally downscaled) — gateway inputs and judge evidence. */
  async pngDataUri(
    projectId: string,
    ref: Pick<MediaRef, 'path' | 'hash' | 'mime'>,
    maxSide = 1024,
  ): Promise<string> {
    return `data:image/png;base64,${(await this.pngBuffer(projectId, ref, maxSide)).toString('base64')}`;
  }

  async pngBuffer(
    projectId: string,
    ref: Pick<MediaRef, 'path' | 'hash' | 'mime'>,
    maxSide = 1024,
  ): Promise<Buffer> {
    const local = await this.localPath(projectId, ref);
    return this.filePng(local, maxSide);
  }

  async filePng(local: string, maxSide = 1024): Promise<Buffer> {
    const key = `${sha256(`${local}:${maxSide}`).slice(0, 24)}.png`;
    const cached = join(this.cacheDir, `derived-${key}`);
    const hit = await readFile(cached).catch(() => null);
    if (hit) return hit;
    const tmp = this.tmp('png');
    try {
      await toPng(this.deps.ff, local, tmp, maxSide);
      const buf = await readFile(tmp);
      await writeFile(cached, buf);
      await this.touchCache(`derived-${key}`, buf.length);
      return buf;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async dataUri(projectId: string, ref: MediaRef): Promise<string> {
    const buf = await this.readBuffer(projectId, ref);
    return `data:${ref.mime};base64,${buf.toString('base64')}`;
  }

  /** Range-aware stream for the media route: local cache first, then WebDAV. */
  async stream(
    projectId: string,
    mediaPath: string,
    range?: { start: number; end?: number },
  ): Promise<{ stream: Readable; size: number; start: number; end: number; mime: string } | null> {
    const mimeType = mimeFor(mediaPath);
    const target = this.deps.layout.media(projectId, mediaPath);
    const hashPart = /-([0-9a-f]{12})\.[a-z0-9]+$/.exec(mediaPath)?.[1];
    if (hashPart && this.cacheIndex) {
      for (const name of this.cacheIndex.keys()) {
        if (name.startsWith(hashPart) && name.endsWith(extname(mediaPath))) {
          const path = join(this.cacheDir, name);
          const st = await stat(path).catch(() => null);
          if (!st) break;
          const start = range?.start ?? 0;
          const end = Math.min(range?.end ?? st.size - 1, st.size - 1);
          return {
            stream: createReadStream(path, { start, end }),
            size: st.size,
            start,
            end,
            mime: mimeType,
          };
        }
      }
    }
    const res = await this.deps.storage.readStream(target, range);
    return res ? { ...res, mime: mimeType } : null;
  }

  async exists(projectId: string, mediaPath: string): Promise<boolean> {
    return (await this.deps.storage.stat(this.deps.layout.media(projectId, mediaPath))) !== null;
  }
}

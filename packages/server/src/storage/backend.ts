import type { Readable } from 'node:stream';

export interface Stat {
  size: number;
  etag?: string;
  mtime: number;
  isDir: boolean;
}

export interface Entry extends Stat {
  name: string;
  path: string;
}

export interface WriteOptions {
  ifMatch?: string;
  ifNoneMatch?: '*';
  contentType?: string;
  size?: number;
}

export interface ReadResult {
  stream: Readable;
  size: number;
  start: number;
  end: number;
}

/** Everything Rideo persists goes through this interface (docs/design/storage-webdav.md). */
export interface StorageBackend {
  readonly kind: 'webdav' | 'memory';
  read(path: string): Promise<Buffer | null>;
  readStream(path: string, range?: { start: number; end?: number }): Promise<ReadResult | null>;
  write(path: string, data: Buffer | string | Readable, opts?: WriteOptions): Promise<{ etag?: string }>;
  stat(path: string): Promise<Stat | null>;
  list(dir: string): Promise<Entry[]>;
  delete(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  capabilities(): Promise<{ conditionalWrites: boolean }>;
}

export class PreconditionFailedError extends Error {
  readonly code = 'conflict';
  constructor(path: string) {
    super(`precondition failed for ${path}`);
  }
}

export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/+/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

export function parentOf(path: string): string {
  const i = path.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

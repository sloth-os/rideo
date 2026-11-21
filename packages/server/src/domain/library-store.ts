import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  LIBRARY_MAX_VERSIONS,
  type LibraryItem,
  LibraryItemSchema,
  type LibraryVersion,
  LibraryVersionSchema,
} from '@rideo/shared';
import { AppError, invalid } from '../errors';
import { PreconditionFailedError, type ReadResult, type StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { sha256File } from '../util/crypto';
import { eachLimit } from '../util/limit';
import { KeyedMutex } from '../util/mutex';
import type { Logger } from './deps';

/** Heads read at once on first use (docs/design/library.md#storage). */
const HEADS_AT_ONCE = 8;
/** Version manifests kept in memory. */
export const MANIFESTS_KEPT = 256;

const HEAD_FILE = /^lib_[0-9a-z]{10,32}\.json$/;

/**
 * The studio library on the storage backend (docs/design/library.md#storage): item heads (read into memory on first
 * use, 8 at a time, an invalid head skipped with a warning, one that cannot be read failing the load until the next
 * call reads them again), version manifests (written once with `If-None-Match: *`, read on demand, the last 256 kept)
 * and content-addressed files. Every change of an item runs under its lock.
 */
export class LibraryStore {
  private readonly heads = new Map<string, LibraryItem>();
  private loaded: Promise<void> | null = null;
  private readonly manifests = new Map<string, LibraryVersion>();
  private readonly mutex = new KeyedMutex();
  /** Heads read from storage (each once): what tests count. */
  headReads = 0;

  constructor(
    private readonly deps: {
      storage: StorageBackend;
      layout: Layout;
      log: Logger;
      /** A temporary file path with this extension. */
      tmp: (ext: string) => string;
    },
  ) {}

  /**
   * Reads every head once; a listing or a head read that fails is tried again by the next call (a retryable
   * `storage_error`).
   */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const dir = this.deps.layout.libraryItemsDir();
      const entries = (await this.deps.storage.list(dir)).filter((e) => !e.isDir && HEAD_FILE.test(e.name));
      await eachLimit(entries, HEADS_AT_ONCE, async (e) => {
        // a head that cannot be read fails the load: skipping it would hide the item, and a save of an entity linked
        // to it would make a new item
        const buf = await this.deps.storage.read(`${dir}/${e.name}`);
        this.headReads++;
        if (!buf) return;
        try {
          const item = LibraryItemSchema.parse(JSON.parse(buf.toString('utf8')));
          if (`${item.id}.json` !== e.name) throw new Error(`its id ${item.id} is not its file's name`);
          this.heads.set(item.id, item);
        } catch (err) {
          this.deps.log.warn(
            { file: e.name, err: (err as Error).message },
            'skipping an invalid library item',
          );
        }
      });
    })().catch((err) => {
      this.loaded = null;
      throw new AppError(
        'storage_error',
        `the studio library could not be read: ${(err as Error).message}`,
        [],
        true,
      );
    });
    return this.loaded;
  }

  async items(): Promise<LibraryItem[]> {
    await this.load();
    return [...this.heads.values()];
  }

  async item(id: string): Promise<LibraryItem | null> {
    await this.load();
    return this.heads.get(id) ?? null;
  }

  /** A version's manifest (null when none is stored); one that does not parse is a `storage_error`. */
  async version(id: string, n: number): Promise<LibraryVersion | null> {
    const key = `${id}@${n}`;
    const hit = this.manifests.get(key);
    if (hit) {
      this.manifests.delete(key);
      this.manifests.set(key, hit);
      return hit;
    }
    const buf = await this.deps.storage.read(this.deps.layout.libraryVersion(id, n));
    if (!buf) return null;
    let v: LibraryVersion;
    try {
      v = LibraryVersionSchema.parse(JSON.parse(buf.toString('utf8')));
    } catch (err) {
      throw new AppError('storage_error', `version ${n} of ${id} is unreadable: ${(err as Error).message}`);
    }
    if (v.itemId !== id || v.version !== n)
      throw new AppError('storage_error', `the manifest at version ${n} of ${id} names another version`);
    this.remember(key, v);
    return v;
  }

  private remember(key: string, v: LibraryVersion): void {
    this.manifests.set(key, v);
    while (this.manifests.size > MANIFESTS_KEPT) this.manifests.delete(this.manifests.keys().next().value!);
  }

  /** Runs `fn` with the item locked: changes of one item never interleave. */
  lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(id, fn);
  }

  async saveHead(item: LibraryItem): Promise<LibraryItem> {
    const valid = LibraryItemSchema.parse(item);
    await this.deps.storage.write(this.deps.layout.libraryItem(valid.id), JSON.stringify(valid, null, 2), {
      contentType: 'application/json',
    });
    this.heads.set(valid.id, valid);
    return valid;
  }

  /**
   * Writes a version's manifest once, at the first number from `from` that no manifest holds: a manifest a crash left
   * without its head is skipped, so numbers only increase (with gaps). Call it under the item's lock.
   */
  async writeVersion(id: string, from: number, make: (n: number) => LibraryVersion): Promise<LibraryVersion> {
    for (let n = from; n <= LIBRARY_MAX_VERSIONS; n++) {
      const path = this.deps.layout.libraryVersion(id, n);
      if (await this.deps.storage.stat(path)) {
        this.deps.log.warn({ itemId: id, version: n }, 'skipping a library manifest no head names');
        continue;
      }
      const v = LibraryVersionSchema.parse(make(n));
      try {
        await this.deps.storage.write(path, JSON.stringify(v, null, 2), {
          contentType: 'application/json',
          ifNoneMatch: '*',
        });
      } catch (err) {
        if (err instanceof PreconditionFailedError) continue;
        throw err;
      }
      this.remember(`${id}@${n}`, v);
      return v;
    }
    throw invalid(`an item holds at most ${LIBRARY_MAX_VERSIONS} versions`);
  }

  async hasFile(sha256: string): Promise<boolean> {
    return (await this.deps.storage.stat(this.deps.layout.libraryFile(sha256))) !== null;
  }

  /** Stores a local file under its sha256, once: written only when missing. True when it was written. */
  async putFile(local: string, sha256: string, size: number, mime: string): Promise<boolean> {
    const path = this.deps.layout.libraryFile(sha256);
    const existing = await this.deps.storage.stat(path);
    if (existing && existing.size === size) return false;
    await this.deps.storage.write(path, createReadStream(local), { contentType: mime, size });
    return true;
  }

  readFile(sha256: string, range?: { start: number; end?: number }): Promise<ReadResult | null> {
    return this.deps.storage.readStream(this.deps.layout.libraryFile(sha256), range);
  }

  /** A hash-checked local copy of a library file; the caller removes it. A missing or corrupt file: `storage_error`. */
  async fileToTmp(sha256: string, ext: string): Promise<string> {
    const res = await this.deps.storage.readStream(this.deps.layout.libraryFile(sha256));
    if (!res)
      throw new AppError('storage_error', `the library file ${sha256} is missing from storage`, [], true);
    const tmp = this.deps.tmp(ext);
    try {
      await pipeline(res.stream, createWriteStream(tmp));
      if ((await sha256File(tmp)) !== sha256)
        throw new AppError('storage_error', `the library file ${sha256} failed its hash check`, [], true);
      return tmp;
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

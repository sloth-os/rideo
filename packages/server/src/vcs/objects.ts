import { type Actor, type CommitChange, canonicalJson } from '@rideo/shared';
import { AppError } from '../errors';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { sleep } from '../util/abort';
import { sha256 } from '../util/crypto';
import { Lru } from '../util/lru';

export interface TreeEntry {
  kind: 'blob' | 'tree';
  hash: string;
}
export interface BlobObject {
  type: 'blob';
  content: unknown;
}
export interface TreeObject {
  type: 'tree';
  entries: Record<string, TreeEntry>;
}
export interface CommitObject {
  type: 'commit';
  tree: string;
  parents: string[];
  author: Actor;
  message: string;
  timestamp: string;
  changes: CommitChange[];
  meta?: Record<string, unknown>;
}
export type VcsObject = BlobObject | TreeObject | CommitObject;

/** How many objects of one commit are written at once. */
const WRITE_CONCURRENCY = 8;

/** Content-addressed, write-once object store: id = sha256(canonical JSON). Reads verify the hash. */
export class ObjectStore {
  private readonly cache = new Lru<string, VcsObject>(20_000);
  private readonly written = new Set<string>();

  /** The wait before a missing object is looked for again: a WebDAV server's 404 may be false. */
  missRetryMs: number;

  constructor(
    private readonly storage: StorageBackend,
    private readonly layout: Layout,
    private readonly projectId: string,
    opts: { missRetryMs?: number } = {},
  ) {
    this.missRetryMs = opts.missRetryMs ?? (storage.kind === 'webdav' ? 1000 : 0);
  }

  hashOf(obj: VcsObject): { id: string; json: string } {
    const json = canonicalJson(obj);
    return { id: sha256(json), json };
  }

  async put(obj: VcsObject): Promise<string> {
    return (await this.putAll([obj]))[0]!;
  }

  /**
   * Stores objects not written yet, several at once: nothing refers to them until a ref moves, so their order does
   * not matter (docs/design/version-control.md#commit-protocol). Returns their ids in order.
   */
  async putAll(objs: readonly VcsObject[]): Promise<string[]> {
    const hashed = objs.map((obj) => ({ obj, ...this.hashOf(obj) }));
    const todo = [...new Map(hashed.filter((h) => !this.written.has(h.id)).map((h) => [h.id, h.json]))];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const [id, json] = todo[next++]!;
        await this.storage.write(this.layout.object(this.projectId, id), json, {
          contentType: 'application/json',
        });
        this.written.add(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, todo.length) }, worker));
    for (const h of hashed) this.cache.set(h.id, h.obj);
    return hashed.map((h) => h.id);
  }

  async get<T extends VcsObject>(id: string): Promise<T> {
    const hit = this.cache.get(id);
    if (hit) return hit as T;
    const path = this.layout.object(this.projectId, id);
    // Objects never change and something named this one: a 404 is looked for again a second later, as a slow server
    // answers 404 for files it holds (docs/design/storage-webdav.md#slow-and-flaky-servers)
    const buf =
      (await this.storage.read(path)) ?? (await sleep(this.missRetryMs).then(() => this.storage.read(path)));
    if (!buf) throw new AppError('not_found', `object ${id.slice(0, 12)} not found`);
    if (sha256(buf) !== id) throw new AppError('storage_error', `object ${id.slice(0, 12)} is corrupt`);
    const obj = JSON.parse(buf.toString('utf8')) as T;
    this.written.add(id);
    this.cache.set(id, obj);
    return obj;
  }

  async has(id: string): Promise<boolean> {
    if (this.written.has(id)) return true;
    return (await this.storage.stat(this.layout.object(this.projectId, id))) !== null;
  }
}

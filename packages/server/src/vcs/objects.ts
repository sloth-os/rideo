import { type Actor, type CommitChange, canonicalJson } from '@rideo/shared';
import { AppError } from '../errors';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
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

/** Content-addressed, write-once object store: id = sha256(canonical JSON). Reads verify the hash. */
export class ObjectStore {
  private readonly cache = new Lru<string, VcsObject>(20_000);
  private readonly written = new Set<string>();

  constructor(
    private readonly storage: StorageBackend,
    private readonly layout: Layout,
    private readonly projectId: string,
  ) {}

  hashOf(obj: VcsObject): { id: string; json: string } {
    const json = canonicalJson(obj);
    return { id: sha256(json), json };
  }

  async put(obj: VcsObject): Promise<string> {
    const { id, json } = this.hashOf(obj);
    if (!this.written.has(id)) {
      await this.storage.write(this.layout.object(this.projectId, id), json, {
        contentType: 'application/json',
      });
      this.written.add(id);
    }
    this.cache.set(id, obj);
    return id;
  }

  async get<T extends VcsObject>(id: string): Promise<T> {
    const hit = this.cache.get(id);
    if (hit) return hit as T;
    const buf = await this.storage.read(this.layout.object(this.projectId, id));
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

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomToken } from './oidc';

interface SessionRecord {
  userId: string;
  createdAt: string;
  expiresAt: string;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Sign-in sessions (docs/design/accounts.md#sign-in-oidc): the browser holds a random id, the server keeps its
 * SHA-256 on disk (so sessions survive restarts) with a sliding expiry.
 */
export class SessionStore {
  private readonly cache = new Map<string, SessionRecord>();

  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async create(userId: string): Promise<string> {
    const token = randomToken(32);
    const now = Date.now();
    const record: SessionRecord = {
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    await this.save(hash(token), record);
    return token;
  }

  /** The user of a live session (renewed when half its time is used), or null. */
  async get(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const id = hash(token);
    let record = this.cache.get(id) ?? null;
    if (!record) {
      record = await readFile(join(this.dir, `${id}.json`), 'utf8')
        .then((t) => JSON.parse(t) as SessionRecord)
        .catch(() => null);
      if (record) this.cache.set(id, record);
    }
    if (!record) return null;
    const left = Date.parse(record.expiresAt) - Date.now();
    if (left <= 0) {
      await this.remove(id);
      return null;
    }
    if (left < this.ttlMs / 2)
      await this.save(id, { ...record, expiresAt: new Date(Date.now() + this.ttlMs).toISOString() });
    return record.userId;
  }

  async delete(token: string): Promise<void> {
    await this.remove(hash(token));
  }

  /** Ends every session of a user (disabled people). */
  async deleteUser(userId: string): Promise<void> {
    for (const [id, r] of this.cache) if (r.userId === userId) await this.remove(id);
  }

  private async save(id: string, record: SessionRecord): Promise<void> {
    this.cache.set(id, record);
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(record));
  }

  private async remove(id: string): Promise<void> {
    this.cache.delete(id);
    await rm(join(this.dir, `${id}.json`), { force: true });
  }
}

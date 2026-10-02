import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Notification, NotificationSchema, newId } from '@rideo/shared';
import type { LiveHub } from '../live/hub';

const KEEP = 500;

/**
 * Notifications (docs/design/review.md#notifications): kept per person (the last 500) and pushed to their open tabs
 * over the live WebSocket.
 */
export class NotificationService {
  private readonly cache = new Map<string, Notification[]>();
  private writes = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly hub: LiveHub,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private file(userId: string): string {
    return join(this.dir, `${userId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  private async load(userId: string): Promise<Notification[]> {
    let list = this.cache.get(userId);
    if (!list) {
      list = await readFile(this.file(userId), 'utf8')
        .then((t) => (JSON.parse(t) as unknown[]).map((n) => NotificationSchema.parse(n)))
        .catch(() => []);
      this.cache.set(userId, list);
    }
    return list;
  }

  private save(userId: string, list: Notification[]): Promise<void> {
    this.writes = this.writes.then(() =>
      writeFile(this.file(userId), JSON.stringify(list)).catch(() => undefined),
    );
    return this.writes;
  }

  /** Tells people something, except the one who did it. */
  async notify(
    userIds: readonly string[],
    n: Omit<Notification, 'id' | 'at' | 'read'>,
    opts: { except?: string } = {},
  ): Promise<void> {
    for (const userId of new Set(userIds)) {
      if (!userId || userId === opts.except) continue;
      const notification = NotificationSchema.parse({
        ...n,
        id: newId('notification'),
        at: new Date().toISOString(),
      });
      const list = [notification, ...(await this.load(userId))].slice(0, KEEP);
      this.cache.set(userId, list);
      await this.save(userId, list);
      this.hub.notifyUser(userId, { type: 'notification', notification });
    }
  }

  async list(userId: string, limit = 100): Promise<{ notifications: Notification[]; unread: number }> {
    const list = await this.load(userId);
    return { notifications: list.slice(0, limit), unread: list.filter((n) => !n.read).length };
  }

  /** Marks some (or all) as read. */
  async markRead(userId: string, ids?: readonly string[]): Promise<{ unread: number }> {
    const list = (await this.load(userId)).map((n) =>
      !ids || ids.includes(n.id) ? { ...n, read: true } : n,
    );
    this.cache.set(userId, list);
    await this.save(userId, list);
    return { unread: list.filter((n) => !n.read).length };
  }
}

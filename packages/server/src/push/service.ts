import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { invalid } from '../errors';
import type { Metrics } from '../metrics';
import { encryptPush, generateVapidKeys, type VapidKeys, vapidAuthorization } from './webpush';

/** A device's push subscription, as `PushSubscription.toJSON()` gives it. */
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(30) }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionSchema>;

const StoredSchema = z.array(PushSubscriptionSchema.extend({ createdAt: z.string() }));
type Stored = z.infer<typeof StoredSchema>;

/** Devices kept per person. */
export const MAX_DEVICES = 20;

/** What a push says (docs/design/pwa.md#notifications-on-the-phone-web-push): shown by the service worker. */
export interface PushMessage {
  title: string;
  body: string;
  link: string;
  tag?: string;
  urgency?: 'normal' | 'high';
}

/**
 * Web Push to people's devices (docs/design/pwa.md#notifications-on-the-phone-web-push): VAPID keys from the
 * environment or made once, subscriptions per person on the data dir, and delivery to each device's push service.
 */
export class PushService {
  private vapid: (VapidKeys & { subject: string }) | null = null;
  private readonly cache = new Map<string, Stored>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      dataDir: string;
      vapid?: { publicKey?: string; privateKey?: string; subject: string };
      /** Plain-HTTP push endpoints (tests); push services are HTTPS. */
      allowHttp?: boolean;
      metrics: Metrics;
      log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
      fetch?: typeof fetch;
    },
  ) {}

  private get dir(): string {
    return join(this.deps.dataDir, 'push');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const subject = this.deps.vapid?.subject ?? 'mailto:rideo@localhost';
    if (this.deps.vapid?.publicKey && this.deps.vapid.privateKey) {
      this.vapid = { publicKey: this.deps.vapid.publicKey, privateKey: this.deps.vapid.privateKey, subject };
      return;
    }
    const file = join(this.dir, 'vapid.json');
    const saved = await readFile(file, 'utf8')
      .then((t) => JSON.parse(t) as VapidKeys)
      .catch(() => null);
    const keys = saved ?? generateVapidKeys();
    if (!saved) await writeFile(file, JSON.stringify(keys), { mode: 0o600 });
    this.vapid = { ...keys, subject };
  }

  /** The application server key devices subscribe with. */
  publicKey(): string {
    if (!this.vapid) throw new Error('push keys are not loaded');
    return this.vapid.publicKey;
  }

  private file(userId: string): string {
    return join(this.dir, `${userId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  private async load(userId: string): Promise<Stored> {
    let list = this.cache.get(userId);
    if (!list) {
      list = await readFile(this.file(userId), 'utf8')
        .then((t) => StoredSchema.parse(JSON.parse(t)))
        .catch(() => []);
      this.cache.set(userId, list);
    }
    return list;
  }

  private async store(userId: string, list: Stored): Promise<void> {
    this.cache.set(userId, list);
    const path = this.file(userId);
    this.writes = this.writes.then(async () => {
      await writeFile(`${path}.tmp`, JSON.stringify(list));
      await rename(`${path}.tmp`, path);
    });
    await this.writes;
  }

  async subscribe(userId: string, input: PushSubscriptionInput): Promise<void> {
    const url = new URL(input.endpoint);
    if (url.protocol !== 'https:' && !(this.deps.allowHttp && url.protocol === 'http:'))
      throw invalid('push endpoints must be https');
    const list = (await this.load(userId)).filter((s) => s.endpoint !== input.endpoint);
    list.unshift({ ...input, createdAt: new Date().toISOString() });
    await this.store(userId, list.slice(0, MAX_DEVICES));
    this.deps.metrics.push.inc({ outcome: 'subscribed' });
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    const list = await this.load(userId);
    await this.store(
      userId,
      list.filter((s) => s.endpoint !== endpoint),
    );
  }

  /** How many devices a person has (the Inbox shows whether this one is among them by its endpoint). */
  async devices(userId: string): Promise<string[]> {
    return (await this.load(userId)).map((s) => s.endpoint);
  }

  /** Pushes a message to every device of a person; devices their push service forgot are dropped. */
  async send(userId: string, message: PushMessage): Promise<{ sent: number; gone: number; failed: number }> {
    const counts = { sent: 0, gone: 0, failed: 0 };
    const vapid = this.vapid;
    if (!vapid) return counts;
    const list = await this.load(userId);
    if (!list.length) return counts;
    const payload = Buffer.from(
      JSON.stringify({
        title: message.title,
        body: message.body,
        link: message.link,
        tag: message.tag ?? null,
      }),
    );
    const doFetch = this.deps.fetch ?? fetch;
    const gone: string[] = [];
    await Promise.all(
      list.map(async (s) => {
        try {
          const res = await doFetch(s.endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'content-encoding': 'aes128gcm',
              ttl: '86400',
              urgency: message.urgency ?? 'normal',
              authorization: vapidAuthorization(s.endpoint, vapid),
            },
            body: new Uint8Array(encryptPush(payload, s.keys)),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 404 || res.status === 410) {
            gone.push(s.endpoint);
            counts.gone++;
          } else if (res.ok) counts.sent++;
          else {
            counts.failed++;
            this.deps.log.warn({ userId, status: res.status }, 'push service refused a message');
          }
        } catch (err) {
          counts.failed++;
          this.deps.log.warn({ userId, err: (err as Error).message }, 'push delivery failed');
        }
      }),
    );
    if (gone.length)
      await this.store(
        userId,
        (await this.load(userId)).filter((s) => !gone.includes(s.endpoint)),
      );
    for (const [outcome, n] of Object.entries(counts)) if (n) this.deps.metrics.push.inc({ outcome }, n);
    return counts;
  }
}

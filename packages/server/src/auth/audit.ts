import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AuditEvent, AuditEventSchema, type AuditEventType } from '@rideo/shared';

export interface AuditQuery {
  since?: string;
  until?: string;
  projectId?: string;
  actorId?: string;
  type?: AuditEventType;
  /** Only these projects (directors who are not admins). */
  projectIds?: string[];
  limit?: number;
}

/** Security-relevant events as JSON lines, one file a day (docs/design/accounts.md#audit-log). */
export class AuditLog {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async record(
    e: Omit<AuditEvent, 'at' | 'projectId' | 'outcome' | 'detail'> & Partial<AuditEvent>,
  ): Promise<void> {
    const event = AuditEventSchema.parse({ ...e, at: e.at ?? new Date().toISOString() });
    await appendFile(join(this.dir, `${event.at.slice(0, 10)}.jsonl`), `${JSON.stringify(event)}\n`);
  }

  /** Newest first. */
  async query(q: AuditQuery = {}): Promise<AuditEvent[]> {
    const limit = Math.min(1000, Math.max(1, q.limit ?? 200));
    const days = (await readdir(this.dir).catch(() => [] as string[]))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .filter((d) => (!q.since || d >= q.since.slice(0, 10)) && (!q.until || d <= q.until.slice(0, 10)))
      .sort()
      .reverse();
    const out: AuditEvent[] = [];
    for (const day of days) {
      const lines = (await readFile(join(this.dir, `${day}.jsonl`), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .reverse();
      for (const line of lines) {
        let e: AuditEvent;
        try {
          e = AuditEventSchema.parse(JSON.parse(line));
        } catch {
          continue;
        }
        if (q.since && e.at < q.since) continue;
        if (q.until && e.at > q.until) continue;
        if (q.projectId && e.projectId !== q.projectId) continue;
        if (q.projectIds && (!e.projectId || !q.projectIds.includes(e.projectId))) continue;
        if (q.actorId && e.actor.id !== q.actorId && e.actor.userId !== q.actorId) continue;
        if (q.type && e.type !== q.type) continue;
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

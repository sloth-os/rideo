import { createHash, randomBytes } from 'node:crypto';
import type { Modality } from './models';

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface TaskOutput {
  uri: string;
  mime_type?: string;
  cover_uri?: string;
  revised_prompt?: string;
}

export interface TaskRecord {
  id: string;
  object: Modality;
  model: string;
  status: TaskStatus;
  outputs?: TaskOutput[];
  usage?: Record<string, number>;
  metadata?: Record<string, unknown>;
  error?: { code: string; message: string };
  lyrics?: string;
  created_at: string;
  completed_at?: string;
  owner: string;
}

export interface RunResult {
  outputs: TaskOutput[];
  usage?: Record<string, number>;
  lyrics?: string;
}

const PREFIX: Record<Modality, string> = { image: 'img', video: 'vid', music: 'mus' };

export class TaskError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Async task lifecycle shared by the three modalities: pending → running → terminal, with idempotency. */
export class TaskStore {
  /** The request body of every task by id (for tests). */
  readonly requests = new Map<string, unknown>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly idempotency = new Map<string, { fingerprint: string; taskId: string }>();
  readonly created: TaskRecord[] = [];

  constructor(private readonly latencyMs: number) {}

  fingerprint(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }

  /** Returns the replayed task, 'conflict', or null when the key is new. */
  replay(owner: string, key: string | undefined, body: unknown): TaskRecord | 'conflict' | null {
    if (!key) return null;
    const hit = this.idempotency.get(`${owner}:${key}`);
    if (!hit) return null;
    if (hit.fingerprint !== this.fingerprint(body)) return 'conflict';
    return this.tasks.get(hit.taskId) ?? null;
  }

  create(opts: {
    modality: Modality;
    model: string;
    owner: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
    body: unknown;
    run: () => Promise<RunResult>;
  }): TaskRecord {
    const id = `${PREFIX[opts.modality]}_${randomBytes(10).toString('hex')}`;
    const task: TaskRecord = {
      id,
      object: opts.modality,
      model: opts.model,
      status: 'pending',
      metadata: opts.metadata ?? {},
      created_at: new Date().toISOString(),
      owner: opts.owner,
    };
    this.tasks.set(id, task);
    this.created.push(task);
    // Tests read what Rideo asked for (never part of the public task).
    this.requests.set(id, opts.body);
    if (opts.idempotencyKey) {
      this.idempotency.set(`${opts.owner}:${opts.idempotencyKey}`, {
        fingerprint: this.fingerprint(opts.body),
        taskId: id,
      });
    }
    setTimeout(() => {
      task.status = 'running';
      setTimeout(() => {
        opts
          .run()
          .then((r) => {
            task.outputs = r.outputs;
            task.usage = r.usage;
            if (r.lyrics) task.lyrics = r.lyrics;
            task.status = 'succeeded';
          })
          .catch((err: unknown) => {
            task.status = 'failed';
            task.error =
              err instanceof TaskError
                ? { code: err.code, message: err.message }
                : {
                    code: 'upstream_error',
                    message: err instanceof Error ? err.message.slice(0, 500) : 'failed',
                  };
          })
          .finally(() => {
            task.completed_at = new Date().toISOString();
          });
      }, this.latencyMs / 2);
    }, this.latencyMs / 2);
    return task;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  etag(task: TaskRecord): string {
    return `"${createHash('sha1')
      .update(JSON.stringify(publicTask(task, '')))
      .digest('hex')}"`;
  }
}

export function publicTask(task: TaskRecord, baseUrl: string): Record<string, unknown> {
  const path = task.object === 'music' ? 'music' : `${task.object}s`;
  const { owner: _owner, ...rest } = task;
  return { ...rest, links: { self: `${baseUrl}/v1/${path}/${task.id}` } };
}

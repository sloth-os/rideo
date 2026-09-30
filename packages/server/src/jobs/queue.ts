import {
  type Actor,
  isTerminalJob,
  JOB_LANES,
  type Job,
  type JobKind,
  JobSchema,
  LANES,
  type Lane,
  newId,
} from '@rideo/shared';
import { AppError, notFound, toAppError } from '../errors';
import type { LiveHub } from '../live/hub';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { Semaphore } from '../util/mutex';

export interface JobLogger {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

export interface JobContext {
  job: Job;
  signal: AbortSignal;
  log: JobLogger;
  /** System actor acting on behalf of the requester (commit attribution). */
  actor: Actor;
  progress(done: number, total: number, message?: string): void;
  gatewayTask(t: Job['gatewayTasks'][number]): void;
  spawn(
    kind: JobKind,
    params: Record<string, unknown>,
    opts?: { priority?: number; dedupeKey?: string; maxAttempts?: number },
  ): Promise<Job>;
  /** Waits for jobs while releasing this job's lane slot (no orchestration deadlocks). */
  waitFor(jobIds: string[]): Promise<Job[]>;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface EnqueueInput {
  projectId: string;
  kind: JobKind;
  params?: Record<string, unknown>;
  actor: Actor;
  branch: string;
  dedupeKey?: string;
  parentId?: string;
  priority?: number;
  maxAttempts?: number;
}

interface Running {
  controller: AbortController;
  holdsPermit: boolean;
}

/** Persistent, lane-scheduled job queue (docs/design/generation-pipeline.md). */
export class JobQueue {
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly jobs = new Map<string, Job>();
  private readonly lanes = new Map<Lane, { sem: Semaphore; waiting: Job[] }>();
  private readonly running = new Map<string, Running>();
  private readonly notBefore = new Map<string, number>();
  private readonly waiters = new Map<string, ((job: Job) => void)[]>();
  private readonly lastPublish = new Map<string, number>();
  private readonly lastSave = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly deps: {
      storage: StorageBackend;
      layout: Layout;
      hub: LiveHub;
      metrics: Metrics;
      log: JobLogger & { child?: (b: object) => JobLogger };
      lanes: Record<string, number>;
    },
  ) {
    for (const lane of LANES)
      this.lanes.set(lane, { sem: new Semaphore(Math.max(1, deps.lanes[lane] ?? 1)), waiting: [] });
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  get(projectId: string, jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId) throw notFound(`job ${jobId}`);
    return job;
  }

  find(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  list(projectId: string, filter: { status?: Job['status']; kind?: JobKind } = {}): Job[] {
    return [...this.jobs.values()]
      .filter(
        (j) =>
          j.projectId === projectId &&
          (!filter.status || j.status === filter.status) &&
          (!filter.kind || j.kind === filter.kind),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  active(projectId: string): Job[] {
    return this.list(projectId).filter((j) => !isTerminalJob(j));
  }

  private async save(job: Job, force = true): Promise<void> {
    const now = Date.now();
    if (!force && now - (this.lastSave.get(job.id) ?? 0) < 3000) return;
    this.lastSave.set(job.id, now);
    try {
      await this.deps.storage.write(this.deps.layout.job(job.projectId, job.id), JSON.stringify(job), {
        contentType: 'application/json',
      });
    } catch (err) {
      this.deps.log.warn({ err, jobId: job.id }, 'failed to persist job record');
    }
  }

  private readonly trailing = new Map<string, NodeJS.Timeout>();

  /** Publishes a job event; throttled updates get a trailing publish so the latest state always lands. */
  private publish(job: Job, force = true): void {
    const now = Date.now();
    const elapsed = now - (this.lastPublish.get(job.id) ?? 0);
    if (!force && elapsed < 250) {
      if (!this.trailing.has(job.id)) {
        const t = setTimeout(() => {
          this.trailing.delete(job.id);
          this.publish(job);
        }, 250 - elapsed);
        t.unref();
        this.trailing.set(job.id, t);
      }
      return;
    }
    const pending = this.trailing.get(job.id);
    if (pending) {
      clearTimeout(pending);
      this.trailing.delete(job.id);
    }
    this.lastPublish.set(job.id, now);
    this.deps.hub.publish(job.projectId, { kind: 'job', job: structuredClone(job) });
  }

  async enqueue(input: EnqueueInput): Promise<Job> {
    if (this.closed) throw new AppError('conflict', 'job queue is shutting down');
    if (!this.handlers.has(input.kind)) throw new AppError('internal_error', `no handler for ${input.kind}`);
    if (input.dedupeKey) {
      const dup = [...this.jobs.values()].find(
        (j) => j.projectId === input.projectId && j.dedupeKey === input.dedupeKey && !isTerminalJob(j),
      );
      if (dup) return dup;
    }
    const job: Job = JobSchema.parse({
      id: newId('job'),
      projectId: input.projectId,
      kind: input.kind,
      lane: JOB_LANES[input.kind],
      status: 'queued',
      params: input.params ?? {},
      progress: { done: 0, total: 1 },
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      branch: input.branch,
      actor: input.actor,
      priority: input.priority ?? 0,
      gatewayTasks: [],
      createdAt: new Date().toISOString(),
    });
    this.jobs.set(job.id, job);
    await this.save(job);
    this.publish(job);
    this.schedule(job);
    return job;
  }

  private schedule(job: Job): void {
    const lane = this.lanes.get(job.lane)!;
    lane.waiting.push(job);
    lane.waiting.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    this.pump(job.lane);
  }

  private pump(laneName: Lane): void {
    if (this.closed) return;
    const lane = this.lanes.get(laneName)!;
    const now = Date.now();
    let nextWake = Number.POSITIVE_INFINITY;
    for (let i = 0; i < lane.waiting.length; ) {
      const job = lane.waiting[i]!;
      const nb = this.notBefore.get(job.id) ?? 0;
      if (nb > now) {
        nextWake = Math.min(nextWake, nb);
        i++;
        continue;
      }
      if (!lane.sem.tryAcquire()) break;
      lane.waiting.splice(i, 1);
      void this.run(job);
    }
    if (Number.isFinite(nextWake)) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(
        () => {
          this.timer = null;
          for (const l of LANES) this.pump(l);
        },
        Math.max(10, nextWake - now),
      );
      this.timer.unref();
    }
  }

  private release(job: Job, state: Running): void {
    if (state.holdsPermit) {
      state.holdsPermit = false;
      this.lanes.get(job.lane)!.sem.release();
      this.pump(job.lane);
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.kind)!;
    const controller = new AbortController();
    const state: Running = { controller, holdsPermit: true };
    this.running.set(job.id, state);
    job.status = 'running';
    job.attempts += 1;
    job.startedAt = new Date().toISOString();
    delete job.error;
    await this.save(job);
    this.publish(job);
    const log =
      this.deps.log.child?.({ jobId: job.id, projectId: job.projectId, kind: job.kind }) ?? this.deps.log;
    log.info({ attempt: job.attempts }, 'job started');
    const started = performance.now();
    const ctx: JobContext = {
      job,
      signal: controller.signal,
      log,
      actor: {
        kind: 'system',
        id: 'rideo',
        name: 'Rideo',
        onBehalfOf: { kind: job.actor.kind, id: job.actor.id, name: job.actor.name },
      },
      progress: (done, total, message) => {
        job.progress = { done, total, ...(message ? { message } : {}) };
        this.publish(job, false);
        void this.save(job, false);
      },
      gatewayTask: (t) => {
        const existing = job.gatewayTasks.find((g) => g.id === t.id);
        if (existing) Object.assign(existing, t);
        else job.gatewayTasks.push(t);
        void this.save(job, false);
      },
      spawn: (kind, params, opts = {}) =>
        this.enqueue({
          projectId: job.projectId,
          kind,
          params,
          actor: job.actor,
          branch: job.branch,
          parentId: job.id,
          priority: opts.priority ?? job.priority,
          dedupeKey: opts.dedupeKey,
          maxAttempts: opts.maxAttempts,
        }),
      waitFor: async (ids) => {
        this.release(job, state);
        const aborted = new Promise<never>((_, reject) => {
          const fail = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
          if (controller.signal.aborted) fail();
          else controller.signal.addEventListener('abort', fail, { once: true });
        });
        aborted.catch(() => undefined);
        const results = await Promise.race([Promise.all(ids.map((id) => this.wait(id))), aborted]);
        await this.lanes.get(job.lane)!.sem.acquire();
        state.holdsPermit = true;
        return results;
      },
    };
    try {
      const result = await handler(ctx);
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      job.status = 'succeeded';
      job.result = result;
      job.progress = {
        done: job.progress.total || 1,
        total: job.progress.total || 1,
        message: job.progress.message,
      };
      log.info({ ms: Math.round(performance.now() - started) }, 'job succeeded');
    } catch (err) {
      const e = toAppError(err);
      if (this.closed && controller.signal.aborted) {
        // Interrupted by shutdown: keep it queued on disk so the next boot recovers it.
        job.status = 'queued';
        job.error = { code: 'internal_error', message: 'interrupted by server shutdown', retryable: true };
        log.info({}, 'job interrupted by shutdown');
      } else if (controller.signal.aborted || e.code === 'cancelled') {
        job.status = 'cancelled';
        job.error = {
          code: 'cancelled',
          message: String(controller.signal.reason ?? 'cancelled'),
          retryable: false,
        };
        log.info({}, 'job cancelled');
      } else if (e.retryable && job.attempts < job.maxAttempts && !this.closed) {
        job.status = 'queued';
        job.error = { code: e.code, message: e.message, retryable: true };
        const delay = Math.min(60_000, 2000 * 2 ** (job.attempts - 1));
        this.notBefore.set(job.id, Date.now() + delay);
        log.warn({ err: e.message, delay }, 'job failed, retrying');
      } else {
        job.status = 'failed';
        job.error = { code: e.code, message: e.message, retryable: e.retryable };
        log.error({ err: e.message, code: e.code }, 'job failed');
      }
    } finally {
      this.release(job, state);
      this.running.delete(job.id);
    }
    if (isTerminalJob(job)) {
      job.finishedAt = new Date().toISOString();
      this.deps.metrics.jobs.inc({ kind: job.kind, status: job.status });
      this.deps.metrics.jobDuration.observe({ kind: job.kind }, (performance.now() - started) / 1000);
    }
    await this.save(job);
    this.publish(job);
    if (job.status === 'queued') {
      if (!this.closed) this.schedule(job);
    } else this.resolveWaiters(job);
  }

  private resolveWaiters(job: Job): void {
    const list = this.waiters.get(job.id);
    if (!list) return;
    this.waiters.delete(job.id);
    for (const w of list) w(job);
  }

  /** Resolves when the job is terminal (or after timeoutMs with its current state). */
  wait(jobId: string, timeoutMs?: number): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job) return Promise.reject(notFound(`job ${jobId}`));
    if (isTerminalJob(job)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const list = this.waiters.get(jobId) ?? [];
      let timer: NodeJS.Timeout | undefined;
      const done = (j: Job) => {
        if (timer) clearTimeout(timer);
        resolve(j);
      };
      list.push(done);
      this.waiters.set(jobId, list);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const l = this.waiters.get(jobId);
          if (l)
            this.waiters.set(
              jobId,
              l.filter((w) => w !== done),
            );
          resolve(this.jobs.get(jobId)!);
        }, timeoutMs);
      }
    });
  }

  /** Cancels a job; `cascade: false` lets already-spawned children finish (batch pause). */
  async cancel(
    projectId: string,
    jobId: string,
    reason = 'cancelled by request',
    opts: { cascade?: boolean } = {},
  ): Promise<Job> {
    const job = this.get(projectId, jobId);
    if (opts.cascade !== false) {
      for (const child of [...this.jobs.values()].filter((j) => j.parentId === jobId && !isTerminalJob(j))) {
        await this.cancel(projectId, child.id, reason);
      }
    }
    if (isTerminalJob(job)) return job;
    const running = this.running.get(jobId);
    if (running) {
      running.controller.abort(reason);
      return job;
    }
    const lane = this.lanes.get(job.lane)!;
    lane.waiting = lane.waiting.filter((j) => j.id !== jobId);
    job.status = 'cancelled';
    job.error = { code: 'cancelled', message: reason, retryable: false };
    job.finishedAt = new Date().toISOString();
    await this.save(job);
    this.publish(job);
    this.resolveWaiters(job);
    return job;
  }

  /** Loads a project's job records; re-enqueues interrupted work (docs/design/generation-pipeline.md#semantics). */
  async loadProject(projectId: string, recover: boolean): Promise<number> {
    let recovered = 0;
    const entries = await this.deps.storage.list(this.deps.layout.jobsDir(projectId));
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    for (const e of entries) {
      if (e.isDir || !e.name.endsWith('.json')) continue;
      const buf = await this.deps.storage.read(e.path).catch(() => null);
      if (!buf) continue;
      const parsed = JobSchema.safeParse(JSON.parse(buf.toString()));
      if (!parsed.success || this.jobs.has(parsed.data.id)) continue;
      const job = parsed.data;
      if (isTerminalJob(job) && Date.parse(job.createdAt) < cutoff) continue;
      this.jobs.set(job.id, job);
      if (!isTerminalJob(job) && recover && this.handlers.has(job.kind)) {
        job.status = 'queued';
        recovered++;
        this.publish(job);
        this.schedule(job);
      }
    }
    return recovered;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const [, r] of this.running) r.controller.abort('server shutdown');
  }
}

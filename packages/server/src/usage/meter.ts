import { AsyncLocalStorage } from 'node:async_hooks';
import {
  addUsage,
  emptyUsage,
  type GatewayTask,
  type Job,
  type KindUsage,
  KindUsageSchema,
  type ModelPrice,
  ModelUsageSchema,
  type Prices,
  type ProjectUsage,
  ProjectUsageSchema,
  type Usage,
  type UsageModality,
} from '@rideo/shared';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { sleep } from '../util/abort';

/**
 * Usage and cost (docs/design/observability.md#usage-ledger): every gateway task and model call adds to the usage of
 * the job whose handler made it (an async context set by the job queue), to the project's ledger and to metrics.
 */
export interface UsageScope {
  projectId: string;
  jobId: string;
  usage: Usage;
  /** Seconds and cost of each gateway task of this run, so an attempt the gate throws away counts as waste. */
  tasks: Map<string, { seconds: number; costUsd: number }>;
}

const context = new AsyncLocalStorage<UsageScope | null>();

/** Runs `fn` with `scope` as the current usage (the job queue does this around a handler). */
export function withUsage<T>(scope: UsageScope | null, fn: () => Promise<T>): Promise<T> {
  return context.run(scope, fn);
}

export function currentUsage(): UsageScope | null {
  return context.getStore() ?? null;
}

export function newScope(projectId: string, jobId: string): UsageScope {
  return { projectId, jobId, usage: emptyUsage(), tasks: new Map() };
}

function priced(p: ModelPrice | undefined): boolean {
  return !!p && Object.values(p).some((v) => typeof v === 'number');
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export class UsageMeter {
  constructor(
    private readonly deps: {
      metrics: Metrics;
      /** `RIDEO_PRICES`, read at each call so a settings change applies at once. */
      prices: () => Prices;
    },
  ) {}

  private model(scope: UsageScope | null, model: string, modality: UsageModality) {
    if (!scope) return null;
    const existing = scope.usage.byModel[model];
    if (existing) return existing;
    const fresh = ModelUsageSchema.parse({ modality });
    scope.usage.byModel[model] = fresh;
    return fresh;
  }

  /** A language, vision or speech call: tokens, time and cost. */
  llm(e: {
    task: string;
    model: string;
    modality: 'text' | 'vision' | 'speech';
    seconds: number;
    tokensIn?: number;
    tokensOut?: number;
    retries?: number;
  }): void {
    const { metrics } = this.deps;
    const tokensIn = e.tokensIn ?? 0;
    const tokensOut = e.tokensOut ?? 0;
    metrics.llmCallSeconds.observe({ task: e.task, model: e.model }, e.seconds);
    if (tokensIn) metrics.llmTokens.inc({ task: e.task, model: e.model, direction: 'in' }, tokensIn);
    if (tokensOut) metrics.llmTokens.inc({ task: e.task, model: e.model, direction: 'out' }, tokensOut);
    const price = this.deps.prices()[e.model];
    const cost = priced(price)
      ? (tokensIn / 1e6) * (price!.inputMTokens ?? 0) +
        (tokensOut / 1e6) * (price!.outputMTokens ?? 0) +
        (price!.request ?? 0)
      : 0;
    if (priced(price)) metrics.costUsd.inc({ modality: e.modality, model: e.model }, cost);
    else metrics.usageUnpriced.inc({ modality: e.modality, model: e.model });
    const scope = currentUsage();
    if (!scope) return;
    const u = scope.usage;
    u.llmCalls += 1;
    u.llmRetries += e.retries ?? 0;
    u.tokensIn += tokensIn;
    u.tokensOut += tokensOut;
    u.costUsd = round6(u.costUsd + cost);
    if (!priced(price)) u.unpriced += 1;
    const m = this.model(scope, e.model, e.modality)!;
    m.calls += 1;
    m.seconds = round6(m.seconds + e.seconds);
    m.units += tokensIn + tokensOut;
    m.costUsd = round6(m.costUsd + cost);
    if (!priced(price)) m.unpriced += 1;
  }

  /** A gateway task that finished: what it generated and what it cost (the gateway's cost first, else the table). */
  gateway(e: {
    modality: 'image' | 'video' | 'music';
    model: string;
    seconds: number;
    task: GatewayTask;
    /** The duration asked for (video and music), used when the task does not report one. */
    requestedSeconds?: number;
  }): number {
    const { metrics } = this.deps;
    const usage = (e.task.usage ?? {}) as Record<string, unknown>;
    const num = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : undefined);
    const units =
      e.modality === 'image'
        ? (num('output_count') ?? e.task.outputs?.length ?? 1)
        : (num('duration_seconds') ?? num('video_duration') ?? e.requestedSeconds ?? 0);
    const unit = e.modality === 'image' ? 'images' : `${e.modality}_seconds`;
    metrics.gatewayTaskSeconds.observe({ modality: e.modality, model: e.model }, e.seconds);
    metrics.gatewayUsage.inc({ modality: e.modality, model: e.model, unit }, units);
    const price = this.deps.prices()[e.model];
    const reported = num('cost');
    const tablePriced = priced(price);
    const cost =
      reported !== undefined
        ? reported
        : tablePriced
          ? (e.modality === 'image'
              ? units * (price!.image ?? 0)
              : units * ((e.modality === 'video' ? price!.videoSecond : price!.musicSecond) ?? 0)) +
            (price!.request ?? 0)
          : 0;
    const isPriced = reported !== undefined || tablePriced;
    if (isPriced) metrics.costUsd.inc({ modality: e.modality, model: e.model }, cost);
    else metrics.usageUnpriced.inc({ modality: e.modality, model: e.model });
    const scope = currentUsage();
    if (!scope) return cost;
    const u = scope.usage;
    if (e.modality === 'image') u.images += units;
    else if (e.modality === 'video') {
      u.videoSeconds = round6(u.videoSeconds + units);
      u.videoCount += 1;
    } else u.musicSeconds = round6(u.musicSeconds + units);
    u.costUsd = round6(u.costUsd + cost);
    if (!isPriced) u.unpriced += 1;
    const m = this.model(scope, e.model, e.modality)!;
    m.calls += 1;
    m.seconds = round6(m.seconds + e.seconds);
    m.units = round6(m.units + units);
    m.costUsd = round6(m.costUsd + cost);
    if (!isPriced) m.unpriced += 1;
    scope.tasks.set(e.task.id, { seconds: e.modality === 'video' ? units : 0, costUsd: cost });
    return cost;
  }

  /** Video attempts the gate threw away (by gateway task id): their seconds and cost are waste. */
  discard(taskIds: string[]): void {
    const scope = currentUsage();
    if (!scope) return;
    for (const id of taskIds) {
      const t = scope.tasks.get(id);
      if (!t) continue;
      scope.usage.discardedVideoSeconds = round6(scope.usage.discardedVideoSeconds + t.seconds);
      scope.usage.discardedCostUsd = round6(scope.usage.discardedCostUsd + t.costUsd);
      scope.tasks.delete(id);
    }
  }

  /** Characters spoken by TTS (dialogue voices). */
  speech(e: { model: string; characters: number; seconds: number }): void {
    const price = this.deps.prices()[e.model];
    const cost = priced(price) ? e.characters * (price!.character ?? 0) + (price!.request ?? 0) : 0;
    if (priced(price)) this.deps.metrics.costUsd.inc({ modality: 'speech', model: e.model }, cost);
    else this.deps.metrics.usageUnpriced.inc({ modality: 'speech', model: e.model });
    const scope = currentUsage();
    if (!scope) return;
    scope.usage.ttsCharacters += e.characters;
    scope.usage.costUsd = round6(scope.usage.costUsd + cost);
    if (!priced(price)) scope.usage.unpriced += 1;
    const m = this.model(scope, e.model, 'speech')!;
    m.calls += 1;
    m.seconds = round6(m.seconds + e.seconds);
    m.units += e.characters;
    m.costUsd = round6(m.costUsd + cost);
  }
}

/** The usage of a project in `.rideo/usage.json`, written behind the jobs (at most every 5 s, one write at a time). */
/** Tries of a ledger read that fails, and the wait before the next (times the try). */
const READ_TRIES = 3;
const READ_RETRY_MS = 1000;

export class UsageLedger {
  private readonly projects = new Map<string, Promise<ProjectUsage>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly writing = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  /** Projects whose last write failed: warned once until a write succeeds (a browser's project may be offline). */
  private readonly failing = new Set<string>();

  constructor(
    private readonly deps: {
      storage: StorageBackend;
      layout: Layout;
      log: { warn: (o: unknown, m?: string) => void };
      /** How long a change waits before it is written. */
      delayMs?: number;
      /** The project's jobs in the job store, to rebuild a ledger whose file is gone. */
      jobs?: (projectId: string) => Job[];
      /** The wait between tries of a read (tests). */
      retryMs?: number;
    },
  ) {}

  private path(projectId: string): string {
    return `${this.deps.layout.rideoDir(projectId)}/usage.json`;
  }

  /**
   * The project's usage, read once from storage. A ledger that cannot be read rejects (and is read again next time),
   * so nothing is written over it; a missing or broken one is rebuilt from the project's jobs.
   */
  get(projectId: string): Promise<ProjectUsage> {
    let p = this.projects.get(projectId);
    if (!p) {
      const reading = this.read(projectId);
      reading.catch(() => {
        if (this.projects.get(projectId) === reading) this.projects.delete(projectId);
      });
      p = reading;
      this.projects.set(projectId, p);
    }
    return p;
  }

  private async read(projectId: string): Promise<ProjectUsage> {
    const wait = (k: number) => sleep((this.deps.retryMs ?? READ_RETRY_MS) * k);
    let missing = 0;
    for (let failures = 0; ; ) {
      let buf: Buffer | null;
      try {
        buf = await this.deps.storage.read(this.path(projectId));
      } catch (err) {
        // Unreadable is not missing: never start again over a ledger that is there
        if (++failures >= READ_TRIES) throw err;
        await wait(failures);
        continue;
      }
      if (buf) {
        try {
          const parsed = ProjectUsageSchema.safeParse(JSON.parse(buf.toString()));
          if (parsed.success) {
            // A ledger behind the job store (a write lost, or one that replaced it) is rebuilt from the jobs
            const fromJobs = this.rebuild(projectId);
            const behind =
              fromJobs.totals.costUsd > parsed.data.totals.costUsd + 0.005 ||
              fromJobs.totals.videoSeconds > parsed.data.totals.videoSeconds + 0.5 ||
              fromJobs.totals.images > parsed.data.totals.images;
            if (!behind) return parsed.data;
            this.deps.log.warn(
              { projectId, costUsd: parsed.data.totals.costUsd, fromJobs: fromJobs.totals.costUsd },
              'usage ledger behind its jobs; rebuilt from them',
            );
            this.schedule(projectId);
            return fromJobs;
          }
        } catch {
          // a broken file: rebuilt below
        }
        return this.rebuild(projectId);
      }
      // Missing: once more, since slow WebDAV servers answer false 404s
      if (++missing >= 2) return this.rebuild(projectId);
      await wait(1);
    }
  }

  /** A ledger from the project's finished jobs in the job store (empty without them); running ones add themselves. */
  private rebuild(projectId: string): ProjectUsage {
    const ledger: ProjectUsage = {
      version: 1,
      projectId,
      updatedAt: new Date().toISOString(),
      totals: emptyUsage(),
      byKind: {},
    };
    const seconds = (from?: string, to?: string) =>
      from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : 0;
    for (const job of this.deps.jobs?.(projectId) ?? []) {
      const terminal = job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
      if (!terminal) continue;
      if (job.usage) addUsage(ledger.totals, job.usage);
      const k: KindUsage = ledger.byKind[job.kind] ?? KindUsageSchema.parse({});
      ledger.byKind[job.kind] = k;
      k.jobs += 1;
      if (job.status === 'succeeded') k.succeeded += 1;
      else if (job.status === 'failed') k.failed += 1;
      else k.cancelled += 1;
      k.runSeconds = round6(k.runSeconds + seconds(job.startedAt, job.finishedAt));
      k.waitSeconds = round6(k.waitSeconds + seconds(job.createdAt, job.startedAt));
      if (job.usage) k.costUsd = round6(k.costUsd + job.usage.costUsd);
    }
    return ledger;
  }

  /** Adds a finished job run: its usage, its outcome, its run time and how long it waited for its lane. */
  async add(
    job: Pick<Job, 'projectId' | 'kind' | 'status'>,
    run: { usage: Usage | null; runSeconds: number; waitSeconds: number | null; finished: boolean },
  ): Promise<void> {
    const ledger = await this.get(job.projectId);
    if (run.usage) addUsage(ledger.totals, run.usage);
    const k: KindUsage = ledger.byKind[job.kind] ?? KindUsageSchema.parse({});
    ledger.byKind[job.kind] = k;
    if (run.finished) {
      k.jobs += 1;
      if (job.status === 'succeeded') k.succeeded += 1;
      else if (job.status === 'failed') k.failed += 1;
      else if (job.status === 'cancelled') k.cancelled += 1;
    }
    k.runSeconds = round6(k.runSeconds + run.runSeconds);
    if (run.waitSeconds !== null) k.waitSeconds = round6(k.waitSeconds + run.waitSeconds);
    if (run.usage) k.costUsd = round6(k.costUsd + run.usage.costUsd);
    ledger.updatedAt = new Date().toISOString();
    this.schedule(job.projectId);
  }

  private schedule(projectId: string): void {
    if (this.timers.has(projectId)) return;
    const t = setTimeout(() => {
      this.timers.delete(projectId);
      void this.write(projectId);
    }, this.deps.delayMs ?? 5000);
    t.unref();
    this.timers.set(projectId, t);
  }

  private async write(projectId: string): Promise<void> {
    const running = this.writing.get(projectId);
    if (running) {
      this.dirty.add(projectId);
      return running;
    }
    const p = (async () => {
      try {
        const ledger = await this.get(projectId);
        await this.deps.storage.write(this.path(projectId), Buffer.from(JSON.stringify(ledger)));
        this.failing.delete(projectId);
      } catch (err) {
        if (!this.failing.has(projectId))
          this.deps.log.warn({ err: (err as Error).message, projectId }, 'failed to write the usage ledger');
        this.failing.add(projectId);
      } finally {
        this.writing.delete(projectId);
        if (this.dirty.delete(projectId)) void this.write(projectId);
      }
    })();
    this.writing.set(projectId, p);
    return p;
  }

  /** Writes what is pending now (shutdown, tests). */
  async flush(): Promise<void> {
    const ids = [...this.timers.keys()];
    for (const id of ids) {
      clearTimeout(this.timers.get(id)!);
      this.timers.delete(id);
    }
    await Promise.all([...ids.map((id) => this.write(id)), ...this.writing.values()]);
  }
}

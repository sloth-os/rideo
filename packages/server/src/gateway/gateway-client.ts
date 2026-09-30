import {
  type GatewayImageRequest,
  type GatewayMusicRequest,
  type GatewayTask,
  GatewayTaskSchema,
  type GatewayVideoRequest,
  type ModelLimits,
  type ModelLimitsEntry,
  ModelLimitsEntrySchema,
  TERMINAL_TASK_STATUSES,
} from '@rideo/shared';
import sdk, { type HttpInfo, type SdkError, type SdkTask } from '@sloth-os/mm-gateway-js';
import type { Metrics } from '../metrics';
import { abortError, sleep } from '../util/abort';

export type Modality = 'image' | 'video' | 'music';

const RETRYABLE_TASK_CODES = new Set([
  'timeout',
  'rate_limited',
  'provider_unavailable',
  'upstream_error',
  'provider_timeout',
  'internal_error',
]);

export class GatewayHttpError extends Error {
  readonly code = 'gateway_error';
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly problemCode: string | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

export class GatewayTaskError extends Error {
  readonly code = 'gateway_error';
  readonly retryable: boolean;
  constructor(
    readonly taskCode: string,
    message: string,
    readonly task?: GatewayTask,
  ) {
    super(message);
    this.name = 'GatewayTaskError';
    this.retryable = RETRYABLE_TASK_CODES.has(taskCode);
  }
}

export interface GenerateOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  onTask?: (task: GatewayTask) => void;
}

function toHttpError(err: unknown): GatewayHttpError {
  const e = err as SdkError;
  const body = (e?.body ?? e?.response?.body) as
    | { detail?: string; code?: string; title?: string }
    | undefined;
  const status = e?.status;
  const message =
    body?.detail ??
    body?.title ??
    e?.error?.message ??
    (err instanceof Error ? err.message : 'gateway request failed');
  return new GatewayHttpError(
    `mm-gateway ${status ?? 'network'}: ${message}`,
    status,
    body?.code,
    !status || status === 429 || status >= 500,
  );
}

function plain(task: SdkTask): GatewayTask {
  return GatewayTaskSchema.parse(JSON.parse(JSON.stringify(task)));
}

function retryAfterMs(info: HttpInfo<unknown>): number | undefined {
  const raw = info.response?.headers?.['retry-after'];
  const sec = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(sec) ? Math.min(10_000, Math.max(1_000, sec * 1000)) : undefined;
}

/** Image, video and music generation through the @sloth-os/mm-gateway-js SDK (docs/design/ai-gateway.md#sdk-usage). */
export class GatewayClient {
  private readonly client: InstanceType<typeof sdk.ApiClient>;
  private readonly images: InstanceType<typeof sdk.ImagesApi>;
  private readonly videos: InstanceType<typeof sdk.VideosApi>;
  private readonly music: InstanceType<typeof sdk.MusicApi>;
  private readonly meta: InstanceType<typeof sdk.MetaApi>;
  private readonly limitsCache = new Map<Modality, { at: number; entries: ModelLimitsEntry[] }>();

  constructor(
    private readonly cfg: {
      url: string;
      apiKey?: string;
      routingProfile?: string;
      pollMs: number;
      timeoutsSec: Record<Modality, number>;
      metrics?: Metrics;
      log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
    },
  ) {
    this.client = new sdk.ApiClient(cfg.url);
    if (cfg.apiKey) this.client.authentications.BearerAuth.accessToken = cfg.apiKey;
    this.client.timeout = 120_000;
    this.client.defaultHeaders = { 'User-Agent': 'rideo/0.1 (@sloth-os/mm-gateway-js)' };
    this.images = new sdk.ImagesApi(this.client);
    this.videos = new sdk.VideosApi(this.client);
    this.music = new sdk.MusicApi(this.client);
    this.meta = new sdk.MetaApi(this.client);
  }

  async health(): Promise<boolean> {
    try {
      return (await this.meta.getHealth()).status === 'ok';
    } catch {
      return false;
    }
  }

  async modelLimits(modality: Modality): Promise<ModelLimitsEntry[]> {
    const hit = this.limitsCache.get(modality);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.entries;
    try {
      const res = await this.meta.listModelLimits({ modality });
      const entries = (JSON.parse(JSON.stringify(res.data)) as unknown[]).map((e) =>
        ModelLimitsEntrySchema.parse(e),
      );
      this.limitsCache.set(modality, { at: Date.now(), entries });
      return entries;
    } catch (err) {
      throw toHttpError(err);
    }
  }

  /** Limits of a pinned model, or of the gateway's first listed model when routing is `auto` (planning reference). */
  async limitsFor(
    modality: Modality,
    model: string,
  ): Promise<{ model: string | null; limits: ModelLimits | null }> {
    const entries = await this.modelLimits(modality).catch(() => [] as ModelLimitsEntry[]);
    const entry = model && model !== 'auto' ? entries.find((e) => e.id === model) : entries[0];
    return { model: entry?.id ?? null, limits: entry?.limits ?? null };
  }

  generateImage(req: GatewayImageRequest, opts: GenerateOptions): Promise<GatewayTask> {
    return this.run('image', req, opts);
  }

  generateVideo(req: GatewayVideoRequest, opts: GenerateOptions): Promise<GatewayTask> {
    return this.run('video', req, opts);
  }

  generateMusic(req: GatewayMusicRequest, opts: GenerateOptions): Promise<GatewayTask> {
    return this.run('music', req, opts);
  }

  private create(modality: Modality, body: object, key: string): Promise<HttpInfo<SdkTask>> {
    if (modality === 'image') return this.images.createImageWithHttpInfo(body, { idempotencyKey: key });
    if (modality === 'video') return this.videos.createVideoWithHttpInfo(body, { idempotencyKey: key });
    return this.music.createMusicWithHttpInfo(body, { idempotencyKey: key });
  }

  private get(modality: Modality, id: string): Promise<HttpInfo<SdkTask>> {
    if (modality === 'image') return this.images.getImageWithHttpInfo(id);
    if (modality === 'video') return this.videos.getVideoWithHttpInfo(id);
    return this.music.getMusicWithHttpInfo(id);
  }

  private async run(
    modality: Modality,
    req: GatewayImageRequest | GatewayVideoRequest | GatewayMusicRequest,
    opts: GenerateOptions,
  ): Promise<GatewayTask> {
    const body = {
      ...req,
      ...(this.cfg.routingProfile && !req.routing ? { routing: { profile: this.cfg.routingProfile } } : {}),
      metadata: { ...req.metadata, ...opts.metadata },
    };
    if (opts.signal?.aborted) throw abortError();
    let info: HttpInfo<SdkTask>;
    try {
      info = await this.create(modality, body, opts.idempotencyKey);
    } catch (err) {
      const e = toHttpError(err);
      this.cfg.metrics?.gatewayTasks.inc({ modality, status: 'rejected' });
      throw e;
    }
    let task = plain(info.data);
    opts.onTask?.(task);
    this.cfg.log?.info({ modality, taskId: task.id, model: task.model }, 'gateway task created');
    const deadline = Date.now() + this.cfg.timeoutsSec[modality] * 1000;
    let transient = 0;
    while (!TERMINAL_TASK_STATUSES.includes(task.status)) {
      if (Date.now() > deadline) {
        this.cfg.metrics?.gatewayTasks.inc({ modality, status: 'timeout' });
        throw new GatewayTaskError(
          'timeout',
          `${modality} task ${task.id} did not finish in ${this.cfg.timeoutsSec[modality]}s`,
          task,
        );
      }
      await sleep(retryAfterMs(info) ?? this.cfg.pollMs, opts.signal);
      try {
        info = await this.get(modality, task.id);
        transient = 0;
      } catch (err) {
        const e = toHttpError(err);
        if (e.retryable && ++transient <= 5) {
          this.cfg.log?.warn({ modality, taskId: task.id, err: e.message }, 'gateway poll failed, retrying');
          continue;
        }
        throw e;
      }
      task = plain(info.data);
      opts.onTask?.(task);
    }
    this.cfg.metrics?.gatewayTasks.inc({ modality, status: task.status });
    if (task.status !== 'succeeded') {
      throw new GatewayTaskError(
        task.error?.code ?? task.status,
        task.error?.message ?? `${modality} task ${task.status}`,
        task,
      );
    }
    if (!task.outputs?.length)
      throw new GatewayTaskError('no_output', `${modality} task ${task.id} returned no outputs`, task);
    return task;
  }
}

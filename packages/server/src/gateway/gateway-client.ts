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
import {
  Configuration,
  type ImageRequest,
  ImagesApi,
  MetaApi,
  MusicApi,
  type MusicRequest,
  type VideoRequest,
  VideosApi,
} from '@sloth-os/mm-gateway-ts';
import axios, { type AxiosResponse, isAxiosError, isCancel } from 'axios';
import type { Metrics } from '../metrics';
import type { UsageMeter } from '../usage/meter';
import { abortError, sleep } from '../util/abort';
import { gatewayNotConfigured } from './proxy-client';

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

/** The SDK's generated request type of each modality: Rideo's wire objects must be assignable to it. */
interface WireRequest {
  image: ImageRequest;
  video: VideoRequest;
  music: MusicRequest;
}

/** Create and poll calls of one modality's API (`ImagesApi`, `VideosApi`, `MusicApi`). */
type TaskCalls = {
  [M in Modality]: {
    create(
      body: WireRequest[M],
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<AxiosResponse<object>>;
    get(id: string, signal?: AbortSignal): Promise<AxiosResponse<object>>;
  };
};

/** An axios rejection as the error the job queue classifies; a cancelled request is the job's abort. */
function toError(err: unknown, signal?: AbortSignal): Error {
  if (isCancel(err) || signal?.aborted) return abortError(String(signal?.reason ?? 'aborted'));
  if (!isAxiosError(err)) return err instanceof Error ? err : new Error(String(err));
  const status = err.response?.status;
  const body = err.response?.data as { detail?: string; code?: string; title?: string } | string | undefined;
  const problem = body && typeof body === 'object' ? body : undefined;
  return new GatewayHttpError(
    `mm-gateway ${status ?? 'network'}: ${problem?.detail ?? problem?.title ?? err.message}`,
    status,
    problem?.code,
    !status || status === 429 || status >= 500,
  );
}

function task(res: AxiosResponse<object>): GatewayTask {
  return GatewayTaskSchema.parse(res.data);
}

/** Retry-After in ms, clamped to [1 s, 10 s]. */
function retryAfterMs(res: AxiosResponse): number | undefined {
  const raw = res.headers['retry-after'];
  const sec = typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(sec) ? Math.min(10_000, Math.max(1_000, sec * 1000)) : undefined;
}

/** Image, video and music generation through the @sloth-os/mm-gateway-ts SDK (docs/design/ai-gateway.md#sdk-usage). */
export class GatewayClient {
  private readonly calls: TaskCalls;
  private readonly meta: MetaApi;
  private readonly limitsCache = new Map<Modality, { at: number; entries: ModelLimitsEntry[] }>();

  constructor(
    private readonly cfg: {
      /** Unset: no gateway; every call fails with `gateway_not_configured`. */
      url?: string;
      apiKey?: string;
      routingProfile?: string;
      pollMs: number;
      timeoutsSec: Record<Modality, number>;
      metrics?: Metrics;
      log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
      /** Usage and cost of finished tasks (docs/design/observability.md#usage-ledger). */
      meter?: UsageMeter;
    },
  ) {
    const configuration = new Configuration({
      basePath: (cfg.url ?? 'http://gateway.invalid').replace(/\/+$/, ''),
      accessToken: cfg.apiKey,
    });
    // A direct connection, like the proxy client's fetch: environment proxies are not used.
    const http = axios.create({
      timeout: 120_000,
      proxy: false,
      headers: { 'User-Agent': 'rideo/0.1 (@sloth-os/mm-gateway-ts)' },
    });
    const images = new ImagesApi(configuration, undefined, http);
    const videos = new VideosApi(configuration, undefined, http);
    const music = new MusicApi(configuration, undefined, http);
    this.meta = new MetaApi(configuration, undefined, http);
    this.calls = {
      image: {
        create: (body, key, signal) => images.createImage(body, key, { signal }),
        get: (id, signal) => images.getImage(id, undefined, { signal }),
      },
      video: {
        create: (body, key, signal) => videos.createVideo(body, key, { signal }),
        get: (id, signal) => videos.getVideo(id, undefined, { signal }),
      },
      music: {
        create: (body, key, signal) => music.createMusic(body, key, { signal }),
        get: (id, signal) => music.getMusic(id, undefined, { signal }),
      },
    };
  }

  get configured(): boolean {
    return !!this.cfg.url;
  }

  async health(): Promise<boolean> {
    if (!this.cfg.url) return false;
    try {
      return (await this.meta.getHealth()).data.status === 'ok';
    } catch {
      return false;
    }
  }

  async modelLimits(modality: Modality): Promise<ModelLimitsEntry[]> {
    if (!this.cfg.url) throw gatewayNotConfigured();
    const hit = this.limitsCache.get(modality);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.entries;
    try {
      const res = await this.meta.listModelLimits(modality);
      const entries = res.data.data.map((e) => ModelLimitsEntrySchema.parse(e));
      this.limitsCache.set(modality, { at: Date.now(), entries });
      return entries;
    } catch (err) {
      throw toError(err);
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

  private async run<M extends Modality>(
    modality: M,
    req: WireRequest[M],
    opts: GenerateOptions,
  ): Promise<GatewayTask> {
    if (!this.cfg.url) throw gatewayNotConfigured();
    const calls: TaskCalls[M] = this.calls[modality];
    const body: WireRequest[M] = {
      ...req,
      ...(this.cfg.routingProfile && !req.routing ? { routing: { profile: this.cfg.routingProfile } } : {}),
      // No visible provider watermark: Rideo marks its own output (docs/design/provenance.md#provider-watermarks)
      ...(modality === 'music' ? {} : { parameters: { watermark: false, ...req.parameters } }),
      metadata: { ...req.metadata, ...opts.metadata },
    };
    if (opts.signal?.aborted) throw abortError();
    const started = Date.now();
    let res: AxiosResponse<object>;
    try {
      res = await calls.create(body, opts.idempotencyKey, opts.signal);
    } catch (err) {
      const e = toError(err, opts.signal);
      if (e instanceof GatewayHttpError) this.cfg.metrics?.gatewayTasks.inc({ modality, status: 'rejected' });
      throw e;
    }
    let current = task(res);
    opts.onTask?.(current);
    this.cfg.log?.info({ modality, taskId: current.id, model: current.model }, 'gateway task created');
    const deadline = Date.now() + this.cfg.timeoutsSec[modality] * 1000;
    let transient = 0;
    while (!TERMINAL_TASK_STATUSES.includes(current.status)) {
      if (Date.now() > deadline) {
        this.cfg.metrics?.gatewayTasks.inc({ modality, status: 'timeout' });
        throw new GatewayTaskError(
          'timeout',
          `${modality} task ${current.id} did not finish in ${this.cfg.timeoutsSec[modality]}s`,
          current,
        );
      }
      // A sub-second poll interval is a fast-poll mode (tests, local mocks); otherwise honour Retry-After.
      await sleep(
        this.cfg.pollMs < 1000 ? this.cfg.pollMs : (retryAfterMs(res) ?? this.cfg.pollMs),
        opts.signal,
      );
      try {
        res = await calls.get(current.id, opts.signal);
        transient = 0;
      } catch (err) {
        const e = toError(err, opts.signal);
        if (e instanceof GatewayHttpError && e.retryable && ++transient <= 5) {
          this.cfg.log?.warn(
            { modality, taskId: current.id, err: e.message },
            'gateway poll failed, retrying',
          );
          continue;
        }
        throw e;
      }
      current = task(res);
      opts.onTask?.(current);
    }
    this.cfg.metrics?.gatewayTasks.inc({ modality, status: current.status });
    if (current.status !== 'succeeded') {
      throw new GatewayTaskError(
        current.error?.code ?? current.status,
        current.error?.message ?? `${modality} task ${current.status}`,
        current,
      );
    }
    if (!current.outputs?.length)
      throw new GatewayTaskError('no_output', `${modality} task ${current.id} returned no outputs`, current);
    const params = (req as { parameters?: { duration_seconds?: number } }).parameters;
    this.cfg.meter?.gateway({
      modality,
      model: current.model || (req as { model?: string }).model || 'auto',
      seconds: (Date.now() - started) / 1000,
      task: current,
      requestedSeconds: params?.duration_seconds,
    });
    return current;
  }
}

import type { SttClient } from '../ai/llm';
import type { LlmTasks } from '../ai/tasks';
import type { Config } from '../config';
import type { ConsistencyJudge } from '../consistency/judge';
import type { GatewayClient } from '../gateway/gateway-client';
import type { JobQueue } from '../jobs/queue';
import type { LiveHub } from '../live/hub';
import type { Ffmpeg } from '../media/ffmpeg';
import type { Staging } from '../media/staging';
import type { MediaStore } from '../media/store';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import type { WatermarkService } from '../watermark/service';
import type { ProjectRegistry } from './registry';

export interface Logger {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
  debug: (o: unknown, m?: string) => void;
  child: (bindings: object) => Logger;
}

/** Everything application services and job handlers depend on (built once in studio.ts). */
export interface Deps {
  config: Config;
  log: Logger;
  metrics: Metrics;
  storage: StorageBackend;
  layout: Layout;
  projects: ProjectRegistry;
  media: MediaStore;
  ff: Ffmpeg;
  gateway: GatewayClient;
  llm: LlmTasks;
  judge: ConsistencyJudge;
  offJudge: ConsistencyJudge;
  watermark: WatermarkService;
  hub: LiveHub;
  jobs: JobQueue;
  /** Editor-job uploads on the server's disk. */
  staging: Staging;
  stt?: SttClient;
}

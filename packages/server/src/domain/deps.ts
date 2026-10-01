import type { SttClient } from '../ai/llm';
import type { SfxClient } from '../ai/sfx';
import type { LlmTasks } from '../ai/tasks';
import type { TtsClient } from '../ai/tts';
import type { Config } from '../config';
import type { ConsistencyJudge } from '../consistency/judge';
import type { VoiceJudge } from '../consistency/voice';
import type { GatewayClient } from '../gateway/gateway-client';
import type { JobQueue } from '../jobs/queue';
import type { LiveHub } from '../live/hub';
import type { Ffmpeg } from '../media/ffmpeg';
import type { Staging } from '../media/staging';
import type { MediaStore } from '../media/store';
import type { Metrics } from '../metrics';
import type { C2paService } from '../provenance/c2pa';
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
  /** C2PA Content Credentials for takes and exports. */
  c2pa: C2paService;
  hub: LiveHub;
  jobs: JobQueue;
  /** Editor-job uploads on the server's disk. */
  staging: Staging;
  stt?: SttClient;
  /** Dialogue voices through the gateway proxy (docs/design/dialogue.md); absent when TTS is off. */
  tts?: TtsClient;
  /** Sound effects through the gateway proxy (docs/design/post-audio.md); absent when SFX is off. */
  sfx?: SfxClient;
  /** Speaker check of native-audio takes (rule V4); null when no audio-capable model is configured. */
  voiceJudge: VoiceJudge | null;
}

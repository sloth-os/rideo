import { z } from 'zod';

/** Every runtime setting, parsed once from the environment (docs/deployment.md). */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
    );
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());
const str = (def?: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v));

const LLM_DEFAULT_DOMAINS = {
  openai: 'api.openai.com',
  gemini: 'generativelanguage.googleapis.com',
  anthropic: 'api.anthropic.com',
} as const;

export const EnvSchema = z.object({
  RIDEO_HOST: str('0.0.0.0'),
  RIDEO_PORT: num(8787),
  RIDEO_PUBLIC_URL: str(),
  RIDEO_API_TOKEN: str(),
  RIDEO_USER_ID: str('local'),
  RIDEO_USER_NAME: str('You'),
  RIDEO_DATA_DIR: str('./data'),
  RIDEO_CACHE_MAX_BYTES: num(5 * 1024 ** 3),
  RIDEO_WEB_DIST: str(),
  RIDEO_LOG_LEVEL: str('info'),
  RIDEO_WEBDAV_URL: str(),
  RIDEO_WEBDAV_USERNAME: str(),
  RIDEO_WEBDAV_PASSWORD: str(),
  RIDEO_WEBDAV_ROOT: str('/rideo'),
  RIDEO_EMBEDDED_DAV: z.enum(['auto', 'true', 'false']).optional().default('auto'),
  RIDEO_DAV_USERNAME: str(),
  RIDEO_DAV_PASSWORD: str(),
  RIDEO_WEBDAV_SYNC_INTERVAL_SEC: num(15),
  RIDEO_COALESCE_WINDOW_SEC: num(30),
  MM_GATEWAY_URL: str('http://localhost:8000'),
  MM_GATEWAY_API_KEY: str(),
  MM_GATEWAY_ROUTING_PROFILE: str(),
  RIDEO_IMAGE_MODEL: str('auto'),
  RIDEO_VIDEO_MODEL: str('auto'),
  RIDEO_MUSIC_MODEL: str('auto'),
  RIDEO_GATEWAY_POLL_MS: num(2000),
  RIDEO_GATEWAY_TIMEOUT_IMAGE_SEC: num(300),
  RIDEO_GATEWAY_TIMEOUT_VIDEO_SEC: num(1200),
  RIDEO_GATEWAY_TIMEOUT_MUSIC_SEC: num(600),
  RIDEO_LLM_PROVIDER: z.enum(['openai', 'gemini', 'anthropic']).optional().default('openai'),
  RIDEO_LLM_PROXY_DOMAIN: str(),
  RIDEO_LLM_MODEL: str('gpt-4.1-mini'),
  RIDEO_VISION_PROVIDER: z.enum(['openai', 'gemini', 'anthropic']).optional(),
  RIDEO_VISION_PROXY_DOMAIN: str(),
  RIDEO_VISION_MODEL: str(),
  RIDEO_STT_PROXY_DOMAIN: str(),
  RIDEO_STT_MODEL: str('whisper-1'),
  RIDEO_CONSISTENCY_JUDGE: z.enum(['vision-llm', 'off']).optional().default('vision-llm'),
  RIDEO_CONSISTENCY_THRESHOLD: num(0.75),
  RIDEO_CONSISTENCY_MAX_ATTEMPTS: num(3),
  RIDEO_LANES: str(''),
  RIDEO_WATERMARK_KEY: str(),
  RIDEO_WATERMARK_KEYS_OLD: str(''),
  RIDEO_WATERMARK_STRENGTH: num(16),
  RIDEO_BRAND_NAME: str('Rideo'),
  RIDEO_BRAND_OWNER: str(''),
  RIDEO_BRAND_URL: str(''),
  RIDEO_FFMPEG_PATH: str('ffmpeg'),
  RIDEO_FFPROBE_PATH: str('ffprobe'),
  RIDEO_FONT_FILE: str(),
  RIDEO_MEDIA_URI_MODE: z.enum(['data', 'url']).optional().default('data'),
  RIDEO_JOB_RECOVERY: bool(true),
  NODE_ENV: str('development'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface LlmEndpoint {
  provider: 'openai' | 'gemini' | 'anthropic';
  domain: string;
  model: string;
}

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  apiToken?: string;
  user: { id: string; name: string };
  dataDir: string;
  cacheMaxBytes: number;
  webDist?: string;
  logLevel: string;
  production: boolean;
  webdav: {
    url?: string;
    username?: string;
    password?: string;
    root: string;
    embedded: boolean;
    davUsername?: string;
    davPassword?: string;
    syncIntervalSec: number;
  };
  coalesceWindowSec: number;
  gateway: {
    url: string;
    apiKey?: string;
    routingProfile?: string;
    models: { image: string; video: string; music: string };
    pollMs: number;
    timeoutsSec: { image: number; video: number; music: number };
  };
  llm: LlmEndpoint;
  vision: LlmEndpoint;
  stt?: { domain: string; model: string };
  consistency: { judge: 'vision-llm' | 'off'; threshold: number; maxAttempts: number };
  lanes: Record<string, number>;
  watermark: { key?: string; oldKeys: string[]; strength: number };
  brand: { name: string; owner: string; url: string };
  ffmpegPath: string;
  ffprobePath: string;
  fontFile?: string;
  mediaUriMode: 'data' | 'url';
  jobRecovery: boolean;
}

export const DEFAULT_LANES: Record<string, number> = {
  control: 16,
  llm: 2,
  image: 2,
  video: 2,
  music: 1,
  media: 1,
};

export function parseLanes(spec: string | undefined): Record<string, number> {
  const lanes = { ...DEFAULT_LANES };
  for (const part of (spec ?? '').split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (k && v && Number(v) > 0) lanes[k] = Math.floor(Number(v));
  }
  return lanes;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Config> = {},
): Config {
  const e = EnvSchema.parse(env);
  const port = e.RIDEO_PORT;
  const embedded =
    e.RIDEO_EMBEDDED_DAV === 'true' || (e.RIDEO_EMBEDDED_DAV === 'auto' && !e.RIDEO_WEBDAV_URL);
  const llmProvider = e.RIDEO_LLM_PROVIDER;
  const visionProvider = e.RIDEO_VISION_PROVIDER ?? llmProvider;
  const cfg: Config = {
    host: e.RIDEO_HOST!,
    port,
    publicUrl: (e.RIDEO_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    apiToken: e.RIDEO_API_TOKEN,
    user: { id: e.RIDEO_USER_ID!, name: e.RIDEO_USER_NAME! },
    dataDir: e.RIDEO_DATA_DIR!,
    cacheMaxBytes: e.RIDEO_CACHE_MAX_BYTES,
    webDist: e.RIDEO_WEB_DIST,
    logLevel: e.RIDEO_LOG_LEVEL!,
    production: e.NODE_ENV === 'production',
    webdav: {
      url: e.RIDEO_WEBDAV_URL,
      username: e.RIDEO_WEBDAV_USERNAME,
      password: e.RIDEO_WEBDAV_PASSWORD,
      root: `/${e.RIDEO_WEBDAV_ROOT!.replace(/^\/+|\/+$/g, '')}`,
      embedded,
      davUsername: e.RIDEO_DAV_USERNAME,
      davPassword: e.RIDEO_DAV_PASSWORD,
      syncIntervalSec: e.RIDEO_WEBDAV_SYNC_INTERVAL_SEC,
    },
    coalesceWindowSec: e.RIDEO_COALESCE_WINDOW_SEC,
    gateway: {
      url: e.MM_GATEWAY_URL!.replace(/\/+$/, ''),
      apiKey: e.MM_GATEWAY_API_KEY,
      routingProfile: e.MM_GATEWAY_ROUTING_PROFILE,
      models: { image: e.RIDEO_IMAGE_MODEL!, video: e.RIDEO_VIDEO_MODEL!, music: e.RIDEO_MUSIC_MODEL! },
      pollMs: e.RIDEO_GATEWAY_POLL_MS,
      timeoutsSec: {
        image: e.RIDEO_GATEWAY_TIMEOUT_IMAGE_SEC,
        video: e.RIDEO_GATEWAY_TIMEOUT_VIDEO_SEC,
        music: e.RIDEO_GATEWAY_TIMEOUT_MUSIC_SEC,
      },
    },
    llm: {
      provider: llmProvider,
      domain: e.RIDEO_LLM_PROXY_DOMAIN ?? LLM_DEFAULT_DOMAINS[llmProvider],
      model: e.RIDEO_LLM_MODEL!,
    },
    vision: {
      provider: visionProvider,
      domain:
        e.RIDEO_VISION_PROXY_DOMAIN ??
        (visionProvider === llmProvider
          ? (e.RIDEO_LLM_PROXY_DOMAIN ?? LLM_DEFAULT_DOMAINS[visionProvider])
          : LLM_DEFAULT_DOMAINS[visionProvider]),
      model: e.RIDEO_VISION_MODEL ?? e.RIDEO_LLM_MODEL!,
    },
    stt: e.RIDEO_STT_PROXY_DOMAIN
      ? { domain: e.RIDEO_STT_PROXY_DOMAIN, model: e.RIDEO_STT_MODEL! }
      : undefined,
    consistency: {
      judge: e.RIDEO_CONSISTENCY_JUDGE,
      threshold: e.RIDEO_CONSISTENCY_THRESHOLD,
      maxAttempts: Math.max(1, Math.floor(e.RIDEO_CONSISTENCY_MAX_ATTEMPTS)),
    },
    lanes: parseLanes(e.RIDEO_LANES),
    watermark: {
      key: e.RIDEO_WATERMARK_KEY,
      oldKeys: (e.RIDEO_WATERMARK_KEYS_OLD ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      strength: e.RIDEO_WATERMARK_STRENGTH,
    },
    brand: { name: e.RIDEO_BRAND_NAME!, owner: e.RIDEO_BRAND_OWNER ?? '', url: e.RIDEO_BRAND_URL ?? '' },
    ffmpegPath: e.RIDEO_FFMPEG_PATH!,
    ffprobePath: e.RIDEO_FFPROBE_PATH!,
    fontFile: e.RIDEO_FONT_FILE,
    mediaUriMode: e.RIDEO_MEDIA_URI_MODE,
    jobRecovery: e.RIDEO_JOB_RECOVERY,
  };
  return { ...cfg, ...overrides };
}

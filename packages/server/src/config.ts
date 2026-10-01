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

/** A comma-separated list, lowercased. */
const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

export const EnvSchema = z.object({
  RIDEO_HOST: str('0.0.0.0'),
  RIDEO_PORT: num(8787),
  RIDEO_PUBLIC_URL: str(),
  RIDEO_API_TOKEN: str(),
  RIDEO_USER_ID: str('local'),
  RIDEO_USER_NAME: str('You'),
  // Accounts (docs/design/accounts.md)
  RIDEO_OIDC_ISSUER: str(),
  RIDEO_OIDC_CLIENT_ID: str(),
  RIDEO_OIDC_CLIENT_SECRET: str(),
  RIDEO_OIDC_SCOPES: str('openid profile email'),
  RIDEO_OIDC_NAME: str('your identity provider'),
  RIDEO_ADMINS: str(''),
  RIDEO_OIDC_ALLOWED_DOMAINS: str(''),
  RIDEO_SESSION_DAYS: num(14),
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
  RIDEO_TTS_PROVIDER: z.enum(['elevenlabs', 'openai', 'off']).optional().default('off'),
  RIDEO_TTS_PROXY_DOMAIN: str(),
  RIDEO_TTS_MODEL: str(),
  RIDEO_SFX_PROVIDER: z.enum(['elevenlabs', 'off']).optional().default('off'),
  RIDEO_SFX_PROXY_DOMAIN: str('api.elevenlabs.io'),
  RIDEO_SFX_MODEL: str('eleven_text_to_sound_v2'),
  RIDEO_LIPSYNC_MODEL: str('auto'),
  RIDEO_EDIT_MODEL: str('auto'),
  RIDEO_ENHANCE_MODEL: str('auto'),
  RIDEO_VOICE_JUDGE_PROVIDER: z.enum(['openai', 'gemini', 'off']).optional(),
  RIDEO_VOICE_JUDGE_PROXY_DOMAIN: str(),
  RIDEO_VOICE_JUDGE_MODEL: str(),
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
  RIDEO_C2PA: z.enum(['on', 'off']).optional().default('on'),
  RIDEO_C2PA_CERT: str(),
  RIDEO_C2PA_KEY: str(),
  RIDEO_C2PA_TSA_URL: str(),
  RIDEO_C2PA_TRUST_ANCHORS: str(),
  RIDEO_PUBLIC_DETECT_MAX_BYTES: num(512 * 1024 ** 2),
  RIDEO_FFMPEG_PATH: str('ffmpeg'),
  RIDEO_FFPROBE_PATH: str('ffprobe'),
  RIDEO_EDITOR_LEASE_SEC: num(60),
  RIDEO_EDITOR_FILE_MAX_BYTES: num(4 * 1024 ** 3),
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

/** Text-to-speech through the gateway proxy (docs/design/dialogue.md#providers). */
export interface TtsEndpoint {
  provider: 'elevenlabs' | 'openai';
  domain: string;
  model: string;
}

const TTS_DEFAULTS = {
  elevenlabs: { domain: 'api.elevenlabs.io', model: 'eleven_multilingual_v2' },
  openai: { domain: 'api.openai.com', model: 'gpt-4o-mini-tts' },
} as const;

/** Sound effects through the gateway proxy (docs/design/post-audio.md#effects-from-action-lines). */
export interface SfxEndpoint {
  provider: 'elevenlabs';
  domain: string;
  model: string;
}

const VOICE_JUDGE_DEFAULT_MODELS = { openai: 'gpt-4o-audio-preview', gemini: 'gemini-2.5-flash' } as const;

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  apiToken?: string;
  user: { id: string; name: string };
  /** Accounts (docs/design/accounts.md): OIDC sign-in when `oidc` is set. */
  auth: {
    oidc?: { issuer: string; clientId: string; clientSecret?: string; scopes: string; name: string };
    /** Emails that are administrators. */
    admins: string[];
    /** Email domains that may join (empty: anyone the provider signs in). */
    allowedDomains: string[];
    sessionDays: number;
  };
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
    models: { image: string; video: string; music: string; lipSync: string; edit: string; enhance: string };
    pollMs: number;
    timeoutsSec: { image: number; video: number; music: number };
  };
  llm: LlmEndpoint;
  vision: LlmEndpoint;
  stt?: { domain: string; model: string };
  /** Dialogue voices; unset when RIDEO_TTS_PROVIDER=off. */
  tts?: TtsEndpoint;
  /** Generated sound effects; unset when RIDEO_SFX_PROVIDER=off. */
  sfx?: SfxEndpoint;
  /** The audio-capable LLM that checks speakers of native-audio takes (rule V4). */
  voiceJudge?: { provider: 'openai' | 'gemini'; domain: string; model: string };
  consistency: { judge: 'vision-llm' | 'off'; threshold: number; maxAttempts: number };
  lanes: Record<string, number>;
  watermark: { key?: string; oldKeys: string[]; strength: number };
  brand: { name: string; owner: string; url: string };
  /** C2PA Content Credentials (docs/design/provenance.md#signing-credentials). */
  c2pa: { enabled: boolean; cert?: string; key?: string; tsaUrl?: string; trustAnchors?: string };
  /** Largest upload the public detection endpoint accepts. */
  publicDetectMaxBytes: number;
  ffmpegPath: string;
  ffprobePath: string;
  /** Editor jobs (docs/design/editor.md#editor-jobs). */
  editor: { leaseSec: number; fileMaxBytes: number };
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
    auth: {
      oidc: e.RIDEO_OIDC_ISSUER
        ? {
            issuer: e.RIDEO_OIDC_ISSUER,
            clientId: (() => {
              if (!e.RIDEO_OIDC_CLIENT_ID)
                throw new Error('RIDEO_OIDC_CLIENT_ID is required with RIDEO_OIDC_ISSUER');
              return e.RIDEO_OIDC_CLIENT_ID;
            })(),
            clientSecret: e.RIDEO_OIDC_CLIENT_SECRET,
            scopes: e.RIDEO_OIDC_SCOPES!,
            name: e.RIDEO_OIDC_NAME!,
          }
        : undefined,
      admins: list(e.RIDEO_ADMINS),
      allowedDomains: list(e.RIDEO_OIDC_ALLOWED_DOMAINS),
      sessionDays: e.RIDEO_SESSION_DAYS,
    },
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
      models: {
        image: e.RIDEO_IMAGE_MODEL!,
        video: e.RIDEO_VIDEO_MODEL!,
        music: e.RIDEO_MUSIC_MODEL!,
        lipSync: e.RIDEO_LIPSYNC_MODEL!,
        edit: e.RIDEO_EDIT_MODEL!,
        enhance: e.RIDEO_ENHANCE_MODEL!,
      },
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
    tts:
      e.RIDEO_TTS_PROVIDER === 'off'
        ? undefined
        : {
            provider: e.RIDEO_TTS_PROVIDER,
            domain: e.RIDEO_TTS_PROXY_DOMAIN ?? TTS_DEFAULTS[e.RIDEO_TTS_PROVIDER].domain,
            model: e.RIDEO_TTS_MODEL ?? TTS_DEFAULTS[e.RIDEO_TTS_PROVIDER].model,
          },
    sfx:
      e.RIDEO_SFX_PROVIDER === 'off'
        ? undefined
        : { provider: e.RIDEO_SFX_PROVIDER, domain: e.RIDEO_SFX_PROXY_DOMAIN!, model: e.RIDEO_SFX_MODEL! },
    voiceJudge: (() => {
      // Defaults to the vision provider when it accepts audio (Anthropic models do not).
      const provider =
        e.RIDEO_VOICE_JUDGE_PROVIDER ?? (visionProvider === 'anthropic' ? 'off' : visionProvider);
      if (provider === 'off') return undefined;
      return {
        provider,
        domain:
          e.RIDEO_VOICE_JUDGE_PROXY_DOMAIN ??
          (provider === visionProvider && e.RIDEO_VISION_PROXY_DOMAIN
            ? e.RIDEO_VISION_PROXY_DOMAIN
            : LLM_DEFAULT_DOMAINS[provider]),
        model: e.RIDEO_VOICE_JUDGE_MODEL ?? VOICE_JUDGE_DEFAULT_MODELS[provider],
      };
    })(),
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
    c2pa: {
      enabled: e.RIDEO_C2PA === 'on',
      cert: e.RIDEO_C2PA_CERT,
      key: e.RIDEO_C2PA_KEY,
      tsaUrl: e.RIDEO_C2PA_TSA_URL,
      trustAnchors: e.RIDEO_C2PA_TRUST_ANCHORS,
    },
    publicDetectMaxBytes: e.RIDEO_PUBLIC_DETECT_MAX_BYTES,
    ffmpegPath: e.RIDEO_FFMPEG_PATH!,
    ffprobePath: e.RIDEO_FFPROBE_PATH!,
    editor: { leaseSec: e.RIDEO_EDITOR_LEASE_SEC, fileMaxBytes: e.RIDEO_EDITOR_FILE_MAX_BYTES },
    mediaUriMode: e.RIDEO_MEDIA_URI_MODE,
    jobRecovery: e.RIDEO_JOB_RECOVERY,
  };
  return { ...cfg, ...overrides };
}

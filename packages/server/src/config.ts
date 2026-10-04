import { parseThemeJson, type Theme, ThemeSchema } from '@rideo/shared';
import { z } from 'zod';

/**
 * Every runtime setting, parsed once from the environment merged over the studio's settings file
 * (docs/deployment.md, docs/design/settings.md).
 */
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

/** A base path (docs/design/subpath.md): `/a/b`, no trailing slash; '' for the root. */
export function normalizeBasePath(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  return /^(\/[A-Za-z0-9._~-]+)+$/.test(trimmed) && !/(^|\/)\.{1,2}(\/|$)/.test(trimmed) ? trimmed : null;
}

const basePath = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    const p = normalizeBasePath(v);
    if (p === null) {
      ctx.addIssue({ code: 'custom', message: 'a path like /rideo (letters, digits, . _ ~ -)' });
      return z.NEVER;
    }
    return p;
  });

const theme = z
  .string()
  .optional()
  .transform((v, ctx): Theme | null => {
    try {
      return parseThemeJson(v);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message:
          err instanceof z.ZodError
            ? `invalid theme: ${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
            : (err as Error).message,
      });
      return z.NEVER;
    }
  });

export const EnvSchema = z
  .object({
    RIDEO_HOST: str('0.0.0.0'),
    RIDEO_PORT: num(8787),
    RIDEO_PUBLIC_URL: str(),
    /** Serving under a subpath (docs/design/subpath.md); default: the path of RIDEO_PUBLIC_URL. */
    RIDEO_BASE_PATH: basePath,
    /** Origins whose pages may use this server through the studio library (docs/design/embedding.md). */
    RIDEO_CORS_ORIGINS: str(''),
    /** The studio theme (docs/design/embedding.md#themes), JSON. */
    RIDEO_THEME: theme,
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
    /** Where projects live (docs/design/browser-storage.md); `auto` is resolved at start (docs/design/settings.md). */
    RIDEO_STORAGE: z.enum(['auto', 'browser', 'webdav', 'embedded']).optional().default('auto'),
    RIDEO_WEBDAV_URL: str(),
    RIDEO_WEBDAV_USERNAME: str(),
    RIDEO_WEBDAV_PASSWORD: str(),
    RIDEO_WEBDAV_ROOT: str('/rideo'),
    RIDEO_EMBEDDED_DAV: z.enum(['auto', 'true', 'false']).optional().default('auto'),
    RIDEO_DAV_USERNAME: str(),
    RIDEO_DAV_PASSWORD: str(),
    RIDEO_WEBDAV_SYNC_INTERVAL_SEC: num(15),
    RIDEO_COALESCE_WINDOW_SEC: num(30),
    /** No default: without a gateway the studio runs without AI (docs/design/settings.md#without-mm-gateway). */
    MM_GATEWAY_URL: str(),
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
    /** Web Push (docs/design/pwa.md#notifications-on-the-phone-web-push): VAPID keys, made once when unset. */
    RIDEO_VAPID_PUBLIC_KEY: str(),
    RIDEO_VAPID_PRIVATE_KEY: str(),
    RIDEO_VAPID_SUBJECT: str('mailto:rideo@localhost'),
    /** Plain-HTTP push endpoints (tests only; push services are HTTPS). */
    RIDEO_PUSH_ALLOW_HTTP: z.enum(['true', 'false']).optional().default('false'),
    /** Cross-origin isolation of the studio (docs/design/engine-performance.md): threads for ffmpeg.wasm. */
    RIDEO_CROSS_ORIGIN_ISOLATION: z
      .enum(['require-corp', 'credentialless', 'off'])
      .optional()
      .default('require-corp'),
    /** Semantic search by meaning (docs/design/search.md#the-index); words without it. */
    RIDEO_EMBEDDINGS_PROXY_DOMAIN: str(),
    RIDEO_EMBEDDINGS_MODEL: str('text-embedding-3-small'),
    RIDEO_TTS_PROVIDER: z.enum(['elevenlabs', 'openai', 'off']).optional().default('off'),
    RIDEO_TTS_PROXY_DOMAIN: str(),
    RIDEO_TTS_MODEL: str(),
    RIDEO_SFX_PROVIDER: z.enum(['elevenlabs', 'off']).optional().default('off'),
    RIDEO_SFX_PROXY_DOMAIN: str('api.elevenlabs.io'),
    RIDEO_SFX_MODEL: str('eleven_text_to_sound_v2'),
    RIDEO_LIPSYNC_MODEL: str('auto'),
    RIDEO_EDIT_MODEL: str('auto'),
    /** Performance takes (docs/design/performance.md): `auto`, a model id or `off`. */
    RIDEO_PERFORMANCE_MODEL: str('auto'),
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
  })
  // Rules across settings, reported on the setting to fix (docs/design/settings.md#surfaces).
  .superRefine((e, ctx) => {
    if (e.RIDEO_OIDC_ISSUER && !e.RIDEO_OIDC_CLIENT_ID)
      ctx.addIssue({
        code: 'custom',
        path: ['RIDEO_OIDC_CLIENT_ID'],
        message: 'RIDEO_OIDC_CLIENT_ID is required with RIDEO_OIDC_ISSUER',
      });
    if (e.RIDEO_STORAGE === 'webdav' && !e.RIDEO_WEBDAV_URL)
      ctx.addIssue({
        code: 'custom',
        path: ['RIDEO_WEBDAV_URL'],
        message: 'set the WebDAV URL, or store projects in the browser or the built-in server',
      });
    for (const key of [
      'RIDEO_WEBDAV_URL',
      'MM_GATEWAY_URL',
      'RIDEO_OIDC_ISSUER',
      'RIDEO_C2PA_TSA_URL',
    ] as const) {
      const v = e[key];
      if (v && !/^https?:\/\/[^\s/]+/i.test(v))
        ctx.addIssue({ code: 'custom', path: [key], message: 'an http:// or https:// URL' });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** Where projects live: `auto` until the server resolves it at start (resolveStorageMode). */
export type StorageModeSetting = 'auto' | 'browser' | 'webdav' | 'embedded';

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
  /** The studio's external URL, with the base path (links in MCP results, share links, OIDC). */
  publicUrl: string;
  /** Serving under a subpath (docs/design/subpath.md): '' or `/a/b`. */
  basePath: string;
  /** Origins that may call the API from their pages (docs/design/embedding.md); `*` for any. */
  cors: { origins: string[] };
  /** The studio theme (docs/design/embedding.md#themes). */
  theme: Theme | null;
  /** Where projects live (docs/design/browser-storage.md). */
  storage: { mode: StorageModeSetting };
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
  /** Web Push to people's devices (docs/design/pwa.md). */
  push: { vapid: { publicKey?: string; privateKey?: string; subject: string }; allowHttp: boolean };
  /** COEP of the studio's files (docs/design/engine-performance.md); `off` sends no isolation headers. */
  crossOriginIsolation: 'require-corp' | 'credentialless' | 'off';
  logLevel: string;
  production: boolean;
  webdav: {
    url?: string;
    username?: string;
    password?: string;
    root: string;
    /** Mount the built-in WebDAV server at /dav (set once the storage mode is resolved). */
    embedded: boolean;
    /** RIDEO_EMBEDDED_DAV as given. */
    embeddedSetting: 'auto' | 'true' | 'false';
    davUsername?: string;
    davPassword?: string;
    syncIntervalSec: number;
  };
  coalesceWindowSec: number;
  gateway: {
    /** Unset: no gateway, no AI (docs/design/settings.md#without-mm-gateway). */
    url?: string;
    configured: boolean;
    apiKey?: string;
    routingProfile?: string;
    models: {
      image: string;
      video: string;
      music: string;
      lipSync: string;
      edit: string;
      enhance: string;
      performance: string;
    };
    pollMs: number;
    timeoutsSec: { image: number; video: number; music: number };
  };
  llm: LlmEndpoint;
  vision: LlmEndpoint;
  stt?: { domain: string; model: string };
  /** Caption embeddings for semantic search; unset: search ranks by words. */
  embeddings?: { domain: string; model: string };
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
  /** What the config was built from, to rebuild it when settings change (docs/design/settings.md). */
  source: {
    env: Readonly<Record<string, string | undefined>>;
    settings: Readonly<Record<string, string>>;
    overrides: Partial<Config>;
  };
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

/** Environment variables that are set and not empty: they win over the settings file. */
export function nonEmptyEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Config> = {},
  settings: Readonly<Record<string, string>> = {},
): Config {
  const e = EnvSchema.parse({ ...settings, ...nonEmptyEnv(env) });
  const port = e.RIDEO_PORT;
  const publicUrlPath = (() => {
    if (!e.RIDEO_PUBLIC_URL) return '';
    try {
      return normalizeBasePath(new URL(e.RIDEO_PUBLIC_URL).pathname) ?? '';
    } catch {
      return '';
    }
  })();
  const base = e.RIDEO_BASE_PATH ?? publicUrlPath;
  const storageMode: StorageModeSetting =
    e.RIDEO_STORAGE !== 'auto'
      ? e.RIDEO_STORAGE
      : e.RIDEO_WEBDAV_URL
        ? 'webdav'
        : e.RIDEO_EMBEDDED_DAV === 'true'
          ? 'embedded'
          : 'auto';
  const llmProvider = e.RIDEO_LLM_PROVIDER;
  const visionProvider = e.RIDEO_VISION_PROVIDER ?? llmProvider;
  // Optional AI endpoints exist only with a gateway to reach them (docs/design/settings.md#without-mm-gateway).
  const ai = !!e.MM_GATEWAY_URL;
  const cfg: Config = {
    host: e.RIDEO_HOST!,
    port,
    publicUrl: (e.RIDEO_PUBLIC_URL ?? `http://localhost:${port}${base}`).replace(/\/+$/, ''),
    basePath: base,
    cors: {
      origins: (e.RIDEO_CORS_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    },
    theme: e.RIDEO_THEME ? ThemeSchema.parse(e.RIDEO_THEME) : null,
    storage: { mode: storageMode },
    apiToken: e.RIDEO_API_TOKEN,
    user: { id: e.RIDEO_USER_ID!, name: e.RIDEO_USER_NAME! },
    auth: {
      oidc: e.RIDEO_OIDC_ISSUER
        ? {
            issuer: e.RIDEO_OIDC_ISSUER,
            clientId: e.RIDEO_OIDC_CLIENT_ID!,
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
    crossOriginIsolation: e.RIDEO_CROSS_ORIGIN_ISOLATION,
    push: {
      vapid: {
        publicKey: e.RIDEO_VAPID_PUBLIC_KEY,
        privateKey: e.RIDEO_VAPID_PRIVATE_KEY,
        subject: e.RIDEO_VAPID_SUBJECT!,
      },
      allowHttp: e.RIDEO_PUSH_ALLOW_HTTP === 'true',
    },
    logLevel: e.RIDEO_LOG_LEVEL!,
    production: e.NODE_ENV === 'production',
    webdav: {
      url: e.RIDEO_WEBDAV_URL,
      username: e.RIDEO_WEBDAV_USERNAME,
      password: e.RIDEO_WEBDAV_PASSWORD,
      root: `/${e.RIDEO_WEBDAV_ROOT!.replace(/^\/+|\/+$/g, '')}`,
      embedded: mountsEmbeddedDav(storageMode, e.RIDEO_EMBEDDED_DAV),
      embeddedSetting: e.RIDEO_EMBEDDED_DAV,
      davUsername: e.RIDEO_DAV_USERNAME,
      davPassword: e.RIDEO_DAV_PASSWORD,
      syncIntervalSec: e.RIDEO_WEBDAV_SYNC_INTERVAL_SEC,
    },
    coalesceWindowSec: e.RIDEO_COALESCE_WINDOW_SEC,
    gateway: {
      url: e.MM_GATEWAY_URL?.replace(/\/+$/, ''),
      configured: !!e.MM_GATEWAY_URL,
      apiKey: e.MM_GATEWAY_API_KEY,
      routingProfile: e.MM_GATEWAY_ROUTING_PROFILE,
      models: {
        image: e.RIDEO_IMAGE_MODEL!,
        video: e.RIDEO_VIDEO_MODEL!,
        music: e.RIDEO_MUSIC_MODEL!,
        lipSync: e.RIDEO_LIPSYNC_MODEL!,
        edit: e.RIDEO_EDIT_MODEL!,
        enhance: e.RIDEO_ENHANCE_MODEL!,
        performance: e.RIDEO_PERFORMANCE_MODEL!,
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
    embeddings:
      ai && e.RIDEO_EMBEDDINGS_PROXY_DOMAIN
        ? { domain: e.RIDEO_EMBEDDINGS_PROXY_DOMAIN, model: e.RIDEO_EMBEDDINGS_MODEL! }
        : undefined,
    stt:
      ai && e.RIDEO_STT_PROXY_DOMAIN
        ? { domain: e.RIDEO_STT_PROXY_DOMAIN, model: e.RIDEO_STT_MODEL! }
        : undefined,
    tts:
      !ai || e.RIDEO_TTS_PROVIDER === 'off'
        ? undefined
        : {
            provider: e.RIDEO_TTS_PROVIDER,
            domain: e.RIDEO_TTS_PROXY_DOMAIN ?? TTS_DEFAULTS[e.RIDEO_TTS_PROVIDER].domain,
            model: e.RIDEO_TTS_MODEL ?? TTS_DEFAULTS[e.RIDEO_TTS_PROVIDER].model,
          },
    sfx:
      !ai || e.RIDEO_SFX_PROVIDER === 'off'
        ? undefined
        : { provider: e.RIDEO_SFX_PROVIDER, domain: e.RIDEO_SFX_PROXY_DOMAIN!, model: e.RIDEO_SFX_MODEL! },
    voiceJudge: (() => {
      // Defaults to the vision provider when it accepts audio (Anthropic models do not).
      const provider =
        e.RIDEO_VOICE_JUDGE_PROVIDER ?? (visionProvider === 'anthropic' ? 'off' : visionProvider);
      if (provider === 'off' || !ai) return undefined;
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
    source: { env, settings, overrides },
  };
  return { ...cfg, ...overrides };
}

/** Whether the built-in WebDAV server is mounted at /dav: embedded storage needs it; RIDEO_EMBEDDED_DAV=true adds it. */
function mountsEmbeddedDav(mode: StorageModeSetting, setting: 'auto' | 'true' | 'false'): boolean {
  return mode === 'embedded' || setting === 'true';
}

/**
 * Resolves `RIDEO_STORAGE=auto` (docs/design/settings.md#storage-mode-on-first-start): an installation whose built-in
 * store already holds projects keeps using it; a fresh one stores projects in the browser.
 */
export function resolveStorageMode(config: Config, embeddedHasProjects: boolean): Config {
  if (config.storage.mode !== 'auto') return config;
  const mode = embeddedHasProjects ? 'embedded' : 'browser';
  return {
    ...config,
    storage: { mode },
    webdav: { ...config.webdav, embedded: mountsEmbeddedDav(mode, config.webdav.embeddedSetting) },
  };
}

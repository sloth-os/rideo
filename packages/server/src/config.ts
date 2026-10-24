import {
  apiBaseProblem,
  desiredProxies,
  parseThemeJson,
  type ResolvedEndpoint,
  type ResolvedEndpoints,
  resolveEndpoints,
  SETTING_ENDPOINTS,
  settingEndpoint,
  type Theme,
  ThemeSchema,
} from '@rideo/shared';
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
    /** The gateway's management token: registers the API keys below as proxies (docs/design/settings.md). */
    MM_GATEWAY_ADMIN_KEY: str(),
    MM_GATEWAY_ROUTING_PROFILE: str(),
    RIDEO_IMAGE_MODEL: str('auto'),
    RIDEO_VIDEO_MODEL: str('auto'),
    RIDEO_MUSIC_MODEL: str('auto'),
    RIDEO_GATEWAY_POLL_MS: num(2000),
    RIDEO_GATEWAY_TIMEOUT_IMAGE_SEC: num(300),
    RIDEO_GATEWAY_TIMEOUT_VIDEO_SEC: num(1200),
    RIDEO_GATEWAY_TIMEOUT_MUSIC_SEC: num(600),
    // AI endpoints through the gateway proxy (docs/design/settings.md#provider-endpoints-and-api-keys): the base URL
    // (or domain) and key of each; defaults and fallbacks are in SETTING_ENDPOINTS.
    RIDEO_LLM_PROVIDER: z.enum(['openai', 'gemini', 'anthropic']).optional().default('openai'),
    RIDEO_LLM_PROXY_DOMAIN: str(),
    RIDEO_LLM_API_KEY: str(),
    RIDEO_LLM_MODEL: str(),
    RIDEO_VISION_PROVIDER: z.enum(['openai', 'gemini', 'anthropic']).optional(),
    RIDEO_VISION_PROXY_DOMAIN: str(),
    RIDEO_VISION_API_KEY: str(),
    RIDEO_VISION_MODEL: str(),
    RIDEO_STT_PROXY_DOMAIN: str(),
    RIDEO_STT_API_KEY: str(),
    RIDEO_STT_MODEL: str(),
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
    RIDEO_EMBEDDINGS_API_KEY: str(),
    RIDEO_EMBEDDINGS_MODEL: str(),
    RIDEO_TTS_PROVIDER: z.enum(['elevenlabs', 'openai', 'off']).optional().default('off'),
    RIDEO_TTS_PROXY_DOMAIN: str(),
    RIDEO_TTS_API_KEY: str(),
    RIDEO_TTS_MODEL: str(),
    RIDEO_SFX_PROVIDER: z.enum(['elevenlabs', 'off']).optional().default('off'),
    RIDEO_SFX_PROXY_DOMAIN: str(),
    RIDEO_SFX_API_KEY: str(),
    RIDEO_SFX_MODEL: str(),
    RIDEO_LIPSYNC_MODEL: str('auto'),
    RIDEO_EDIT_MODEL: str('auto'),
    /** Performance takes (docs/design/performance.md): `auto`, a model id or `off`. */
    RIDEO_PERFORMANCE_MODEL: str('auto'),
    RIDEO_ENHANCE_MODEL: str('auto'),
    RIDEO_VOICE_JUDGE_PROVIDER: z.enum(['openai', 'gemini', 'off']).optional(),
    RIDEO_VOICE_JUDGE_PROXY_DOMAIN: str(),
    RIDEO_VOICE_JUDGE_API_KEY: str(),
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
    // API base URLs, and one origin per domain among the endpoints whose keys the studio registers
    const values = e as unknown as Record<string, string | undefined>;
    let parsed = true;
    for (const ep of SETTING_ENDPOINTS) {
      const problem = apiBaseProblem(values[ep.url]);
      if (problem) {
        parsed = false;
        ctx.addIssue({ code: 'custom', path: [ep.url], message: problem });
      }
    }
    if (!parsed) return;
    const { conflicts } = desiredProxies(resolveEndpoints(values, { gateway: true }), (key) => key);
    for (const c of conflicts)
      ctx.addIssue({ code: 'custom', path: [settingEndpoint(c.id).url], message: c.message });
  });

export type Env = z.infer<typeof EnvSchema>;

/** Where projects live: `auto` until the server resolves it at start (resolveStorageMode). */
export type StorageModeSetting = 'auto' | 'browser' | 'webdav' | 'embedded';

/**
 * An API behind the gateway proxy: `domain` is the proxy (`/proxy/{domain}/…`), `prefix` the path standing for the
 * API version of the adapters' paths (docs/design/settings.md#api-base-url).
 */
export interface ProxyApi {
  domain: string;
  prefix?: string | null;
}

export interface LlmEndpoint extends ProxyApi {
  provider: 'openai' | 'gemini' | 'anthropic';
  model: string;
}

/** Text-to-speech through the gateway proxy (docs/design/dialogue.md#providers). */
export interface TtsEndpoint extends ProxyApi {
  provider: 'elevenlabs' | 'openai';
  model: string;
}

/** Sound effects through the gateway proxy (docs/design/post-audio.md#effects-from-action-lines). */
export interface SfxEndpoint extends ProxyApi {
  provider: 'elevenlabs';
  model: string;
}

/** An endpoint as a proxy API with its provider and model. */
function api<P extends string>(ep: ResolvedEndpoint): ProxyApi & { provider: P; model: string } {
  return { provider: ep.provider as P, domain: ep.base.domain, prefix: ep.base.prefix, model: ep.model };
}

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
    /** The management token that registers the API keys set in Settings (docs/design/settings.md). */
    adminKey?: string;
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
  stt?: ProxyApi & { model: string };
  /** Caption embeddings for semantic search; unset: search ranks by words. */
  embeddings?: ProxyApi & { model: string };
  /** Dialogue voices; unset when RIDEO_TTS_PROVIDER=off. */
  tts?: TtsEndpoint;
  /** Generated sound effects; unset when RIDEO_SFX_PROVIDER=off. */
  sfx?: SfxEndpoint;
  /** The audio-capable LLM that checks speakers of native-audio takes (rule V4). */
  voiceJudge?: ProxyApi & { provider: 'openai' | 'gemini'; model: string };
  /** Every AI endpoint with its base and API key (docs/design/settings.md#provider-endpoints-and-api-keys). */
  endpoints: ResolvedEndpoints;
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
  // Optional AI endpoints exist only with a gateway to reach them (docs/design/settings.md#without-mm-gateway).
  const endpoints = resolveEndpoints(e as unknown as Record<string, string | undefined>, {
    gateway: !!e.MM_GATEWAY_URL,
  });
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
      adminKey: e.MM_GATEWAY_ADMIN_KEY,
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
    llm: api(endpoints.llm!),
    vision: api(endpoints.vision!),
    stt: endpoints.stt ? api(endpoints.stt) : undefined,
    embeddings: endpoints.embeddings ? api(endpoints.embeddings) : undefined,
    tts: endpoints.tts ? api(endpoints.tts) : undefined,
    sfx: endpoints.sfx ? api(endpoints.sfx) : undefined,
    voiceJudge: endpoints.voiceJudge ? api(endpoints.voiceJudge) : undefined,
    endpoints,
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

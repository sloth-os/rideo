import { z } from 'zod';

/**
 * The real-model suite's variables and what they become (docs/testing.md#real-models-e2ereal): mm-gateway's
 * configuration and the studio's environment. Pure data and functions, unit-tested in env.test.ts.
 */

/** The gateway image the suite runs; MM_GATEWAY_IMAGE overrides it. */
export const DEFAULT_GATEWAY_IMAGE = 'ghcr.io/sloth-os/mm-gateway:sha-98b05a9';

/** The tag on everything the suite configures in the gateway, and the only one its key may use. */
export const SUITE_TAG = 'rideo-real';

/** The environment variable of the studio's gateway key (generated for a run, given to the gateway container). */
export const GATEWAY_KEY_ENV = 'RIDEO_REAL_GATEWAY_KEY';

/**
 * The environment variable of the vision account's header value, made from VISION_MODEL_API_KEY for a run. The
 * configuration names it whole: mm-gateway encrypts a credential that is only partly a reference (`Bearer ${…}`) and
 * writes it back beside the configuration, which the suite mounts read-only.
 */
export const VISION_CREDENTIAL_ENV = 'RIDEO_REAL_VISION_CREDENTIAL';

/**
 * How Rideo's language-model adapters reach each vision API through the gateway proxy
 * (docs/design/ai-gateway.md#proxy-usage-llm-vision-stt-embeddings): the adapter adds the API version to its paths
 * (`v1/chat/completions`, `v1beta/models/…`, `v1/messages`), so the proxy fronts the base URL without it, and the
 * account carries the key in the header that API reads.
 */
export const VISION_APIS = {
  openai: {
    provider: 'openai',
    version: /\/v1$/,
    header: 'authorization',
    credential: (key: string) => `Bearer ${key}`,
  },
  gemini: {
    provider: 'gemini',
    version: /\/v1(beta)?$/,
    header: 'x-goog-api-key',
    credential: (key: string) => key,
  },
  anthropic: {
    provider: 'anthropic',
    version: /\/v1$/,
    header: 'x-api-key',
    credential: (key: string) => key,
  },
} as const;
export type VisionApi = keyof typeof VISION_APIS;

/** GitHub sets a missing `vars.X` / `secrets.X` to an empty string: empty is unset. */
const unsetIfEmpty = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const value = z.preprocess(unsetIfEmpty, z.string({ error: 'is not set' }).trim());
const httpUrl = z.preprocess(
  unsetIfEmpty,
  z.url({ protocol: /^https?$/, error: 'is not an http(s) URL' }).transform((u) => u.replace(/\/+$/, '')),
);

export const RealEnvSchema = z.object({
  IMAGE_MODEL_TYPE: value,
  IMAGE_MODEL_BASE_URL: httpUrl,
  IMAGE_MODEL: value,
  IMAGE_MODEL_API_KEY: value,
  VIDEO_GEN_MODEL_TYPE: value,
  VIDEO_GEN_BASE_URL: httpUrl,
  VIDEO_GEN_MODEL: value,
  VIDEO_GEN_API_KEY: value,
  VISION_MODEL_TYPE: z.preprocess(
    unsetIfEmpty,
    z.enum(Object.keys(VISION_APIS) as [VisionApi, ...VisionApi[]], {
      error: `is not one of ${Object.keys(VISION_APIS).join(', ')}`,
    }),
  ),
  VISION_MODEL_BASE_URL: httpUrl,
  VISION_MODEL: value,
  VISION_MODEL_API_KEY: value,
  /** The shot length the video model renders (the gateway's catalog tells the shot planner). */
  VIDEO_GEN_DURATION_SEC: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(1).max(60).default(5)),
  MM_GATEWAY_IMAGE: z.preprocess(unsetIfEmpty, z.string().default(DEFAULT_GATEWAY_IMAGE)),
  /** A gateway already running with this configuration, instead of the container. */
  MM_GATEWAY_URL: httpUrl.optional(),
  MM_GATEWAY_API_KEY: z.preprocess(unsetIfEmpty, z.string().optional()),
});
export type RealEnv = z.infer<typeof RealEnvSchema>;

/** The variables, or an error naming every one that is missing or invalid (never their values). */
export function readRealEnv(source: Record<string, string | undefined>): RealEnv {
  const parsed = RealEnvSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`);
  throw new Error(
    `the real-model suite needs its variables (docs/testing.md#real-models-e2ereal): ${problems.join('; ')}`,
  );
}

/**
 * The API root each backend type's SDK calls (mm-gateway's `base_url`), for a base URL that names only a host:
 * DashScope serves its API under `/api/v1`, and a DashScope-compatible gateway under `/v1`, next to its OpenAI routes
 * (`ai.ctaigw.cn` answers `/v1/services/aigc/…` and `/v1/tasks/…`, and anything else with its catch-all).
 */
export const API_ROOTS: Record<string, (host: string) => string> = {
  dashscope: (host) => (/^dashscope(-intl)?\.aliyuncs\.com$/.test(host) ? '/api/v1' : '/v1'),
};

/** A backend's `base_url`: the variable as given, or the host with its type's API root. */
export function backendBaseUrl(type: string, baseUrl: string): string {
  const url = new URL(baseUrl);
  const root = API_ROOTS[type];
  return root && url.pathname === '/' ? `${url.origin}${root(url.hostname)}` : baseUrl;
}

/** The vision proxy's root: the base URL without the API version Rideo's adapter adds. */
export function visionProxyRoot(env: Pick<RealEnv, 'VISION_MODEL_TYPE' | 'VISION_MODEL_BASE_URL'>): string {
  return env.VISION_MODEL_BASE_URL.replace(VISION_APIS[env.VISION_MODEL_TYPE].version, '');
}

/** mm-gateway's configuration (its YAML reads JSON); keys are `${…}` references to its environment. */
export function gatewayConfig(env: RealEnv) {
  const ref = (name: string) => `\${${name}}`;
  const vision = VISION_APIS[env.VISION_MODEL_TYPE];
  return {
    server: { host: '0.0.0.0', port: 8000, log_level: 'INFO', log_format: 'json' },
    backends: [
      {
        name: 'rideo-real-image',
        type: env.IMAGE_MODEL_TYPE,
        base_url: backendBaseUrl(env.IMAGE_MODEL_TYPE, env.IMAGE_MODEL_BASE_URL),
        api_key: ref('IMAGE_MODEL_API_KEY'),
        tags: [SUITE_TAG],
        extra: { image_model: env.IMAGE_MODEL },
      },
      {
        name: 'rideo-real-video',
        type: env.VIDEO_GEN_MODEL_TYPE,
        base_url: backendBaseUrl(env.VIDEO_GEN_MODEL_TYPE, env.VIDEO_GEN_BASE_URL),
        api_key: ref('VIDEO_GEN_API_KEY'),
        tags: [SUITE_TAG],
        extra: { video_model: env.VIDEO_GEN_MODEL },
      },
    ],
    proxies: [
      {
        base_url: visionProxyRoot(env),
        tags: [SUITE_TAG],
        timeout: 300,
        accounts: [{ id: 'vision', headers: { [vision.header]: ref(VISION_CREDENTIAL_ENV) } }],
      },
    ],
    keys: [{ id: 'rideo', key: ref(GATEWAY_KEY_ENV), allow_tags: [SUITE_TAG] }],
    catalog: {
      models: {
        [env.VIDEO_GEN_MODEL]: {
          modality: 'video',
          min_duration_seconds: env.VIDEO_GEN_DURATION_SEC,
          max_duration_seconds: env.VIDEO_GEN_DURATION_SEC,
        },
      },
    },
  };
}

/** What the gateway container's environment carries besides its own key: every credential its configuration names. */
export function gatewaySecrets(env: RealEnv): Record<string, string> {
  return {
    IMAGE_MODEL_API_KEY: env.IMAGE_MODEL_API_KEY,
    VIDEO_GEN_API_KEY: env.VIDEO_GEN_API_KEY,
    [VISION_CREDENTIAL_ENV]: VISION_APIS[env.VISION_MODEL_TYPE].credential(env.VISION_MODEL_API_KEY),
  };
}

/**
 * The studio's environment: the vision model is the language model (screenplay, shot plans) and the vision model
 * (attachments, the consistency judge, footage); the image and video models are pinned; nothing else is configured.
 */
export function studioEnv(env: RealEnv, gateway: { url: string; apiKey: string }): Record<string, string> {
  const vision = VISION_APIS[env.VISION_MODEL_TYPE];
  const domain = new URL(env.VISION_MODEL_BASE_URL).hostname;
  return {
    MM_GATEWAY_URL: gateway.url,
    MM_GATEWAY_API_KEY: gateway.apiKey,
    RIDEO_IMAGE_MODEL: env.IMAGE_MODEL,
    RIDEO_VIDEO_MODEL: env.VIDEO_GEN_MODEL,
    RIDEO_LLM_PROVIDER: vision.provider,
    RIDEO_LLM_PROXY_DOMAIN: domain,
    RIDEO_LLM_MODEL: env.VISION_MODEL,
    RIDEO_VISION_PROVIDER: vision.provider,
    RIDEO_VISION_PROXY_DOMAIN: domain,
    RIDEO_VISION_MODEL: env.VISION_MODEL,
    RIDEO_TTS_PROVIDER: 'off',
    RIDEO_SFX_PROVIDER: 'off',
    RIDEO_VOICE_JUDGE_PROVIDER: 'off',
    RIDEO_STT_PROXY_DOMAIN: '',
    RIDEO_EMBEDDINGS_PROXY_DOMAIN: '',
  };
}

import { describe, expect, it } from 'vitest';
import {
  backendBaseUrl,
  DEFAULT_GATEWAY_IMAGE,
  GATEWAY_KEY_ENV,
  gatewayConfig,
  gatewaySecrets,
  readRealEnv,
  SUITE_TAG,
  studioEnv,
  visionProxyRoot,
} from './env';

/** mm-gateway's reference to an environment variable in its configuration. */
const ref = (name: string) => `\${${name}}`;

/** The suite's variables as the sloth-os organization sets them (docs/testing.md#real-models-e2ereal). */
const VARS = {
  IMAGE_MODEL_TYPE: 'volcengine',
  IMAGE_MODEL_BASE_URL: 'https://ai.ctaigw.cn/v1',
  IMAGE_MODEL: 'doubao-seedream-5.0-pro',
  IMAGE_MODEL_API_KEY: 'image-secret',
  VIDEO_GEN_MODEL_TYPE: 'dashscope',
  VIDEO_GEN_BASE_URL: 'https://ai.ctaigw.cn',
  VIDEO_GEN_MODEL: 'wan3.0-video-prime',
  VIDEO_GEN_API_KEY: 'video-secret',
  VISION_MODEL_TYPE: 'openai',
  VISION_MODEL_BASE_URL: 'https://ai.ctaigw.cn/v1',
  VISION_MODEL: 'qwen3.8-max',
  VISION_MODEL_API_KEY: 'vision-secret',
};

describe('real-model suite variables', () => {
  it('configure a gateway backend per generation model and a proxy for the vision model', () => {
    const env = readRealEnv(VARS);
    expect(env.MM_GATEWAY_IMAGE).toBe(DEFAULT_GATEWAY_IMAGE);
    const config = gatewayConfig(env);
    expect(config.backends).toEqual([
      {
        name: 'rideo-real-image',
        type: 'volcengine',
        base_url: 'https://ai.ctaigw.cn/v1',
        api_key: ref('IMAGE_MODEL_API_KEY'),
        tags: [SUITE_TAG],
        extra: { image_model: 'doubao-seedream-5.0-pro' },
      },
      {
        name: 'rideo-real-video',
        type: 'dashscope',
        // the variable names the host; DashScope-compatible gateways serve the API under /v1
        base_url: 'https://ai.ctaigw.cn/v1',
        api_key: ref('VIDEO_GEN_API_KEY'),
        tags: [SUITE_TAG],
        extra: { video_model: 'wan3.0-video-prime' },
      },
    ]);
    // Rideo's OpenAI adapter calls v1/chat/completions: the proxy fronts the base URL without /v1
    expect(config.proxies).toEqual([
      {
        base_url: 'https://ai.ctaigw.cn',
        tags: [SUITE_TAG],
        timeout: 300,
        accounts: [{ id: 'vision', headers: { authorization: ref('RIDEO_REAL_VISION_CREDENTIAL') } }],
      },
    ]);
    expect(config.keys).toEqual([
      { id: 'rideo', key: ref('RIDEO_REAL_GATEWAY_KEY'), allow_tags: [SUITE_TAG] },
    ]);
    expect(config.catalog.models).toEqual({
      'wan3.0-video-prime': { modality: 'video', min_duration_seconds: 5, max_duration_seconds: 5 },
    });
    // The configuration names the keys; their values stay in the environment.
    const text = JSON.stringify(config);
    for (const secret of ['image-secret', 'video-secret', 'vision-secret'])
      expect(text).not.toContain(secret);
    // The container's environment carries every variable the configuration names, the vision header made whole
    expect(gatewaySecrets(env)).toEqual({
      IMAGE_MODEL_API_KEY: 'image-secret',
      VIDEO_GEN_API_KEY: 'video-secret',
      RIDEO_REAL_VISION_CREDENTIAL: 'Bearer vision-secret',
    });
    const named = [...text.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set([...Object.keys(gatewaySecrets(env)), GATEWAY_KEY_ENV]));
    // and names each credential whole: the gateway encrypts one that is only partly a reference
    const credentials = [
      ...config.backends.map((b) => b.api_key),
      ...config.proxies.flatMap((p) => p.accounts.flatMap((a) => Object.values(a.headers))),
      ...config.keys.map((k) => k.key),
    ];
    for (const c of credentials) expect(c).toMatch(/^\$\{[A-Z0-9_]+\}$/);
  });

  it("give a backend whose base URL names only a host its SDK's API root", () => {
    expect(backendBaseUrl('dashscope', 'https://ai.ctaigw.cn')).toBe('https://ai.ctaigw.cn/v1');
    expect(backendBaseUrl('dashscope', 'https://dashscope.aliyuncs.com')).toBe(
      'https://dashscope.aliyuncs.com/api/v1',
    );
    expect(backendBaseUrl('dashscope', 'https://dashscope-intl.aliyuncs.com')).toBe(
      'https://dashscope-intl.aliyuncs.com/api/v1',
    );
    // a path is the API root already, and other types take their base URL as given
    expect(backendBaseUrl('dashscope', 'https://dashscope.aliyuncs.com/api/v1')).toBe(
      'https://dashscope.aliyuncs.com/api/v1',
    );
    expect(backendBaseUrl('volcengine', 'https://ai.ctaigw.cn')).toBe('https://ai.ctaigw.cn');
  });

  it('give the studio the vision model for language and vision and pin the generation models', () => {
    const env = readRealEnv(VARS);
    expect(studioEnv(env, { url: 'http://127.0.0.1:8000', apiKey: 'k' })).toEqual({
      MM_GATEWAY_URL: 'http://127.0.0.1:8000',
      MM_GATEWAY_API_KEY: 'k',
      RIDEO_IMAGE_MODEL: 'doubao-seedream-5.0-pro',
      RIDEO_VIDEO_MODEL: 'wan3.0-video-prime',
      RIDEO_LLM_PROVIDER: 'openai',
      RIDEO_LLM_PROXY_DOMAIN: 'ai.ctaigw.cn',
      RIDEO_LLM_MODEL: 'qwen3.8-max',
      RIDEO_VISION_PROVIDER: 'openai',
      RIDEO_VISION_PROXY_DOMAIN: 'ai.ctaigw.cn',
      RIDEO_VISION_MODEL: 'qwen3.8-max',
      RIDEO_TTS_PROVIDER: 'off',
      RIDEO_SFX_PROVIDER: 'off',
      RIDEO_VOICE_JUDGE_PROVIDER: 'off',
      RIDEO_STT_PROXY_DOMAIN: '',
      RIDEO_EMBEDDINGS_PROXY_DOMAIN: '',
    });
  });

  it('reach Gemini and Anthropic vision models with their own key headers and versions', () => {
    const gemini = readRealEnv({
      ...VARS,
      VISION_MODEL_TYPE: 'gemini',
      VISION_MODEL_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/',
    });
    expect(visionProxyRoot(gemini)).toBe('https://generativelanguage.googleapis.com');
    expect(gatewayConfig(gemini).proxies[0]?.accounts[0]?.headers).toEqual({
      'x-goog-api-key': ref('RIDEO_REAL_VISION_CREDENTIAL'),
    });
    expect(gatewaySecrets(gemini).RIDEO_REAL_VISION_CREDENTIAL).toBe('vision-secret');
    expect(studioEnv(gemini, { url: 'u', apiKey: 'k' })).toMatchObject({
      RIDEO_LLM_PROVIDER: 'gemini',
      RIDEO_VISION_PROXY_DOMAIN: 'generativelanguage.googleapis.com',
    });
    const anthropic = readRealEnv({
      ...VARS,
      VISION_MODEL_TYPE: 'anthropic',
      VISION_MODEL_BASE_URL: 'https://api.anthropic.com',
    });
    // A base URL without a version is the root already
    expect(visionProxyRoot(anthropic)).toBe('https://api.anthropic.com');
    expect(gatewayConfig(anthropic).proxies[0]?.accounts[0]?.headers).toEqual({
      'x-api-key': ref('RIDEO_REAL_VISION_CREDENTIAL'),
    });
    expect(gatewaySecrets(anthropic).RIDEO_REAL_VISION_CREDENTIAL).toBe('vision-secret');
    // An OpenAI-compatible API under a path keeps the path
    expect(
      visionProxyRoot({
        VISION_MODEL_TYPE: 'openai',
        VISION_MODEL_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    ).toBe('https://dashscope.aliyuncs.com/compatible-mode');
  });

  it('take the video length and a gateway to use from the environment', () => {
    const env = readRealEnv({
      ...VARS,
      VIDEO_GEN_DURATION_SEC: '10',
      MM_GATEWAY_URL: 'http://127.0.0.1:8000/',
      MM_GATEWAY_API_KEY: 'running-key',
      MM_GATEWAY_IMAGE: '',
    });
    expect(gatewayConfig(env).catalog.models['wan3.0-video-prime']).toMatchObject({
      min_duration_seconds: 10,
      max_duration_seconds: 10,
    });
    expect(env).toMatchObject({
      MM_GATEWAY_URL: 'http://127.0.0.1:8000',
      MM_GATEWAY_API_KEY: 'running-key',
      MM_GATEWAY_IMAGE: DEFAULT_GATEWAY_IMAGE,
    });
  });

  it('name every missing or invalid variable, never a value', () => {
    let message = '';
    try {
      readRealEnv({
        ...VARS,
        IMAGE_MODEL: '',
        VIDEO_GEN_API_KEY: undefined,
        VISION_MODEL_TYPE: 'grok',
        VISION_MODEL_BASE_URL: 'ftp://ai.ctaigw.cn',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('IMAGE_MODEL is not set');
    expect(message).toContain('VIDEO_GEN_API_KEY is not set');
    expect(message).toContain('VISION_MODEL_TYPE is not one of openai, gemini, anthropic');
    expect(message).toContain('VISION_MODEL_BASE_URL is not an http(s) URL');
    for (const secret of ['image-secret', 'vision-secret']) expect(message).not.toContain(secret);
  });
});

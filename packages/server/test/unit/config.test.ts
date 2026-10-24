import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeBasePath, parseLanes, resolveStorageMode } from '../../src/config';

const GW = { MM_GATEWAY_URL: 'http://gateway.test' };

describe('config', () => {
  it('applies documented defaults', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8787);
    // Storage resolves at start (docs/design/settings.md#storage-mode-on-first-start); no gateway, no AI.
    expect(c.storage.mode).toBe('auto');
    expect(c.webdav).toMatchObject({ embedded: false, root: '/rideo', syncIntervalSec: 15 });
    expect(c.gateway).toMatchObject({ url: undefined, configured: false });
    expect(c.basePath).toBe('');
    expect(c.publicUrl).toBe('http://localhost:8787');
    expect(c.cors.origins).toEqual([]);
    expect(c.theme).toBeNull();
    expect(c.llm).toEqual({
      provider: 'openai',
      domain: 'api.openai.com',
      prefix: null,
      model: 'gpt-4.1-mini',
    });
    expect(c.vision.model).toBe('gpt-4.1-mini');
    // a text or vision call may take ten minutes; RIDEO_LLM_TIMEOUT_SEC changes it (at least 10 s)
    expect(c.llmTimeoutMs).toBe(600_000);
    expect(loadConfig({ RIDEO_LLM_TIMEOUT_SEC: '900' }).llmTimeoutMs).toBe(900_000);
    expect(loadConfig({ RIDEO_LLM_TIMEOUT_SEC: '1' }).llmTimeoutMs).toBe(10_000);
    expect(c.watermark.strength).toBe(16);
    expect(c.lanes).toMatchObject({ control: 16, video: 2, media: 1 });
    expect(c.gateway.models).toEqual({
      image: 'auto',
      video: 'auto',
      music: 'auto',
      lipSync: 'auto',
      edit: 'auto',
      enhance: 'auto',
      performance: 'auto',
    });
    // Dialogue (docs/design/dialogue.md): no TTS until a provider is chosen; the speaker check follows vision.
    expect(c.tts).toBeUndefined();
    expect(c.voiceJudge).toBeUndefined();
    expect(loadConfig(GW).voiceJudge).toEqual({
      provider: 'openai',
      domain: 'api.openai.com',
      prefix: null,
      model: 'gpt-4o-audio-preview',
    });
    expect(c.gateway.adminKey).toBeUndefined();
    expect(c.endpoints.llm).toMatchObject({ url: 'https://api.openai.com/v1', apiKey: undefined });
  });

  it('configures TTS and the speaker check through the gateway proxy', () => {
    expect(loadConfig({ ...GW, RIDEO_TTS_PROVIDER: 'elevenlabs' }).tts).toEqual({
      provider: 'elevenlabs',
      domain: 'api.elevenlabs.io',
      prefix: null,
      model: 'eleven_multilingual_v2',
    });
    expect(
      loadConfig({
        ...GW,
        RIDEO_TTS_PROVIDER: 'openai',
        RIDEO_TTS_PROXY_DOMAIN: 'tts.internal',
        RIDEO_TTS_MODEL: 'tts-1',
      }).tts,
    ).toEqual({ provider: 'openai', domain: 'tts.internal', prefix: null, model: 'tts-1' });
    // Anthropic models do not take audio: no speaker check unless another provider is named.
    expect(loadConfig({ ...GW, RIDEO_VISION_PROVIDER: 'anthropic' }).voiceJudge).toBeUndefined();
    expect(
      loadConfig({ ...GW, RIDEO_VISION_PROVIDER: 'anthropic', RIDEO_VOICE_JUDGE_PROVIDER: 'gemini' })
        .voiceJudge,
    ).toEqual({
      provider: 'gemini',
      domain: 'generativelanguage.googleapis.com',
      prefix: null,
      model: 'gemini-2.5-flash',
    });
    expect(loadConfig({ RIDEO_VOICE_JUDGE_PROVIDER: 'off' }).voiceJudge).toBeUndefined();
    expect(() => loadConfig({ RIDEO_TTS_PROVIDER: 'mystery' })).toThrow();
  });

  it('configures sound effects through the gateway proxy (docs/design/post-audio.md)', () => {
    expect(loadConfig({}).sfx).toBeUndefined();
    expect(loadConfig({ ...GW, RIDEO_SFX_PROVIDER: 'elevenlabs' }).sfx).toEqual({
      provider: 'elevenlabs',
      domain: 'api.elevenlabs.io',
      prefix: null,
      model: 'eleven_text_to_sound_v2',
    });
    expect(
      loadConfig({
        ...GW,
        RIDEO_SFX_PROVIDER: 'elevenlabs',
        RIDEO_SFX_PROXY_DOMAIN: 'sfx.internal',
        RIDEO_SFX_MODEL: 'x',
      }).sfx,
    ).toEqual({ provider: 'elevenlabs', domain: 'sfx.internal', prefix: null, model: 'x' });
    expect(() => loadConfig({ RIDEO_SFX_PROVIDER: 'mystery' })).toThrow();
  });

  it('switches to an external WebDAV server and provider domains', () => {
    const c = loadConfig({
      RIDEO_WEBDAV_URL: 'https://dav.example/remote.php',
      RIDEO_WEBDAV_ROOT: 'studio/',
      RIDEO_LLM_PROVIDER: 'gemini',
      RIDEO_VISION_PROVIDER: 'anthropic',
      RIDEO_LANES: 'video=4, bogus=x',
    });
    expect(c.webdav).toMatchObject({ embedded: false, root: '/studio' });
    expect(c.storage.mode).toBe('webdav');
    expect(c.llm.domain).toBe('generativelanguage.googleapis.com');
    expect(c.vision).toMatchObject({ provider: 'anthropic', domain: 'api.anthropic.com' });
    expect(parseLanes('video=4, bogus=x').video).toBe(4);
  });

  it('reads API base URLs and API keys (docs/design/settings.md#provider-endpoints-and-api-keys)', () => {
    const c = loadConfig({
      ...GW,
      MM_GATEWAY_ADMIN_KEY: 'admin',
      RIDEO_LLM_PROXY_DOMAIN: 'https://ai.example.com/v1',
      RIDEO_LLM_API_KEY: 'sk-text',
      RIDEO_LLM_MODEL: 'qwen-max',
      RIDEO_STT_PROXY_DOMAIN: 'https://ai.example.com/v1',
      RIDEO_EMBEDDINGS_PROXY_DOMAIN: 'https://ark.example.cn/api/v3',
      RIDEO_EMBEDDINGS_API_KEY: 'sk-embed',
    });
    expect(c.gateway.adminKey).toBe('admin');
    expect(c.llm).toEqual({ provider: 'openai', domain: 'ai.example.com', prefix: 'v1', model: 'qwen-max' });
    // vision follows the text model: provider, base URL, model and key
    expect(c.vision).toEqual({
      provider: 'openai',
      domain: 'ai.example.com',
      prefix: 'v1',
      model: 'qwen-max',
    });
    expect(c.endpoints.vision).toMatchObject({ apiKey: 'sk-text', keyFrom: 'llm' });
    // speech-to-text on the same origin shares the key; embeddings use their own
    expect(c.stt).toEqual({ provider: 'openai', domain: 'ai.example.com', prefix: 'v1', model: 'whisper-1' });
    expect(c.endpoints.stt).toMatchObject({ apiKey: 'sk-text', keyFrom: 'llm' });
    expect(c.embeddings).toMatchObject({ domain: 'ark.example.cn', prefix: 'api/v3' });
    expect(c.endpoints.embeddings).toMatchObject({
      apiKey: 'sk-embed',
      url: 'https://ark.example.cn/api/v3',
    });
    expect(c.endpoints.embeddings?.keyFrom).toBeUndefined();
    // the speaker check follows the vision model's base URL for the same provider
    expect(c.voiceJudge).toMatchObject({ provider: 'openai', domain: 'ai.example.com', prefix: 'v1' });
  });

  it('refuses base URLs that do not parse and two keyed origins on one domain', () => {
    const paths = (env: Record<string, string>) => {
      try {
        loadConfig(env);
        return [];
      } catch (err) {
        return (err as { issues: { path: string[] }[] }).issues.map((i) => i.path.join('.'));
      }
    };
    expect(paths({ RIDEO_LLM_PROXY_DOMAIN: 'https://user:pw@ai.example.com/v1' })).toEqual([
      'RIDEO_LLM_PROXY_DOMAIN',
    ]);
    expect(paths({ RIDEO_STT_PROXY_DOMAIN: 'ftp://files.example.com' })).toEqual(['RIDEO_STT_PROXY_DOMAIN']);
    expect(
      paths({
        RIDEO_LLM_PROXY_DOMAIN: 'http://localhost:8080/v1',
        RIDEO_LLM_API_KEY: 'a',
        RIDEO_EMBEDDINGS_PROXY_DOMAIN: 'http://localhost:9090/v1',
        RIDEO_EMBEDDINGS_API_KEY: 'b',
      }),
    ).toEqual(['RIDEO_EMBEDDINGS_PROXY_DOMAIN']);
    // without keys the studio registers nothing, so two origins on one domain are fine
    expect(
      paths({
        RIDEO_LLM_PROXY_DOMAIN: 'http://localhost:8080/v1',
        RIDEO_STT_PROXY_DOMAIN: 'http://localhost:9090',
      }),
    ).toEqual([]);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ RIDEO_PORT: 'eighty' })).toThrow();
    expect(() => loadConfig({ RIDEO_LLM_PROVIDER: 'mystery' })).toThrow();
  });

  it('reports rules across settings on the setting to fix (docs/design/settings.md#surfaces)', () => {
    const issues = (env: Record<string, string>) => {
      try {
        loadConfig(env);
        return [];
      } catch (err) {
        return (err as { issues: { path: string[]; message: string }[] }).issues.map((i) => i.path.join('.'));
      }
    };
    expect(issues({ RIDEO_OIDC_ISSUER: 'https://idp.test' })).toEqual(['RIDEO_OIDC_CLIENT_ID']);
    expect(issues({ RIDEO_STORAGE: 'webdav' })).toEqual(['RIDEO_WEBDAV_URL']);
    expect(issues({ MM_GATEWAY_URL: 'gateway:8000' })).toEqual(['MM_GATEWAY_URL']);
    expect(issues({ RIDEO_BASE_PATH: '//evil.test' })).toEqual(['RIDEO_BASE_PATH']);
    expect(issues({ RIDEO_THEME: '{"colors":{"accent":"red;}"}}' })).toEqual(['RIDEO_THEME']);
  });

  it('merges the settings file under the environment (docs/design/settings.md#where-values-come-from)', () => {
    const settings = { MM_GATEWAY_URL: 'http://from-settings:8000', RIDEO_BRAND_NAME: 'Studio Nine' };
    const c = loadConfig({ RIDEO_BRAND_NAME: 'From env', RIDEO_LLM_MODEL: '' }, {}, settings);
    expect(c.gateway).toMatchObject({ url: 'http://from-settings:8000', configured: true });
    expect(c.brand.name).toBe('From env');
    // an empty variable is unset: the setting (or the default) applies
    expect(loadConfig({ RIDEO_BRAND_NAME: '' }, {}, settings).brand.name).toBe('Studio Nine');
    expect(c.source.settings).toBe(settings);
    expect(c.source.env.RIDEO_BRAND_NAME).toBe('From env');
  });

  it('serves under the base path of the public URL or RIDEO_BASE_PATH (docs/design/subpath.md)', () => {
    expect(loadConfig({ RIDEO_PUBLIC_URL: 'https://example.com/rideo/' }).basePath).toBe('/rideo');
    expect(loadConfig({ RIDEO_BASE_PATH: '/studio/' })).toMatchObject({
      basePath: '/studio',
      publicUrl: 'http://localhost:8787/studio',
    });
    expect(loadConfig({ RIDEO_PUBLIC_URL: 'https://example.com/a', RIDEO_BASE_PATH: '/b' }).basePath).toBe(
      '/b',
    );
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('/a/b/')).toBe('/a/b');
    expect(normalizeBasePath('/a/../b')).toBeNull();
    expect(normalizeBasePath('a')).toBeNull();
    expect(normalizeBasePath('/a?x=1')).toBeNull();
  });

  it('resolves auto storage: WebDAV with a URL, the built-in store when it has projects, else the browser', () => {
    expect(loadConfig({ RIDEO_EMBEDDED_DAV: 'true' }).storage.mode).toBe('embedded');
    const fresh = loadConfig({});
    expect(resolveStorageMode(fresh, false)).toMatchObject({
      storage: { mode: 'browser' },
      webdav: { embedded: false },
    });
    expect(resolveStorageMode(fresh, true)).toMatchObject({
      storage: { mode: 'embedded' },
      webdav: { embedded: true },
    });
    const browser = loadConfig({ RIDEO_STORAGE: 'browser', RIDEO_EMBEDDED_DAV: 'true' });
    expect(resolveStorageMode(browser, true)).toMatchObject({
      storage: { mode: 'browser' },
      webdav: { embedded: true },
    });
  });

  it('parses embedding origins and the studio theme (docs/design/embedding.md)', () => {
    const c = loadConfig({
      RIDEO_CORS_ORIGINS: 'https://app.example.com/, http://localhost:3000',
      RIDEO_THEME: JSON.stringify({ mode: 'light', colors: { accent: '#7c3aed' } }),
    });
    expect(c.cors.origins).toEqual(['https://app.example.com', 'http://localhost:3000']);
    expect(c.theme).toEqual({ mode: 'light', colors: { accent: '#7c3aed' } });
  });
});

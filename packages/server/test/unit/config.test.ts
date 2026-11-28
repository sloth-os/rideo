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

  it('configures the audio-visual model only when a model is named, on the vision base URL and key', () => {
    expect(loadConfig(GW).omni).toBeUndefined();
    const c = loadConfig({
      ...GW,
      RIDEO_LLM_PROXY_DOMAIN: 'https://newapi.example.com/v1',
      RIDEO_LLM_API_KEY: 'sk-llm',
      RIDEO_LLM_MODEL: 'qwen3.8-max',
      RIDEO_OMNI_MODEL: 'qwen3.8-omni-flash',
    });
    expect(c.omni).toEqual({
      provider: 'openai',
      domain: 'newapi.example.com',
      prefix: 'v1',
      model: 'qwen3.8-omni-flash',
    });
    expect(c.endpoints.omni).toMatchObject({ apiKey: 'sk-llm', keyFrom: 'llm' });
    // Anthropic models take no audio or video: off unless another provider is named.
    expect(
      loadConfig({ ...GW, RIDEO_VISION_PROVIDER: 'anthropic', RIDEO_OMNI_MODEL: 'claude-x' }).omni,
    ).toBeUndefined();
    expect(
      loadConfig({
        ...GW,
        RIDEO_VISION_PROVIDER: 'anthropic',
        RIDEO_OMNI_PROVIDER: 'gemini',
        RIDEO_OMNI_MODEL: 'gemini-2.5-flash',
      }).omni,
    ).toEqual({
      provider: 'gemini',
      domain: 'generativelanguage.googleapis.com',
      prefix: null,
      model: 'gemini-2.5-flash',
    });
    expect(loadConfig({ ...GW, RIDEO_OMNI_PROVIDER: 'off', RIDEO_OMNI_MODEL: 'm' }).omni).toBeUndefined();
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
    // the desk's page: https, or http on localhost; a page, not a folder (docs/design/director-desk.md#the-setting)
    expect(issues({ RIDEO_DESK_URL: 'http://desk.example.com/desk.html' })).toEqual(['RIDEO_DESK_URL']);
    expect(issues({ RIDEO_DESK_URL: 'https://desk.example.com/' })).toEqual(['RIDEO_DESK_URL']);
    expect(issues({ RIDEO_DESK_URL: 'desk.html' })).toEqual(['RIDEO_DESK_URL']);
    expect(issues({ RIDEO_DESK_URL: 'http://localhost:5174/desk.html' })).toEqual([]);
  });

  it("refuses a desk on the studio's own host name when accounts are on (docs/design/director-desk.md#topology-and-headers)", () => {
    const accounts = {
      RIDEO_OIDC_ISSUER: 'https://idp.test',
      RIDEO_OIDC_CLIENT_ID: 'rideo',
      RIDEO_PUBLIC_URL: 'https://studio.example.com',
    };
    const refusal = (env: Record<string, string>) => {
      try {
        loadConfig(env);
        return null;
      } catch (err) {
        const issues = (err as { issues: { path: string[]; message: string }[] }).issues;
        return issues.find((i) => i.path.join('.') === 'RIDEO_DESK_URL')?.message ?? null;
      }
    };
    // another port of the studio's host gets its host-only session cookie
    const sameHost = refusal({ ...accounts, RIDEO_DESK_URL: 'https://studio.example.com:8443/desk.html' });
    expect(sameHost).toMatch(/another host than the studio's \(studio\.example\.com\)/);
    expect(sameHost).toMatch(/session cookie/);
    expect(refusal({ ...accounts, RIDEO_DESK_URL: 'https://STUDIO.example.com/desk/desk.html' })).toMatch(
      /another host/,
    );
    // without a public URL the studio is on localhost
    const local = { ...accounts, RIDEO_PUBLIC_URL: '' };
    expect(refusal({ ...local, RIDEO_DESK_URL: 'http://localhost:5174/desk.html' })).toMatch(/another host/);
    expect(refusal({ ...local, RIDEO_DESK_URL: 'http://127.0.0.1:5174/desk.html' })).toBeNull();
    // another host (a subdomain is one) is fine
    expect(loadConfig({ ...accounts, RIDEO_DESK_URL: 'https://desk.example.com/desk.html' }).desk).toEqual({
      url: 'https://desk.example.com/desk.html',
    });
    // without accounts there is no session cookie to send
    expect(
      loadConfig({
        RIDEO_PUBLIC_URL: 'https://studio.example.com',
        RIDEO_DESK_URL: 'https://studio.example.com:8443/desk.html',
      }).desk,
    ).toEqual({ url: 'https://studio.example.com:8443/desk.html' });
  });

  it('reads the desk page (docs/design/director-desk.md#the-setting)', () => {
    expect(loadConfig({}).desk).toBeNull();
    expect(loadConfig({ RIDEO_DESK_URL: ' https://desk.example.com/desk.html ' }).desk).toEqual({
      url: 'https://desk.example.com/desk.html',
    });
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

  it('refuses a RIDEO_BASE_PATH longer than 256 characters (docs/design/subpath.md#the-base-path)', () => {
    const longest = `/${'a'.repeat(255)}`;
    expect(loadConfig({ RIDEO_BASE_PATH: longest }).basePath).toBe(longest);
    expect(normalizeBasePath(longest)).toBe(longest);
    for (const value of [`${longest}a`, `${longest}/`, `/a${'/'.repeat(300)}`]) {
      let message: string | undefined;
      try {
        loadConfig({ RIDEO_BASE_PATH: value });
      } catch (err) {
        const issues = (err as { issues: { path: string[]; message: string }[] }).issues;
        message = issues.find((i) => i.path.join('.') === 'RIDEO_BASE_PATH')?.message;
      }
      expect(message, value.slice(0, 20)).toBe('a path of at most 256 characters');
      expect(normalizeBasePath(value)).toBeNull();
    }
  });

  it('refuses a RIDEO_BASE_PATH that starts with one of the studio’s own paths (docs/design/subpath.md#the-base-path)', () => {
    const refusal = (value: string) => {
      try {
        loadConfig({ RIDEO_BASE_PATH: value });
      } catch (err) {
        const issues = (err as { issues: { path: string[]; message: string }[] }).issues;
        return issues.find((i) => i.path.join('.') === 'RIDEO_BASE_PATH')?.message;
      }
      return undefined;
    };
    for (const value of [
      '/api',
      '/api/',
      '/dav/x',
      '/mcp',
      '/metrics',
      '/sw.js',
      '/assets/v2',
      '/index.html',
    ]) {
      expect(refusal(value), value).toBe(
        "a path whose first segment is not one of the studio's own (/api, /mcp, /metrics, /dav, /assets, /icons, " +
          '/index.html, /logo.svg, /manifest.webmanifest, /sw.js, /sw.js.map)',
      );
      expect(normalizeBasePath(value), value).toBeNull();
    }
    // a segment is the studio's only when it is one exactly
    for (const value of [
      '/api-docs',
      '/apis',
      '/davinci',
      '/API',
      '/metrics2',
      '/sw',
      '/studio/api',
      '/rideo/dav',
    ]) {
      expect(loadConfig({ RIDEO_BASE_PATH: value }).basePath, value).toBe(value);
    }
    // a path like /rideo is the rule a value breaks first
    expect(refusal('/api/../x')).toBe('a path like /rideo (letters, digits, . _ ~ -)');
  });

  it('does not use a RIDEO_PUBLIC_URL path that is no base path, and says why (docs/design/subpath.md#the-base-path)', () => {
    const long = `/${'a'.repeat(300)}`;
    for (const [url, reason] of [
      ['https://example.com/api', "its first segment is one of the studio's own paths (/api, /mcp"],
      ['https://example.com/dav/x/', "its first segment is one of the studio's own paths"],
      [`https://example.com${long}`, 'it is longer than 256 characters'],
      ['https://example.com/my studio', 'it is not a path of segments of letters, digits and . _ ~ -'],
    ] as const) {
      // not refused: the studio serves at the root (and under a stripping proxy's X-Forwarded-Prefix)
      const c = loadConfig({ RIDEO_PUBLIC_URL: url });
      expect(c.basePath, url).toBe('');
      expect(c.publicUrlPathIgnored?.path, url).toBe(new URL(url).pathname);
      expect(c.publicUrlPathIgnored?.reason, url).toContain(reason);
    }
    expect(loadConfig({ RIDEO_PUBLIC_URL: 'https://example.com/api' }).publicUrl).toBe(
      'https://example.com/api',
    );
    // used, the root, none, or RIDEO_BASE_PATH set: nothing to say
    for (const env of [
      { RIDEO_PUBLIC_URL: 'https://example.com/rideo/' },
      { RIDEO_PUBLIC_URL: 'https://example.com/' },
      {},
      { RIDEO_PUBLIC_URL: 'https://example.com/api', RIDEO_BASE_PATH: '/studio' },
    ]) {
      expect(loadConfig(env).publicUrlPathIgnored, JSON.stringify(env)).toBeNull();
    }
    expect(
      loadConfig({ RIDEO_PUBLIC_URL: 'https://example.com/api', RIDEO_BASE_PATH: '/studio' }).basePath,
    ).toBe('/studio');
  });

  it('reads URL settings in time linear in their length, a run of slashes too (docs/design/settings.md)', () => {
    // `/\/+$/` and `/^\/+|\/+$/g` took about 17 s on each of these: quadratic in a run of slashes before a character
    const run = '/'.repeat(200_000);
    const started = performance.now();
    const c = loadConfig({
      RIDEO_CORS_ORIGINS: `https://a.example${run}x, https://b.example${run}`,
      MM_GATEWAY_URL: `http://gateway.example${run}x`,
      RIDEO_PUBLIC_URL: `https://example.com/rideo${run}x`,
      RIDEO_WEBDAV_ROOT: `${run}projects${run}x`,
      RIDEO_LLM_PROXY_DOMAIN: `https://ai.example.com${run}v1${run}x`,
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(c.cors.origins).toEqual([`https://a.example${run}x`, 'https://b.example']);
    expect(c.gateway.url).toBe(`http://gateway.example${run}x`);
    expect(c.publicUrl).toBe(`https://example.com/rideo${run}x`);
    expect(c.basePath).toBe('');
    expect(c.publicUrlPathIgnored?.reason).toBe('it is longer than 256 characters');
    expect(c.webdav.root).toBe(`/projects${run}x`);
    expect(c.llm?.prefix).toBe(`v1${run}x`);
    // trailing runs go
    const trimmed = loadConfig({
      MM_GATEWAY_URL: `http://gateway.example/v1${run}`,
      RIDEO_WEBDAV_ROOT: `${run}r${run}`,
    });
    expect(trimmed.gateway.url).toBe('http://gateway.example/v1');
    expect(trimmed.webdav.root).toBe('/r');
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

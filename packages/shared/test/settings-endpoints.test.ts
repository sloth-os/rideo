import { describe, expect, it } from 'vitest';
import {
  apiBaseProblem,
  credentialHeaders,
  desiredProxies,
  endpointOfSetting,
  PROVIDER_APIS,
  parseApiBase,
  resolveEndpoints,
  SETTING_ENDPOINT_IDS,
  SETTING_ENDPOINTS,
  SETTING_FIELDS,
  settingField,
  withPrefix,
} from '../src';

describe('the endpoint table (docs/design/settings.md#endpoints)', () => {
  it('names settings of its own group, with secret keys, and falls back to earlier endpoints', () => {
    expect(SETTING_ENDPOINTS.map((e) => e.id)).toEqual([...SETTING_ENDPOINT_IDS]);
    for (const [i, e] of SETTING_ENDPOINTS.entries()) {
      for (const env of [e.provider, e.url, e.key, e.model].filter((v): v is string => !!v)) {
        expect(settingField(env)?.group, env).toBe(e.group);
        expect(endpointOfSetting(env)?.id, env).toBe(e.id);
      }
      expect(settingField(e.key)?.kind, e.key).toBe('secret');
      expect(settingField(e.url)?.kind, e.url).toBe('url');
      expect(!!e.provider !== !!e.fixedProvider, e.id).toBe(true);
      if (e.inherits)
        expect(
          SETTING_ENDPOINTS.findIndex((x) => x.id === e.inherits),
          e.id,
        ).toBeLessThan(i);
      for (const p of Object.keys(e.paths)) expect(p in PROVIDER_APIS, `${e.id} ${p}`).toBe(true);
    }
    // every option of a select reads as something
    for (const f of SETTING_FIELDS.filter((f) => f.optionLabels))
      for (const o of f.options ?? []) expect(f.optionLabels?.[o], `${f.env} ${o}`).toBeTruthy();
  });

  it('puts each provider’s key in the header its API reads', () => {
    expect(credentialHeaders('openai', 'sk')).toEqual({ authorization: 'Bearer sk' });
    expect(credentialHeaders('gemini', 'g')).toEqual({ 'x-goog-api-key': 'g' });
    expect(credentialHeaders('anthropic', 'a')).toEqual({ 'x-api-key': 'a' });
    expect(credentialHeaders('elevenlabs', 'e')).toEqual({ 'xi-api-key': 'e' });
  });
});

describe('API base URLs (docs/design/settings.md#api-base-url)', () => {
  it('reads documented base URLs and bare domains', () => {
    expect(parseApiBase('api.openai.com')).toEqual({
      domain: 'api.openai.com',
      origin: 'https://api.openai.com',
      prefix: null,
    });
    expect(parseApiBase('https://ai.example.com/v1/')).toEqual({
      domain: 'ai.example.com',
      origin: 'https://ai.example.com',
      prefix: 'v1',
    });
    expect(parseApiBase('https://ark.cn-beijing.volces.com/api/v3')).toMatchObject({ prefix: 'api/v3' });
    expect(parseApiBase('https://AI.Example.com')).toEqual({
      domain: 'ai.example.com',
      origin: 'https://ai.example.com',
      prefix: null,
    });
    expect(parseApiBase('http://localhost:8080/v1')).toEqual({
      domain: 'localhost',
      origin: 'http://localhost:8080',
      prefix: 'v1',
    });
    expect(parseApiBase('tts.internal:9000')).toEqual({
      domain: 'tts.internal',
      origin: 'https://tts.internal:9000',
      prefix: null,
    });
  });

  it('refuses credentials, queries, fragments and other schemes', () => {
    for (const bad of [
      'https://user:pw@ai.example.com/v1',
      'https://ai.example.com/v1?key=1',
      'https://ai.example.com/v1#x',
      'ftp://files.example.com',
      'not a url',
    ]) {
      expect(parseApiBase(bad), bad).toBeNull();
      expect(apiBaseProblem(bad), bad).toMatch(/API base URL/);
    }
    // dot segments are resolved, never kept
    expect(parseApiBase('https://ai.example.com/a/%2e%2e/v1')?.prefix).toBe('v1');
    expect(apiBaseProblem('')).toBeNull();
    expect(apiBaseProblem(null)).toBeNull();
  });

  it('replaces the version segment of a path with the base URL’s path', () => {
    expect(withPrefix('v1/chat/completions', null)).toBe('v1/chat/completions');
    expect(withPrefix('v1/chat/completions', 'api/v3')).toBe('api/v3/chat/completions');
    expect(withPrefix('/v1beta/models/m:generateContent', 'v1')).toBe('v1/models/m:generateContent');
    expect(withPrefix('v1/models', 'compatible-mode/v1')).toBe('compatible-mode/v1/models');
  });
});

describe('endpoints from settings (docs/design/settings.md#keys)', () => {
  const gw = { gateway: true };

  it('applies the documented defaults and fallbacks', () => {
    const e = resolveEndpoints({ RIDEO_LLM_PROVIDER: 'openai' }, gw);
    expect(e.llm).toMatchObject({
      provider: 'openai',
      url: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
    });
    expect(e.vision).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini' });
    expect(e.voiceJudge).toMatchObject({ provider: 'openai', model: 'gpt-4o-audio-preview' });
    expect(e.stt).toBeNull();
    expect(e.embeddings).toBeNull();
    expect(e.tts).toBeNull();
    expect(e.sfx).toBeNull();
    // Gemini keeps its own API version; Anthropic vision has no speaker check
    const g = resolveEndpoints({ RIDEO_LLM_PROVIDER: 'gemini', RIDEO_VISION_PROVIDER: 'anthropic' }, gw);
    expect(g.llm?.url).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(g.vision).toMatchObject({ provider: 'anthropic', url: 'https://api.anthropic.com/v1' });
    expect(g.voiceJudge).toBeNull();
    // without a gateway only the text and vision models resolve
    const off = resolveEndpoints(
      { RIDEO_STT_PROXY_DOMAIN: 'api.openai.com', RIDEO_TTS_PROVIDER: 'openai' },
      {
        gateway: false,
      },
    );
    expect(off.stt).toBeNull();
    expect(off.tts).toBeNull();
    expect(off.llm).not.toBeNull();
  });

  it('shares a key with endpoints on the same origin, never across origins', () => {
    const e = resolveEndpoints(
      {
        RIDEO_LLM_PROXY_DOMAIN: 'https://ai.example.com/v1',
        RIDEO_STT_PROXY_DOMAIN: 'https://ai.example.com/v1',
        RIDEO_STT_API_KEY: 'sk-stt',
        RIDEO_EMBEDDINGS_PROXY_DOMAIN: 'https://other.example.com/v1',
        RIDEO_TTS_PROVIDER: 'elevenlabs',
        RIDEO_TTS_API_KEY: 'xi',
      },
      gw,
    );
    // the text model has no key of its own: the first endpoint on its origin with one lends it
    expect(e.llm).toMatchObject({ apiKey: 'sk-stt', keyFrom: 'stt' });
    expect(e.vision).toMatchObject({ apiKey: 'sk-stt', keyFrom: 'stt' });
    expect(e.stt).toMatchObject({ apiKey: 'sk-stt' });
    expect(e.stt?.keyFrom).toBeUndefined();
    expect(e.embeddings?.apiKey).toBeUndefined();
    expect(e.tts).toMatchObject({
      provider: 'elevenlabs',
      apiKey: 'xi',
      url: 'https://api.elevenlabs.io/v1',
    });
    // a vision provider of its own leaves the text model's base URL and key alone
    const v = resolveEndpoints(
      {
        RIDEO_LLM_PROXY_DOMAIN: 'https://ai.example.com/v1',
        RIDEO_LLM_API_KEY: 'k',
        RIDEO_VISION_PROVIDER: 'gemini',
      },
      gw,
    );
    expect(v.vision).toMatchObject({
      provider: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta',
    });
    expect(v.vision?.apiKey).toBeUndefined();
  });

  it('derives one proxy per domain and one account per key, refusing a second origin', () => {
    const e = resolveEndpoints(
      {
        RIDEO_LLM_PROXY_DOMAIN: 'https://ai.example.com/v1',
        RIDEO_LLM_API_KEY: 'k1',
        RIDEO_VISION_PROVIDER: 'anthropic',
        RIDEO_VISION_PROXY_DOMAIN: 'https://ai.example.com',
        RIDEO_VISION_API_KEY: 'k1',
        RIDEO_EMBEDDINGS_PROXY_DOMAIN: 'https://ai.example.com/v1',
        RIDEO_EMBEDDINGS_API_KEY: 'k2',
        RIDEO_TTS_PROVIDER: 'openai',
        RIDEO_TTS_PROXY_DOMAIN: 'http://ai.example.com:8080/v1',
        RIDEO_TTS_API_KEY: 'k3',
      },
      gw,
    );
    const { proxies, conflicts } = desiredProxies(e, (key) => `acct-${key}`);
    expect([...proxies.keys()]).toEqual(['ai.example.com']);
    expect(proxies.get('ai.example.com')).toEqual({
      domain: 'ai.example.com',
      origin: 'https://ai.example.com',
      accounts: [
        // the text and vision models share k1: one account carrying both providers' headers
        {
          id: 'acct-k1',
          headers: { authorization: 'Bearer k1', 'x-api-key': 'k1' },
          endpoints: ['llm', 'vision'],
        },
        { id: 'acct-k2', headers: { authorization: 'Bearer k2' }, endpoints: ['embeddings'] },
      ],
    });
    expect(conflicts).toEqual([
      {
        id: 'tts',
        message: expect.stringMatching(/one API per domain: ai.example.com is https:\/\/ai.example.com/),
      },
    ]);
    expect(desiredProxies(resolveEndpoints({}, gw), (k) => k).proxies.size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig, parseLanes } from '../../src/config';

describe('config', () => {
  it('applies documented defaults', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8787);
    expect(c.webdav).toMatchObject({ embedded: true, root: '/rideo', syncIntervalSec: 15 });
    expect(c.llm).toEqual({ provider: 'openai', domain: 'api.openai.com', model: 'gpt-4.1-mini' });
    expect(c.vision.model).toBe('gpt-4.1-mini');
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
    expect(c.voiceJudge).toEqual({
      provider: 'openai',
      domain: 'api.openai.com',
      model: 'gpt-4o-audio-preview',
    });
  });

  it('configures TTS and the speaker check through the gateway proxy', () => {
    expect(loadConfig({ RIDEO_TTS_PROVIDER: 'elevenlabs' }).tts).toEqual({
      provider: 'elevenlabs',
      domain: 'api.elevenlabs.io',
      model: 'eleven_multilingual_v2',
    });
    expect(
      loadConfig({
        RIDEO_TTS_PROVIDER: 'openai',
        RIDEO_TTS_PROXY_DOMAIN: 'tts.internal',
        RIDEO_TTS_MODEL: 'tts-1',
      }).tts,
    ).toEqual({ provider: 'openai', domain: 'tts.internal', model: 'tts-1' });
    // Anthropic models do not take audio: no speaker check unless another provider is named.
    expect(loadConfig({ RIDEO_VISION_PROVIDER: 'anthropic' }).voiceJudge).toBeUndefined();
    expect(
      loadConfig({ RIDEO_VISION_PROVIDER: 'anthropic', RIDEO_VOICE_JUDGE_PROVIDER: 'gemini' }).voiceJudge,
    ).toEqual({ provider: 'gemini', domain: 'generativelanguage.googleapis.com', model: 'gemini-2.5-flash' });
    expect(loadConfig({ RIDEO_VOICE_JUDGE_PROVIDER: 'off' }).voiceJudge).toBeUndefined();
    expect(() => loadConfig({ RIDEO_TTS_PROVIDER: 'mystery' })).toThrow();
  });

  it('configures sound effects through the gateway proxy (docs/design/post-audio.md)', () => {
    expect(loadConfig({}).sfx).toBeUndefined();
    expect(loadConfig({ RIDEO_SFX_PROVIDER: 'elevenlabs' }).sfx).toEqual({
      provider: 'elevenlabs',
      domain: 'api.elevenlabs.io',
      model: 'eleven_text_to_sound_v2',
    });
    expect(
      loadConfig({
        RIDEO_SFX_PROVIDER: 'elevenlabs',
        RIDEO_SFX_PROXY_DOMAIN: 'sfx.internal',
        RIDEO_SFX_MODEL: 'x',
      }).sfx,
    ).toEqual({ provider: 'elevenlabs', domain: 'sfx.internal', model: 'x' });
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
    expect(c.llm.domain).toBe('generativelanguage.googleapis.com');
    expect(c.vision).toMatchObject({ provider: 'anthropic', domain: 'api.anthropic.com' });
    expect(parseLanes('video=4, bogus=x').video).toBe(4);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ RIDEO_PORT: 'eighty' })).toThrow();
    expect(() => loadConfig({ RIDEO_LLM_PROVIDER: 'mystery' })).toThrow();
  });
});

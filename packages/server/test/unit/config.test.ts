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
    expect(c.gateway.models).toEqual({ image: 'auto', video: 'auto', music: 'auto' });
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const encodable = vi.hoisted(() => ({ video: new Set<string>(), audio: new Set<string>() }));
vi.mock('mediabunny', () => ({
  getFirstEncodableVideoCodec: async (codecs: string[]) => codecs.find((c) => encodable.video.has(c)) ?? null,
  getFirstEncodableAudioCodec: async (codecs: string[]) => codecs.find((c) => encodable.audio.has(c)) ?? null,
}));

import { detectCaps } from '../src/features/editor/engine/capabilities';

async function caps(video: string[], audio: string[]) {
  encodable.video = new Set(video);
  encodable.audio = new Set(audio);
  return detectCaps(320, 180);
}

describe('detectCaps', () => {
  beforeEach(() => {
    vi.stubGlobal('VideoDecoder', class {});
    vi.stubGlobal('VideoEncoder', class {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('prefers MP4 with H.264 + AAC', async () => {
    expect(await caps(['avc', 'vp9'], ['aac', 'opus'])).toMatchObject({
      container: 'mp4',
      video: 'avc',
      audio: 'aac',
    });
  });

  it('never puts H.264 into WebM (Chromium builds without AAC)', async () => {
    expect(await caps(['avc', 'vp9'], ['opus'])).toMatchObject({
      container: 'webm',
      video: 'vp9',
      audio: 'opus',
    });
  });

  it('falls back to MP4 with H.264 + Opus, and to video-only without an audio encoder', async () => {
    expect(await caps(['avc'], ['opus'])).toMatchObject({ container: 'mp4', video: 'avc', audio: 'opus' });
    expect(await caps(['vp8'], [])).toMatchObject({ container: 'webm', video: 'vp8', audio: null });
  });

  it('reports nothing encodable without WebCodecs', async () => {
    vi.unstubAllGlobals();
    expect(await caps(['avc'], ['aac'])).toEqual({
      webcodecs: false,
      video: null,
      audio: null,
      container: null,
    });
  });
});

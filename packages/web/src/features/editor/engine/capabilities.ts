import {
  type AudioCodec,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type VideoCodec,
} from 'mediabunny';

export interface EngineCaps {
  webcodecs: boolean;
  video: VideoCodec | null;
  audio: AudioCodec | null;
  container: 'mp4' | 'webm' | null;
}

/**
 * What this browser can encode, as a valid container/codec pair
 * (docs/design/editor.md#browser-engine-webcodecs-via-mediabunny): MP4 with H.264 + AAC for
 * compatibility, else WebM with VP9/AV1/VP8 + Opus, else MP4 with H.264 + Opus. WebM never carries
 * H.264. Without an audio encoder the export is video-only.
 */
export async function detectCaps(width: number, height: number): Promise<EngineCaps> {
  const webcodecs =
    typeof globalThis.VideoDecoder !== 'undefined' && typeof globalThis.VideoEncoder !== 'undefined';
  if (!webcodecs) return { webcodecs, video: null, audio: null, container: null };
  const video = (codecs: VideoCodec[]) =>
    getFirstEncodableVideoCodec(codecs, { width, height }).catch(() => null);
  const audio = (codecs: AudioCodec[]) => getFirstEncodableAudioCodec(codecs).catch(() => null);

  const avc = await video(['avc']);
  const aac = avc ? await audio(['aac']) : null;
  if (avc && aac) return { webcodecs, video: avc, audio: aac, container: 'mp4' };
  const opus = await audio(['opus']);
  const open = await video(['vp9', 'av1', 'vp8']);
  if (open) return { webcodecs, video: open, audio: opus, container: 'webm' };
  if (avc) return { webcodecs, video: avc, audio: opus, container: 'mp4' };
  return { webcodecs, video: null, audio: null, container: null };
}

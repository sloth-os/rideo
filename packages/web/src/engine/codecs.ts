/**
 * Whether WebCodecs can decode a media file's codecs, from the ffmpeg codec names in its MediaRef
 * (docs/design/editor.md#playback-compatibility-local-proxies). Checked once per codec.
 */

const VIDEO: Record<string, string[]> = {
  h264: ['avc1.64001f', 'avc1.4d401f', 'avc1.42e01e'],
  hevc: ['hvc1.1.6.L93.B0'],
  vp8: ['vp8'],
  vp9: ['vp09.00.10.08'],
  av1: ['av01.0.04M.08'],
};
const AUDIO: Record<string, string> = {
  aac: 'mp4a.40.2',
  opus: 'opus',
  mp3: 'mp3',
  vorbis: 'vorbis',
  flac: 'flac',
};

const cache = new Map<string, Promise<boolean>>();

function once(key: string, check: () => Promise<boolean>): Promise<boolean> {
  let p = cache.get(key);
  if (!p) {
    p = check().catch(() => false);
    cache.set(key, p);
  }
  return p;
}

export function canDecodeVideo(codec: string | undefined): Promise<boolean> {
  if (!codec) return Promise.resolve(true); // unknown: let the demuxer decide
  const strings = VIDEO[codec];
  if (!strings || typeof VideoDecoder === 'undefined') return Promise.resolve(false);
  return once(`v:${codec}`, async () => {
    for (const c of strings) if ((await VideoDecoder.isConfigSupported({ codec: c })).supported) return true;
    return false;
  });
}

export function canDecodeAudio(codec: string | undefined): Promise<boolean> {
  if (!codec) return Promise.resolve(true);
  const c = AUDIO[codec];
  if (!c || typeof AudioDecoder === 'undefined') return Promise.resolve(false);
  return once(
    `a:${codec}`,
    async () =>
      !!(await AudioDecoder.isConfigSupported({ codec: c, sampleRate: 48_000, numberOfChannels: 2 }))
        .supported,
  );
}

/** WebCodecs can decode every stream of this media (originals are used as-is). */
export async function webCodecsCanDecode(media: {
  mime: string;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio?: boolean;
}): Promise<boolean> {
  if (media.mime.startsWith('video/') && !(await canDecodeVideo(media.videoCodec))) return false;
  if (media.hasAudio !== false && !(await canDecodeAudio(media.audioCodec))) return false;
  return true;
}

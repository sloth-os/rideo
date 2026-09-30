import type { Probe } from '../schemas/common';

/**
 * Parses the stream banner that `ffmpeg -i <file>` prints (FFmpeg 4.4 native and the 5.1 wasm core).
 * The browser probes this way because ffprobe breaks the ffmpeg.wasm instance (docs/design/editor.md).
 */
export function parseProbe(log: string | readonly string[]): Probe | null {
  const lines = typeof log === 'string' ? log.split('\n') : log;
  let formatName: string | null = null;
  let durationSec = 0;
  let video: Pick<Probe, 'width' | 'height' | 'fps' | 'videoCodec'> | null = null;
  let audio: Pick<Probe, 'audioCodec' | 'sampleRate' | 'channels'> | null = null;
  let rotation: number | undefined;
  for (const raw of lines) {
    const line = raw.replace(/^(stderr|stdout|info): /, '');
    const input = /^Input #0, (.+?), from '/.exec(line);
    if (input) {
      formatName = input[1]!;
      continue;
    }
    if (formatName === null) continue;
    if (/^Input #[1-9]/.test(line) || /^Output #/.test(line)) break;
    const dur = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
    if (dur) {
      durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
      continue;
    }
    const rot = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(line);
    if (rot && rotation === undefined) {
      rotation = Number(rot[1]);
      continue;
    }
    const stream = /Stream #0:\d+.*?: (Video|Audio): ([^\s,]+)(.*)$/.exec(line);
    if (!stream) continue;
    const [, type, codec, rest = ''] = stream;
    if (type === 'Video' && !video && !/\(attached pic\)/.test(rest)) {
      const dims = /,\s(\d{2,5})x(\d{2,5})[\s,[]|,\s(\d{2,5})x(\d{2,5})$/.exec(rest);
      const fps = /,\s([\d.]+)(k?) fps/.exec(rest);
      video = {
        videoCodec: codec,
        width: dims ? Number(dims[1] ?? dims[3]) : undefined,
        height: dims ? Number(dims[2] ?? dims[4]) : undefined,
        fps: fps ? Number(fps[1]) * (fps[2] ? 1000 : 1) : undefined,
      };
    } else if (type === 'Audio' && !audio) {
      const rate = /,\s(\d+) Hz/.exec(rest);
      audio = {
        audioCodec: codec,
        sampleRate: rate ? Number(rate[1]) : undefined,
        channels: channelCount(rest),
      };
    }
  }
  if (formatName === null) return null;
  const probe: Probe = {
    formatName,
    durationSec: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) / 1000 : 0,
    hasVideo: !!video,
    hasAudio: !!audio,
  };
  if (video) {
    if (video.width && video.height) {
      const swap = rotation !== undefined && Math.abs(Math.round(rotation / 90)) % 2 === 1;
      probe.width = swap ? video.height : video.width;
      probe.height = swap ? video.width : video.height;
    }
    if (video.fps && video.fps > 0 && !isStillImage(formatName, video.videoCodec)) probe.fps = video.fps;
    probe.videoCodec = video.videoCodec;
    if (rotation !== undefined && rotation !== 0) probe.rotation = rotation;
  }
  if (audio) {
    probe.audioCodec = audio.audioCodec;
    if (audio.sampleRate) probe.sampleRate = audio.sampleRate;
    if (audio.channels) probe.channels = audio.channels;
  }
  if (isStillImage(formatName, video?.videoCodec) && !audio) probe.durationSec = 0;
  return probe;
}

const LAYOUT_CHANNELS: Record<string, number> = {
  mono: 1,
  stereo: 2,
  '2.1': 3,
  '3.0': 3,
  quad: 4,
  '4.0': 4,
  '4.1': 5,
  '5.0': 5,
  '5.1': 6,
  '6.0': 6,
  '6.1': 7,
  '7.0': 7,
  '7.1': 8,
};

function channelCount(rest: string): number | undefined {
  const n = /,\s(\d+) channels/.exec(rest);
  if (n) return Number(n[1]);
  const layout = /Hz,\s([a-z0-9.]+)(\(|,|$)/.exec(rest);
  return layout ? LAYOUT_CHANNELS[layout[1]!] : undefined;
}

const STILL_FORMATS = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|gif|tiff_pipe)(,|$)/;
const STILL_CODECS = new Set(['png', 'mjpeg', 'webp', 'bmp', 'tiff', 'gif']);

function isStillImage(formatName: string, codec?: string): boolean {
  return (
    STILL_FORMATS.test(formatName) ||
    (codec !== undefined && STILL_CODECS.has(codec) && !/mov|mp4|matroska|avi/.test(formatName))
  );
}

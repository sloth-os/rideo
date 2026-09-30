import type { Probe } from '../schemas/common';

/**
 * ffmpeg command lines shared by the browser engine (ffmpeg.wasm) and the server's reference worker
 * (native ffmpeg). Inputs and outputs are plain paths in the caller's file system.
 */

/** `-hide_banner -i <input>`: prints the stream banner that `parseProbe` reads (the command itself fails). */
export function probeCommand(input: string): string[] {
  return ['-hide_banner', '-i', input];
}

/** One JPEG poster frame, at most 640 px wide. */
export function posterCommand(input: string, output: string, probe: Pick<Probe, 'durationSec'>): string[] {
  const at = probe.durationSec > 0 ? Math.min(1, probe.durationSec / 2) : 0;
  return [
    '-ss',
    at.toFixed(3),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(640,iw)':-2",
    '-q:v',
    '4',
    '-y',
    output,
  ];
}

/** One JPEG frame at `atSec`, `width` px wide (scene thumbnails). */
export function thumbnailCommand(input: string, atSec: number, output: string, width = 320): string[] {
  return [
    '-ss',
    Math.max(0, atSec).toFixed(3),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-2`,
    '-q:v',
    '5',
    '-y',
    output,
  ];
}

/** Mono 16 kHz speech track for speech-to-text. */
export function speechCommand(input: string, output: string): string[] {
  return ['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-y', output];
}

/**
 * Local playback proxy for browsers that cannot decode the original: VP8 + Opus in WebM, at most 480 px
 * high, a keyframe every 12 frames for fast seeking. Timestamps match the original.
 */
export function localProxyCommand(input: string, output: string, probe: { hasAudio?: boolean }): string[] {
  const audio = probe.hasAudio !== false;
  return [
    '-i',
    input,
    '-map',
    '0:v:0',
    // `?`: media whose audio flag is unknown may have no audio stream
    ...(audio ? ['-map', '0:a:0?'] : []),
    '-vf',
    "scale=-2:'min(480,ih)'",
    '-c:v',
    'libvpx',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-b:v',
    '1M',
    '-g',
    '12',
    ...(audio ? ['-c:a', 'libopus', '-b:a', '64k'] : ['-an']),
    '-y',
    output,
  ];
}

export const ANALYSIS = {
  sceneThreshold: 0.3,
  blackMinSec: 0.3,
  blackPixelThreshold: 0.1,
  silenceNoiseDb: -35,
  silenceMinSec: 0.6,
  analysisWidth: 320,
  maxThumbnails: 12,
} as const;

/** One pass: scene changes (select + showinfo), black (blackdetect), silences and loudness (ebur128). */
export function analysisCommand(input: string, probe: Pick<Probe, 'hasVideo' | 'hasAudio'>): string[] {
  const a = ANALYSIS;
  const args = ['-hide_banner', '-nostats', '-i', input];
  if (probe.hasVideo) {
    args.push(
      '-vf',
      `scale=${a.analysisWidth}:-2,blackdetect=d=${a.blackMinSec}:pix_th=${a.blackPixelThreshold.toFixed(2)},select='gt(scene\\,${a.sceneThreshold})',showinfo`,
    );
  } else args.push('-vn');
  if (probe.hasAudio)
    args.push(
      '-af',
      `silencedetect=noise=${a.silenceNoiseDb}dB:d=${a.silenceMinSec},ebur128=framelog=verbose`,
    );
  else args.push('-an');
  args.push('-f', 'null', '-');
  return args;
}

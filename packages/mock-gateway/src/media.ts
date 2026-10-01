import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePng, type Rgba } from './png';
import type { Rgb } from './signature';

export const FFMPEG = process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg';

export function runFfmpeg(args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A textured, desaturated frame (so signatures stand out) with one "figure" per signature colour:
 * a head circle and a torso block, laid out left to right like people in a shot.
 */
export function synthesizeFrame(
  width: number,
  height: number,
  seed: number,
  signatures: Rgb[],
  /** The background's grey level (multi-shot segments alternate dark and light so cuts are detectable). */
  baseGray?: number,
): Rgba {
  const rand = mulberry(seed);
  const data = Buffer.alloc(width * height * 4);
  const drawn = 70 + Math.floor(rand() * 60);
  const base = baseGray ?? drawn;
  const tilt = rand() * 0.6 - 0.3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v =
        base +
        50 * Math.sin(x / 19 + (y * tilt) / 11) * Math.cos(y / 23) +
        (x / width) * 40 +
        (rand() - 0.5) * 24;
      const g = Math.max(0, Math.min(255, Math.round(v)));
      data[i] = g;
      data[i + 1] = Math.max(0, Math.min(255, g + 4));
      data[i + 2] = Math.max(0, Math.min(255, g + 10));
      data[i + 3] = 255;
    }
  }
  const n = signatures.length;
  signatures.forEach((sig, k) => {
    const cx = Math.round(((k + 1) * width) / (n + 1));
    const unit = Math.max(6, Math.round(Math.min(width / (n + 1), height) / 5));
    const headY = Math.round(height * 0.35);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inHead = (x - cx) ** 2 + (y - headY) ** 2 <= unit * unit;
        const inBody =
          Math.abs(x - cx) <= unit * 1.3 &&
          y > headY + unit * 0.9 &&
          y < Math.min(height - 1, headY + unit * 4.2);
        if (!inHead && !inBody) continue;
        const i = (y * width + x) * 4;
        const shade = inHead ? 1 : 0.85;
        data[i] = Math.round(sig[0] * shade);
        data[i + 1] = Math.round(sig[1] * shade);
        data[i + 2] = Math.round(sig[2] * shade);
      }
    }
  });
  return { width, height, data };
}

export async function synthesizeVideo(opts: {
  dir: string;
  name: string;
  width: number;
  height: number;
  durationSec: number;
  fps?: number;
  firstFrame?: Buffer;
  frame?: Rgba;
  includeAudio?: boolean;
  /** The sound of the video (reference audio of native-audio and audio-driven models), padded to its length. */
  audioPath?: string;
}): Promise<string> {
  const fps = opts.fps ?? 24;
  const width = opts.width - (opts.width % 2);
  const height = opts.height - (opts.height % 2);
  const framePath = join(opts.dir, `${opts.name}-frame.png`);
  await writeFile(framePath, opts.firstFrame ?? encodePng(opts.frame!));
  const out = join(opts.dir, `${opts.name}.mp4`);
  const frames = Math.max(1, Math.round(opts.durationSec * fps));
  const args = ['-i', framePath];
  if (opts.includeAudio && opts.audioPath) args.push('-i', opts.audioPath);
  else if (opts.includeAudio)
    args.push('-f', 'lavfi', '-i', `sine=frequency=330:duration=${opts.durationSec}:sample_rate=48000`);
  args.push(
    '-vf',
    `scale=${width}:${height},zoompan=z='min(zoom+0.0007,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},format=yuv420p`,
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
  );
  if (opts.includeAudio && opts.audioPath)
    // Exactly as long as the pictures: pad or cut the sound.
    args.push(
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-af',
      `apad=whole_dur=${frames / fps},atrim=0:${frames / fps}`,
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-t',
      String(frames / fps),
    );
  else if (opts.includeAudio) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  args.push('-movflags', '+faststart', out);
  await runFfmpeg(args);
  return out;
}

export async function synthesizeMusic(opts: {
  dir: string;
  name: string;
  durationSec: number;
  seed: number;
  format: 'mp3' | 'wav';
}): Promise<string> {
  const out = join(opts.dir, `${opts.name}.${opts.format}`);
  const root = 196 + (opts.seed % 5) * 22;
  const expr = `0.18*sin(2*PI*(${root}+${root / 2}*floor(mod(t*2,4)))*t)+0.08*sin(2*PI*${root * 1.5}*t)`;
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='${expr}':s=44100:d=${opts.durationSec}`,
    ...(opts.format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k'] : ['-c:a', 'pcm_s16le']),
    out,
  ]);
  return out;
}

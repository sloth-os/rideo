import { type ChildProcess, spawn } from 'node:child_process';
import { abortError } from '../util/abort';

export interface ProbeResult {
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  formatName: string;
  tags: Record<string, string>;
}

export class MediaError extends Error {
  readonly code = 'media_error';
  constructor(message: string) {
    super(message);
  }
}

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return undefined;
  const fps = n / d;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : undefined;
}

/** Thin, abortable wrapper around ffmpeg/ffprobe child processes. */
export class Ffmpeg {
  constructor(private readonly cfg: { ffmpegPath: string; ffprobePath: string }) {}

  spawn(args: string[], opts: { stdin?: boolean; stdout?: boolean } = {}): ChildProcess {
    return spawn(
      this.cfg.ffmpegPath,
      ['-hide_banner', '-nostdin', ...args].filter((a) => !(a === '-nostdin' && opts.stdin)),
      {
        stdio: [opts.stdin ? 'pipe' : 'ignore', opts.stdout ? 'pipe' : 'ignore', 'pipe'],
      },
    );
  }

  /** Runs ffmpeg to completion; stderr is returned (analysis filters log there). */
  run(
    args: string[],
    opts: { signal?: AbortSignal; timeoutMs?: number; logLevel?: string } = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(abortError());
      const proc = spawn(
        this.cfg.ffmpegPath,
        ['-hide_banner', '-nostdin', '-loglevel', opts.logLevel ?? 'error', '-y', ...args],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      proc.stderr!.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
      });
      const timer = setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs ?? 30 * 60_000);
      const onAbort = () => proc.kill('SIGKILL');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new MediaError(`ffmpeg failed to start: ${err.message}`));
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (opts.signal?.aborted) return reject(abortError());
        if (code === 0) resolve(stderr);
        else
          reject(
            new MediaError(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-6).join(' | ')}`),
          );
      });
    });
  }

  probe(path: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        this.cfg.ffprobePath,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '';
      let err = '';
      proc.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
      });
      proc.stderr!.on('data', (d: Buffer) => {
        err += d.toString();
      });
      proc.on('error', (e) => reject(new MediaError(`ffprobe failed to start: ${e.message}`)));
      proc.on('close', (code) => {
        if (code !== 0) return reject(new MediaError(`ffprobe failed: ${err.trim().slice(0, 500)}`));
        try {
          const json = JSON.parse(out) as {
            format?: { duration?: string; format_name?: string; tags?: Record<string, string> };
            streams?: {
              codec_type: string;
              codec_name?: string;
              width?: number;
              height?: number;
              avg_frame_rate?: string;
              r_frame_rate?: string;
              duration?: string;
              tags?: Record<string, string>;
            }[];
          };
          const v = json.streams?.find((s) => s.codec_type === 'video');
          const a = json.streams?.find((s) => s.codec_type === 'audio');
          const duration = Number.parseFloat(json.format?.duration ?? v?.duration ?? a?.duration ?? '0') || 0;
          const tags: Record<string, string> = {};
          for (const [k, val] of Object.entries(json.format?.tags ?? {})) tags[k.toLowerCase()] = val;
          const isImage = !!v && /png|mjpeg|jpeg|webp|bmp|gif/.test(v.codec_name ?? '') && duration === 0;
          resolve({
            durationSec: Math.round(duration * 1000) / 1000,
            width: v?.width,
            height: v?.height,
            fps: isImage ? undefined : (parseRate(v?.avg_frame_rate) ?? parseRate(v?.r_frame_rate)),
            hasVideo: !!v,
            hasAudio: !!a,
            videoCodec: v?.codec_name,
            audioCodec: a?.codec_name,
            formatName: json.format?.format_name ?? '',
            tags,
          });
        } catch (e) {
          reject(new MediaError(`ffprobe output unreadable: ${(e as Error).message}`));
        }
      });
    });
  }
}

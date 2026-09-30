import type { ChildProcess } from 'node:child_process';
import type { Ffmpeg } from '../media/ffmpeg';
import { MediaError } from '../media/ffmpeg';
import { abortError } from '../util/abort';

export interface FramePipelineOptions {
  ff: Ffmpeg;
  /** ffmpeg args producing raw yuv420p frames of width×height on stdout. */
  decodeArgs: string[];
  /** ffmpeg args reading raw yuv420p frames from stdin (`-f rawvideo … -i -`). */
  encodeArgs: string[];
  width: number;
  height: number;
  /** Mutates the Y plane (first width×height bytes) in place. */
  transform: (y: Uint8Array, frameIndex: number) => void;
  signal?: AbortSignal;
  onProgress?: (frames: number) => void;
}

function collectStderr(proc: ChildProcess): () => string {
  let buf = '';
  proc.stderr?.on('data', (d: Buffer) => {
    buf = (buf + d.toString()).slice(-8000);
  });
  return () => buf;
}

function exited(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    proc.on('close', (code) => resolve(code));
    proc.on('error', () => resolve(-1));
  });
}

/** decode → per-frame luma transform → encode, with backpressure on both pipes (docs/design/watermark.md#pipelines). */
export async function runFramePipeline(opts: FramePipelineOptions): Promise<{ frames: number }> {
  if (opts.width % 2 || opts.height % 2) throw new MediaError('frame dimensions must be even for yuv420p');
  const frameSize = (opts.width * opts.height * 3) / 2;
  const ySize = opts.width * opts.height;
  const decoder = opts.ff.spawn(['-loglevel', 'error', ...opts.decodeArgs], { stdout: true });
  const encoder = opts.ff.spawn(['-loglevel', 'error', '-y', ...opts.encodeArgs], { stdin: true });
  const decErr = collectStderr(decoder);
  const encErr = collectStderr(encoder);
  const kill = () => {
    decoder.kill('SIGKILL');
    encoder.kill('SIGKILL');
  };
  opts.signal?.addEventListener('abort', kill, { once: true });
  let frames = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let encoderError: Error | null = null;
  encoder.stdin!.on('error', (err) => {
    encoderError = err;
  });

  const pump = new Promise<void>((resolve, reject) => {
    decoder.stdout!.on('data', (chunk: Buffer) => {
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes >= frameSize) {
        const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
        const frame = Buffer.from(all.subarray(0, frameSize));
        const rest = all.subarray(frameSize);
        pending = rest.length ? [rest] : [];
        pendingBytes = rest.length;
        opts.transform(new Uint8Array(frame.buffer, frame.byteOffset, ySize), frames);
        frames++;
        if (frames % 24 === 0) opts.onProgress?.(frames);
        if (!encoder.stdin!.write(frame)) {
          decoder.stdout!.pause();
          encoder.stdin!.once('drain', () => decoder.stdout!.resume());
        }
      }
    });
    decoder.stdout!.on('end', () => {
      encoder.stdin!.end();
      resolve();
    });
    decoder.stdout!.on('error', reject);
  });

  try {
    await pump;
    const [dCode, eCode] = await Promise.all([exited(decoder), exited(encoder)]);
    if (opts.signal?.aborted) throw abortError();
    if (dCode !== 0)
      throw new MediaError(
        `decoder exited with ${dCode}: ${decErr().trim().split('\n').slice(-4).join(' | ')}`,
      );
    if (eCode !== 0 || encoderError)
      throw new MediaError(
        `encoder exited with ${eCode}: ${encErr().trim().split('\n').slice(-4).join(' | ')}`,
      );
    if (frames === 0) throw new MediaError('no frames decoded');
    opts.onProgress?.(frames);
    return { frames };
  } catch (err) {
    kill();
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', kill);
  }
}

/** Reads raw yuv420p frames from an ffmpeg decode and hands the Y plane of each to `onFrame`. */
export async function readLumaFrames(opts: {
  ff: Ffmpeg;
  decodeArgs: string[];
  width: number;
  height: number;
  onFrame: (y: Uint8Array) => void;
  signal?: AbortSignal;
}): Promise<number> {
  const frameSize = (opts.width * opts.height * 3) / 2;
  const ySize = opts.width * opts.height;
  const decoder = opts.ff.spawn(['-loglevel', 'error', ...opts.decodeArgs], { stdout: true });
  const errText = collectStderr(decoder);
  const kill = () => decoder.kill('SIGKILL');
  opts.signal?.addEventListener('abort', kill, { once: true });
  let frames = 0;
  let pending: Buffer = Buffer.alloc(0);
  decoder.stdout!.on('data', (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameSize) {
      opts.onFrame(new Uint8Array(pending.buffer, pending.byteOffset, ySize));
      pending = pending.subarray(frameSize);
      frames++;
    }
  });
  const code = await exited(decoder);
  opts.signal?.removeEventListener('abort', kill);
  if (opts.signal?.aborted) throw abortError();
  if (code !== 0)
    throw new MediaError(
      `decoder exited with ${code}: ${errText().trim().split('\n').slice(-4).join(' | ')}`,
    );
  return frames;
}

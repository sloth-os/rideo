import wasmURL from '@ffmpeg/core/wasm?url';
import coreURL from '@ffmpeg/core?url';
import mtWasmURL from '@ffmpeg/core-mt/wasm?url';
import mtWorkerURL from '@ffmpeg/core-mt/worker?url';
import mtCoreURL from '@ffmpeg/core-mt?url';
import { FFFSType, FFmpeg } from '@ffmpeg/ffmpeg';
import { withThreads } from './threads';

/**
 * The tab's ffmpeg.wasm instance (docs/design/editor.md#browser-media-engine): the FFmpeg 5.1 core served from our
 * origin, loaded on first use, multi-threaded when the tab is cross-origin isolated
 * (docs/design/engine-performance.md#cross-origin-isolation-and-multi-threaded-ffmpegwasm). Commands run one at a
 * time; inputs are Blobs mounted read-only with WORKERFS at /in/<name> (no copy into wasm memory); outputs are read
 * back and deleted. Aborting a command terminates the worker (the only way to stop ffmpeg.wasm) and the next
 * command reloads the core.
 */

/** Whether this tab can run the multi-threaded core: cross-origin isolated, with SharedArrayBuffer. */
export function canUseThreads(): boolean {
  return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
}

export type FfmpegStatus = 'unloaded' | 'loading' | 'ready' | 'failed';

export const FONT_PATH = '/fonts/DejaVuSans.ttf';
const FONT_URL = '/fonts/DejaVuSans.ttf';

export interface RunOptions {
  /** Read-only inputs, visible to ffmpeg at `/in/<name>`. */
  inputs?: Record<string, Blob>;
  /** Files written before the command and removed after it (e.g. drawtext text files). */
  files?: Record<string, string | Uint8Array>;
  /** Files read back after a successful command (then deleted). */
  outputs?: string[];
  /** A non-zero exit is expected (probing with `-i` only). */
  allowFailure?: boolean;
  signal?: AbortSignal;
  /** Output position in seconds while the command runs. */
  onTime?: (sec: number) => void;
}

export interface RunResult {
  code: number;
  log: string[];
  outputs: Record<string, Uint8Array>;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly log: string[],
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

const abortError = () => new DOMException('The operation was cancelled', 'AbortError');

class FfmpegRuntime {
  private ff: FFmpeg | null = null;
  private loading: Promise<FFmpeg> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(s: FfmpegStatus) => void>();
  private log: string[] = [];
  private onTime: ((sec: number) => void) | null = null;
  status: FfmpegStatus = 'unloaded';
  /** Threads commands use (1: the single-threaded core). */
  threads = 1;

  subscribe(fn: (s: FfmpegStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: FfmpegStatus): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }

  load(): Promise<FFmpeg> {
    if (this.ff) return Promise.resolve(this.ff);
    if (this.loading) return this.loading;
    this.setStatus('loading');
    this.loading = (async () => {
      const ff = new FFmpeg();
      ff.on('log', ({ message }) => {
        this.log.push(message);
      });
      ff.on('progress', ({ time }) => {
        if (time > 0) this.onTime?.(time / 1_000_000);
      });
      const multi = canUseThreads();
      await ff.load(
        multi ? { coreURL: mtCoreURL, wasmURL: mtWasmURL, workerURL: mtWorkerURL } : { coreURL, wasmURL },
      );
      this.threads = multi ? Math.max(2, Math.min(8, navigator.hardwareConcurrency || 2)) : 1;
      const font = await fetch(FONT_URL);
      if (font.ok) {
        await ff.createDir('/fonts');
        await ff.writeFile(FONT_PATH, new Uint8Array(await font.arrayBuffer()));
      }
      for (const dir of ['/in', '/out', '/text']) await ff.createDir(dir);
      this.ff = ff;
      this.setStatus('ready');
      return ff;
    })();
    this.loading.then(
      () => {
        this.loading = null;
      },
      () => {
        this.loading = null;
        this.setStatus('failed');
      },
    );
    return this.loading;
  }

  /** Runs one ffmpeg command (queued behind the running one). */
  run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const task = this.chain.then(() => this.exec(args, opts));
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async exec(args: string[], opts: RunOptions): Promise<RunResult> {
    if (opts.signal?.aborted) throw abortError();
    const ff = await this.load();
    const inputs = Object.entries(opts.inputs ?? {});
    if (inputs.length)
      await ff.mount(FFFSType.WORKERFS, { blobs: inputs.map(([name, data]) => ({ name, data })) }, '/in');
    for (const [path, data] of Object.entries(opts.files ?? {})) await ff.writeFile(path, data);
    this.log = [];
    this.onTime = opts.onTime ?? null;
    const onAbort = () => this.terminate();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const code = await ff.exec(this.threads > 1 ? withThreads(args, this.threads) : args);
      const log = this.log;
      if (code !== 0 && !opts.allowFailure)
        throw new FfmpegError(`ffmpeg exited with ${code}: ${log.slice(-4).join(' | ')}`, code, log);
      const outputs: Record<string, Uint8Array> = {};
      if (code === 0) {
        for (const path of opts.outputs ?? []) {
          outputs[path] = (await ff.readFile(path)) as Uint8Array;
          await ff.deleteFile(path).catch(() => undefined);
        }
      }
      return { code, log, outputs };
    } catch (err) {
      if (opts.signal?.aborted) throw abortError();
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      this.onTime = null;
      if (this.ff === ff) {
        for (const path of Object.keys(opts.files ?? {})) await ff.deleteFile(path).catch(() => undefined);
        if (inputs.length) await ff.unmount('/in').catch(() => undefined);
      }
    }
  }

  /** Stops the running command (the worker is terminated; the next command reloads the core). */
  terminate(): void {
    if (!this.ff) return;
    const ff = this.ff;
    this.ff = null;
    ff.terminate();
    this.setStatus('unloaded');
  }
}

export const ffmpeg = new FfmpegRuntime();

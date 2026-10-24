/**
 * Threads for the multi-threaded ffmpeg.wasm core (docs/design/engine-performance.md#cross-origin-isolation-and-multi-threaded-ffmpegwasm):
 * its pthread pool has 32 threads and a command that asks for more hangs, so every command says how many it uses.
 */

/** The core's pthread pool (`@ffmpeg/core-mt` 0.12). */
export const THREAD_POOL = 32;
/** What a command may plan to use: the pool, less a little for ffmpeg's own helpers. */
const BUDGET = THREAD_POOL - 2;

/**
 * Scalers in a filter graph: each `scale`, and the format conversions ffmpeg inserts, estimated generously from what
 * asks for one (`format`, both inputs of an `xfade`, `overlay`, `alphamerge`) plus the output's. FFmpeg 5.1 gives every
 * scaler its own pool of the graph's threads.
 */
export function scalerCount(graph: string): number {
  const n = (re: RegExp) => (graph.match(re) ?? []).length;
  return n(/\bscale=/g) + n(/\bformat=/g) + 2 * n(/\bxfade=/g) + n(/\boverlay=/g) + n(/\balphamerge\b/g) + 1;
}

export interface ThreadPlan {
  /** The encoder's threads. */
  output: number;
  /** Each input decoder's threads. */
  decoder: number;
  /** The filter graph's threads (each scaler runs as many). */
  filters: number;
  /** Each input read on a thread of its own (FFmpeg's default when a command has several), or all on the main one. */
  inputThreads: boolean;
}

/**
 * Threads for a command that fit the pool: an input thread per input (when there are several), the decoders (one
 * at a single thread decodes on the main thread), the filter graph's workers and each scaler's, the encoder with its
 * lookahead. The filter graph gives way first, then the input threads, then the decoders, then the encoder.
 */
export function threadBudget(cores: number, inputs: number, scalers = 0): ThreadPlan {
  let output = Math.max(1, Math.min(8, Math.floor(cores) || 1));
  let decoder = inputs > 6 ? 1 : 2;
  let filters = output;
  let inputThreads = inputs > 1;
  const used = () =>
    (inputThreads ? inputs : 0) +
    (decoder > 1 ? inputs * decoder : 0) +
    (filters - 1) * (1 + scalers) +
    output +
    1;
  while (filters > 1 && used() > BUDGET) filters--;
  if (used() > BUDGET) inputThreads = false;
  if (used() > BUDGET) decoder = 1;
  while (output > 1 && used() > BUDGET) output--;
  return { output, decoder, filters, inputThreads };
}

/**
 * The command with its threads: `-threads` before each `-i` (that input's decoder), with `-thread_queue_size 0` when
 * the inputs are read on the main thread, and `-threads` with `-filter_complex_threads` before the output. Probes
 * (`-i` only) and commands that set threads keep theirs.
 */
export function withThreads(args: string[], cores: number): string[] {
  if (args.includes('-threads')) return args;
  const inputs = args.filter((a) => a === '-i').length;
  if (!inputs) return args;
  const at = args.indexOf('-filter_complex');
  const { output, decoder, filters, inputThreads } = threadBudget(
    cores,
    inputs,
    at >= 0 ? scalerCount(args[at + 1] ?? '') : 0,
  );
  const reader = inputs > 1 && !inputThreads ? ['-thread_queue_size', '0'] : [];
  const out: string[] = [];
  for (const a of args) {
    if (a === '-i') out.push(...reader, '-threads', String(decoder));
    out.push(a);
  }
  // a probe has no output: its last argument is the input
  if (args[args.length - 2] !== '-i')
    out.splice(out.length - 1, 0, '-threads', String(output), '-filter_complex_threads', String(filters));
  return out;
}

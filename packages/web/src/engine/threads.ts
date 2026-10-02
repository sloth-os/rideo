/**
 * Threads for the multi-threaded ffmpeg.wasm core (docs/design/engine-performance.md#cross-origin-isolation-and-multi-threaded-ffmpegwasm):
 * its pthread pool has 32 threads and a command that asks for more hangs, so every command says how many it uses.
 */

/** The core's pthread pool (`@ffmpeg/core-mt` 0.12). */
export const THREAD_POOL = 32;

/** Threads for the encoders and filters, and for each input's decoder. */
export function threadBudget(cores: number, inputs: number): { output: number; decoder: number } {
  return { output: Math.max(1, Math.min(8, Math.floor(cores) || 1)), decoder: inputs > 6 ? 1 : 2 };
}

/**
 * The command with its threads: `-threads` before each `-i` (that input's decoder), and `-threads` with
 * `-filter_complex_threads` before the output. Probes (`-i` only) and commands that set threads keep theirs.
 */
export function withThreads(args: string[], cores: number): string[] {
  if (args.includes('-threads')) return args;
  const inputs = args.filter((a) => a === '-i').length;
  if (!inputs) return args;
  const { output, decoder } = threadBudget(cores, inputs);
  const out: string[] = [];
  for (const a of args) {
    if (a === '-i') out.push('-threads', String(decoder));
    out.push(a);
  }
  // a probe has no output: its last argument is the input
  if (args[args.length - 2] !== '-i')
    out.splice(out.length - 1, 0, '-threads', String(output), '-filter_complex_threads', String(output));
  return out;
}

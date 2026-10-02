import { z } from 'zod';

/**
 * Transcript editing (docs/design/editor.md#transcript-editing): word timings, filler words, and the source ranges a
 * selection of words removes.
 */

export const TranscriptWordSchema = z.object({
  text: z.string().min(1).max(200),
  /** Source seconds. */
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

/** Words spread over a segment by their length, when the speech-to-text provider gave none. */
export function spreadWords(seg: { start: number; end: number; text: string }): TranscriptWord[] {
  const parts = seg.text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, w) => n + w.length + 1, 0);
  const span = Math.max(0, seg.end - seg.start);
  let at = seg.start;
  return parts.map((text) => {
    const d = total ? (span * (text.length + 1)) / total : 0;
    const w = { text, start: round(at), end: round(at + d) };
    at += d;
    return w;
  });
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
const PUNCT = /[,.;:!?…—–-]$/;

/** Hesitations that are never words of the sentence. */
export const FILLER_WORDS = ['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'hmm', 'hm', 'mm'];
/** Phrases that are fillers when they stand alone between pauses or punctuation. */
export const FILLER_PHRASES = [
  ['you', 'know'],
  ['i', 'mean'],
];
const PAUSE = 0.25;

export interface Filler {
  text: string;
  start: number;
  end: number;
}

/** The filler words of a transcript, in time order. */
export function fillerWords(words: readonly TranscriptWord[]): Filler[] {
  const out: Filler[] = [];
  const alone = (i: number, j: number) => {
    const before = words[i - 1];
    const after = words[j + 1];
    const openBefore = !before || PUNCT.test(before.text) || words[i]!.start - before.end >= PAUSE;
    const openAfter = !after || PUNCT.test(words[j]!.text) || after.start - words[j]!.end >= PAUSE;
    return openBefore && openAfter;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (FILLER_WORDS.includes(norm(w.text))) {
      out.push({ text: w.text.replace(/[,.;:!?…]+$/, ''), start: w.start, end: w.end });
      continue;
    }
    for (const phrase of FILLER_PHRASES) {
      const j = i + phrase.length - 1;
      if (j >= words.length) continue;
      if (!phrase.every((p, k) => norm(words[i + k]!.text) === p)) continue;
      if (!alone(i, j)) continue;
      out.push({
        text: words
          .slice(i, j + 1)
          .map((x) => x.text)
          .join(' ')
          .replace(/[,.;:!?…]+$/, ''),
        start: w.start,
        end: words[j]!.end,
      });
      i = j;
      break;
    }
  }
  return out;
}

/** Ranges to cut, padded and merged (sorted, non-overlapping). */
export function cutRanges(
  ranges: readonly { start: number; end: number }[],
  opts: { pad?: number; merge?: number } = {},
): [number, number][] {
  const pad = opts.pad ?? 0.03;
  const merge = opts.merge ?? 0.15;
  const sorted = ranges
    .map((r) => [Math.max(0, r.start - pad), r.end + pad] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] - last[1] <= merge) last[1] = Math.max(last[1], r[1]);
    else out.push([round(r[0]), round(r[1])]);
  }
  return out.map(([a, b]) => [round(a), round(b)]);
}

/**
 * Attaches a provider's word timings to its segments, taking each word's spelling from the segment's text so the
 * punctuation that marks a standalone filler survives; segments without words get spread ones, flagged `approx`.
 */
export function attachWords<S extends { start: number; end: number; text: string }>(
  segments: readonly S[],
  words: readonly { word: string; start: number; end: number }[] | null | undefined,
): (S & { words: TranscriptWord[]; approx?: boolean })[] {
  let next = 0;
  return segments.map((seg) => {
    const mine: { word: string; start: number; end: number }[] = [];
    while (next < (words?.length ?? 0) && words![next]!.start < seg.end + 0.05) {
      if (words![next]!.end > seg.start - 0.05) mine.push(words![next]!);
      next++;
    }
    if (!mine.length) return { ...seg, words: spreadWords(seg), approx: true };
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    let k = 0;
    return {
      ...seg,
      words: mine.map((w) => {
        const j = tokens.findIndex((tok, idx) => idx >= k && norm(tok) === norm(w.word));
        if (j >= 0) k = j + 1;
        return {
          text: (j >= 0 ? tokens[j]! : w.word).slice(0, 200),
          start: round(w.start),
          end: round(Math.max(w.start, w.end)),
        };
      }),
    };
  });
}

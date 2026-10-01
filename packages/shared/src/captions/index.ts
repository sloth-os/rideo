import type { CaptionWord, TextItem, Timeline } from '../schemas/timeline';

/**
 * Captions and subtitles (docs/design/localization.md#captions-and-word-timing): word timings, what an animated
 * caption shows when, and SRT/WebVTT files.
 */

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The words of a text: runs of non-space characters with their character ranges. */
export function splitWords(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ from: m.index, to: m.index + m[0].length });
  return out;
}

/**
 * The words of a line inside a caption: `offset` is where the line starts in the caption text, `start`/`end` the
 * line's time relative to the caption. Aligned word times are used when the speech gave one per word; otherwise
 * the words share the line's time in proportion to their length.
 */
export function captionWords(
  caption: string,
  offset: number,
  timing: { start: number; end: number; words?: { text: string; start: number; end: number }[] },
): CaptionWord[] {
  const words = splitWords(caption.slice(offset)).map((w) => ({ from: w.from + offset, to: w.to + offset }));
  if (!words.length) return [];
  const aligned = timing.words;
  if (aligned && aligned.length === words.length)
    return words.map((w, k) => ({
      ...w,
      start: r3(Math.max(0, aligned[k]!.start)),
      end: r3(Math.max(aligned[k]!.start, aligned[k]!.end)),
    }));
  const span = Math.max(0.05, timing.end - timing.start);
  const total = words.reduce((n, w) => n + (w.to - w.from), 0);
  let at = timing.start;
  return words.map((w) => {
    const d = (span * (w.to - w.from)) / total;
    const out = { ...w, start: r3(at), end: r3(at + d) };
    at += d;
    return out;
  });
}

export interface TextFrame {
  /** Seconds relative to the item. */
  start: number;
  end: number;
  text: string;
}

/**
 * What a text item shows over its life: the whole text, or for an animated caption one frame per word (`build`:
 * the text up to the word, `pop`: the word alone). Before the first word an animated caption shows nothing.
 */
export function textFrames(item: Pick<TextItem, 'text' | 'duration' | 'style' | 'words'>): TextFrame[] {
  const animate = item.style.animate ?? 'none';
  const words = item.words?.filter((w) => w.to <= item.text.length && w.from < w.to) ?? [];
  if (animate === 'none' || !words.length) return [{ start: 0, end: item.duration, text: item.text }];
  const frames: TextFrame[] = [];
  words.forEach((w, k) => {
    const start = Math.min(w.start, item.duration);
    const end = Math.min(item.duration, k + 1 < words.length ? words[k + 1]!.start : item.duration);
    if (end - start < 1e-3) return;
    const text = animate === 'build' ? item.text.slice(0, w.to) : item.text.slice(w.from, w.to);
    frames.push({ start: r3(start), end: r3(end), text });
  });
  return frames;
}

/** The text shown `local` seconds into the item, or null when an animated caption shows nothing yet. */
export function textAt(
  item: Pick<TextItem, 'text' | 'duration' | 'style' | 'words'>,
  local: number,
): string | null {
  for (const f of textFrames(item)) if (local >= f.start && local < f.end) return f.text;
  return null;
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
  /** Word times (absolute seconds) for WebVTT cue timestamps. */
  words?: { text: string; start: number }[];
}

/** The cut's captions in time order (preset `caption`). */
export function subtitleCues(t: Timeline): SubtitleCue[] {
  return t.tracks
    .filter((tr) => tr.kind === 'text')
    .flatMap((tr) => tr.items as TextItem[])
    .filter((i) => i.style.preset === 'caption')
    .sort((a, b) => a.start - b.start)
    .map((i) => ({
      start: r3(i.start),
      end: r3(i.start + i.duration),
      text: i.text,
      ...(i.words?.length
        ? { words: i.words.map((w) => ({ text: i.text.slice(w.from, w.to), start: r3(i.start + w.start) })) }
        : {}),
    }));
}

function clock(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** SubRip: numbered cues, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, the text. */
export function toSrt(cues: readonly SubtitleCue[]): string {
  return cues
    .map(
      (c, k) =>
        `${k + 1}\n${clock(c.start, ',')} --> ${clock(c.end, ',')}\n${c.text.replace(/\r?\n/g, ' ')}\n`,
    )
    .join('\n');
}

const escapeVtt = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** WebVTT, with each word's start as a cue timestamp when the words are timed (karaoke highlighting). */
export function toVtt(cues: readonly SubtitleCue[]): string {
  const body = cues.map((c) => {
    let text = escapeVtt(c.text.replace(/\r?\n/g, ' '));
    if (c.words?.length) {
      // `Speaker: <t1>word <t2>word`: a timestamp before every word after the cue start.
      const first = c.text.indexOf(c.words[0]!.text);
      const head = escapeVtt(c.text.slice(0, Math.max(0, first)));
      text =
        head +
        c.words
          .map(
            (w, k) =>
              (k === 0 && w.start <= c.start + 1e-3 ? '' : `<${clock(w.start, '.')}>`) + escapeVtt(w.text),
          )
          .join(' ');
    }
    return `${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${text}\n`;
  });
  return `WEBVTT\n\n${body.join('\n')}`;
}

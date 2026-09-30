import { newId } from '../ids';
import type { EditSuggestion, SuggestionParams } from '../schemas/analysis';
import type { MediaRef, TimeRange } from '../schemas/common';
import type { AudioItem, Effects, TextItem, Timeline, VideoItem } from '../schemas/timeline';
import { emptyTimeline, itemEnd, layoutPrimary, type OpContext, primaryTrack } from './ops';

const MIN_SEGMENT = 0.25;

export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function subtractRanges(base: TimeRange[], remove: TimeRange[]): TimeRange[] {
  let result = mergeRanges(base);
  for (const cut of mergeRanges(remove)) {
    const next: TimeRange[] = [];
    for (const r of result) {
      if (cut.end <= r.start || cut.start >= r.end) {
        next.push(r);
        continue;
      }
      if (cut.start > r.start) next.push({ start: r.start, end: cut.start });
      if (cut.end < r.end) next.push({ start: cut.end, end: r.end });
    }
    result = next;
  }
  return result;
}

type P<K extends SuggestionParams['kind']> = Extract<SuggestionParams, { kind: K }>;

function paramsOf<K extends SuggestionParams['kind']>(s: EditSuggestion[], kind: K): P<K>[] {
  return s.filter((x) => x.params.kind === kind).map((x) => x.params as P<K>);
}

export interface ApplySuggestionsInput {
  source: { media: MediaRef; resourceId?: string };
  durationSec: number;
  suggestions: EditSuggestion[];
  fps: number;
  width: number;
  height: number;
  music?: Record<string, MediaRef>;
}

/** Kept source ranges after cuts, silence tightening and highlights (before speed changes). */
export function keptRanges(durationSec: number, suggestions: EditSuggestion[]): TimeRange[] {
  const highlights = paramsOf(suggestions, 'highlight').flatMap((h) => h.segments);
  let keep = highlights.length
    ? mergeRanges(highlights.map((r) => clampRange(r, durationSec)))
    : [{ start: 0, end: durationSec }];
  const removals: TimeRange[] = [];
  for (const c of paramsOf(suggestions, 'cut')) removals.push(clampRange(c, durationSec));
  for (const s of paramsOf(suggestions, 'tighten_silence')) {
    const keepSec = s.keepSec ?? 0.4;
    if (s.end - s.start > keepSec + 0.05) {
      removals.push({ start: s.start + keepSec / 2, end: s.end - keepSec / 2 });
    }
  }
  keep = subtractRanges(keep, removals).filter((r) => r.end - r.start >= MIN_SEGMENT);
  return keep;
}

function clampRange(r: TimeRange, dur: number): TimeRange {
  return { start: Math.max(0, Math.min(r.start, dur)), end: Math.max(0, Math.min(r.end, dur)) };
}

/** Accepted suggestions over one source video → a complete timeline (the "auto edit"). */
export function applySuggestions(input: ApplySuggestionsInput, ctx: OpContext = {}): Timeline {
  const gen = ctx.newId ?? ((k) => newId(k));
  const accepted = input.suggestions.filter((s) => s.status === 'accepted');
  const timeline = emptyTimeline({ fps: input.fps, width: input.width, height: input.height });
  const video = primaryTrack(timeline);
  const kept = keptRanges(input.durationSec, accepted);

  // Split kept ranges by speed ranges.
  const speeds = paramsOf(accepted, 'speed');
  const pieces: { start: number; end: number; speed: number }[] = [];
  for (const r of kept) {
    const bounds = new Set<number>([r.start, r.end]);
    for (const sp of speeds) {
      if (sp.start > r.start && sp.start < r.end) bounds.add(sp.start);
      if (sp.end > r.start && sp.end < r.end) bounds.add(sp.end);
    }
    const sorted = [...bounds].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const start = sorted[i]!;
      const end = sorted[i + 1]!;
      if (end - start < 0.05) continue;
      const mid = (start + end) / 2;
      const sp = speeds.find((s) => mid >= s.start && mid < s.end);
      pieces.push({ start, end, speed: sp?.factor ?? 1 });
    }
  }

  const color = paramsOf(accepted, 'color')[0];
  const effects: Effects | undefined = color
    ? { brightness: color.brightness, contrast: color.contrast, saturation: color.saturation }
    : undefined;
  for (const piece of pieces) {
    const item: VideoItem = {
      id: gen('item'),
      kind: 'video',
      source: { type: 'media', media: input.source.media, resourceId: input.source.resourceId },
      start: 0,
      in: round3(piece.start),
      out: round3(piece.end),
      speed: piece.speed,
      volume: 1,
      transitionIn: null,
      ...(effects ? { effects } : {}),
    };
    video.items.push(item);
  }
  const items = video.items as VideoItem[];

  // Transitions: attach to the boundary nearest the suggested source time.
  for (const tr of paramsOf(accepted, 'transition')) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 1; i < items.length; i++) {
      const dist = Math.min(Math.abs(items[i]!.in - tr.at), Math.abs(items[i - 1]!.out - tr.at));
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best > 0 && bestDist <= 1.5) {
      const a = items[best - 1]!;
      const b = items[best]!;
      const max = Math.min((a.out - a.in) / a.speed, (b.out - b.in) / b.speed) / 2;
      const d = Math.min(tr.duration, max);
      if (d >= 0.1) b.transitionIn = { type: tr.type, duration: round3(d) };
    }
  }
  const fade = paramsOf(accepted, 'fade')[0];
  if (fade && items.length) {
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (fade.in) first.fadeIn = Math.min(fade.in, (first.out - first.in) / first.speed / 2);
    if (fade.out) last.fadeOut = Math.min(fade.out, (last.out - last.in) / last.speed / 2);
  }
  layoutPrimary(video);
  const total = items.length ? itemEnd(items[items.length - 1]!) : 0;

  const map = (t: number): number | null => mapSourceToOutput(items, t);
  const textTrack = timeline.tracks.find((t) => t.kind === 'text')!;
  for (const title of paramsOf(accepted, 'title')) {
    const start = map(title.start) ?? 0;
    const item: TextItem = {
      id: gen('item'),
      kind: 'text',
      start: round3(Math.min(start, Math.max(0, total - 0.5))),
      duration: Math.max(0.5, Math.min(title.duration, Math.max(0.5, total - start))),
      text: title.text,
      style: { preset: 'title', position: 'center' },
    };
    textTrack.items.push(item);
  }
  for (const cap of paramsOf(accepted, 'caption')) {
    const start = map(cap.start);
    const end = map(Math.max(cap.start, cap.end - 1e-3));
    if (start === null || end === null || end - start < 0.2) continue;
    textTrack.items.push({
      id: gen('item'),
      kind: 'text',
      start: round3(start),
      duration: round3(end - start),
      text: cap.text,
      style: { preset: 'caption', position: 'bottom' },
    });
  }
  textTrack.items.sort((a, b) => a.start - b.start);

  const music = paramsOf(accepted, 'music').find((m) => m.resourceId && input.music?.[m.resourceId]);
  if (music && total > 0) {
    const media = input.music![music.resourceId!]!;
    const len = media.durationSec ?? total;
    const audioTrack = timeline.tracks.find((t) => t.kind === 'audio')!;
    let cursor = 0;
    while (cursor < total - 0.05 && len > 0.5) {
      const piece = Math.min(len, total - cursor);
      const item: AudioItem = {
        id: gen('item'),
        kind: 'audio',
        source: { type: 'media', media, resourceId: music.resourceId },
        start: round3(cursor),
        in: 0,
        out: round3(piece),
        volume: music.volume ?? 0.3,
      };
      audioTrack.items.push(item);
      cursor += piece;
    }
    // Duck the source audio under music.
    for (const it of items) it.volume = Math.min(it.volume, 0.9);
  }
  return timeline;
}

/** Maps a source time to output time using the kept items; removed times snap forward, null past the end. */
export function mapSourceToOutput(items: VideoItem[], t: number): number | null {
  for (const it of items) {
    if (t < it.in) return it.start;
    if (t >= it.in && t < it.out) return it.start + (t - it.in) / it.speed;
  }
  return null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

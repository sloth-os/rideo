import type { Clip } from '../schemas/clip';
import type { MediaRef } from '../schemas/common';
import type { AudioItem, Timeline, VideoItem } from '../schemas/timeline';
import { itemDuration, itemEnd, primaryTrack } from '../timeline/ops';

/** A cue of the score: the span of one scene of the cut (docs/design/post-audio.md#score-one-cue-per-scene). */
export interface ScoreCue {
  index: number;
  sceneId: string | null;
  start: number;
  end: number;
}

/** Crossfade between consecutive cues, seconds. */
export const CUE_OVERLAP_SEC = 2;
export const SCORE_VOLUME = 0.5;

/**
 * The cues of a cut: consecutive primary items grouped by their take's scene; items that are not takes join the
 * cue before them; a cue shorter than `minSec` joins its neighbour. A cut without scenes is one cue.
 */
export function scoreCues(
  t: Timeline,
  clips: Record<string, Pick<Clip, 'sceneId'>>,
  opts: { minSec: number },
): ScoreCue[] {
  const items = primaryTrack(t).items as VideoItem[];
  const cues: ScoreCue[] = [];
  for (const item of items) {
    const scene = item.source.type === 'take' ? (clips[item.source.clipId]?.sceneId ?? null) : undefined;
    const last = cues[cues.length - 1];
    if (last && (scene === undefined || scene === last.sceneId)) last.end = itemEnd(item);
    else cues.push({ index: cues.length, sceneId: scene ?? null, start: item.start, end: itemEnd(item) });
  }
  // Short cues join the cue before them (the first joins the next).
  for (let k = 0; k < cues.length && cues.length > 1; ) {
    const cue = cues[k]!;
    if (cue.end - cue.start >= opts.minSec) {
      k++;
      continue;
    }
    if (k === 0) {
      cues[1]!.start = cue.start;
      cues.splice(0, 1);
    } else {
      cues[k - 1]!.end = Math.max(cues[k - 1]!.end, cue.end);
      cues.splice(k, 1);
    }
  }
  return cues.map((c, index) => ({ ...c, index }));
}

/** The length to generate for a cue: up to the next cue plus the crossfade. */
export function cueLength(cues: readonly ScoreCue[], k: number): number {
  const cue = cues[k]!;
  const next = cues[k + 1];
  return (next ? next.start : cue.end) - cue.start + (next ? CUE_OVERLAP_SEC : 0);
}

/**
 * The Music track's items for the cues: each cue from its scene's start, crossfading into the next; a cue longer
 * than its music repeats it like a bed.
 */
export function scoreItems(
  cues: readonly ScoreCue[],
  music: readonly { media: MediaRef; resourceId: string }[],
  newId: () => string,
): AudioItem[] {
  const out: AudioItem[] = [];
  cues.forEach((cue, k) => {
    const m = music[k];
    if (!m) return;
    const total = cueLength(cues, k);
    const len = m.media.durationSec ?? total;
    if (len < 0.5) return;
    const pieces: AudioItem[] = [];
    let cursor = 0;
    while (cursor < total - 0.05) {
      const piece = Math.min(len, total - cursor);
      pieces.push({
        id: newId(),
        kind: 'audio',
        source: { type: 'media', media: m.media, resourceId: m.resourceId },
        start: round3(cue.start + cursor),
        in: 0,
        out: round3(piece),
        volume: SCORE_VOLUME,
        label: `Cue ${k + 1}`,
      });
      cursor += piece;
    }
    const first = pieces[0]!;
    const last = pieces[pieces.length - 1]!;
    const prevOverlap = k > 0 ? Math.max(0, cues[k - 1]!.start + cueLength(cues, k - 1) - cue.start) : 0;
    first.fadeIn = round3(Math.min(k === 0 ? 2 : Math.max(0.5, prevOverlap), itemDuration(first) / 3));
    last.fadeOut = round3(Math.min(k === cues.length - 1 ? 3 : CUE_OVERLAP_SEC, itemDuration(last) / 3));
    out.push(...pieces);
  });
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

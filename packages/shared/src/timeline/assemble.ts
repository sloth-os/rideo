import { newId } from '../ids';
import type { Character } from '../schemas/character';
import type { Clip, Shot, TakeAudio } from '../schemas/clip';
import type { MediaRef } from '../schemas/common';
import type { AudioItem, Source, TextItem, Timeline, Transition, VideoItem } from '../schemas/timeline';
import {
  DEFAULT_TRACK_IDS,
  emptyTimeline,
  itemDuration,
  itemEnd,
  layoutPrimary,
  type OpContext,
  primaryTrack,
} from './ops';

export interface AssembleInput {
  clips: Clip[];
  fps: number;
  width: number;
  height: number;
  characters?: Record<string, Character>;
  music?: { media: MediaRef; resourceId?: string; volume?: number };
  captions?: boolean;
  /** Only approved clips by default (the production gate); drafts can include review clips. */
  includeUnapproved?: boolean;
}

/** The track that holds the TTS dialogue of the takes (docs/design/dialogue.md#timeline). */
export const DIALOGUE_TRACK_ID = 'trk_dialoguetrack01';

/** One picture of an assembled film: a take or a still, with its dialogue. */
interface Segment {
  source: Source;
  durationSec: number;
  label: string;
  transitionIn: Transition | null;
  audio: TakeAudio | null;
  shot: Pick<Shot, 'dialogue'>;
}

/**
 * Lays segments on the primary track and adds the dialogue track, the music bed and captions; shared by the cut
 * and the animatic so both play their dialogue the same way.
 */
function assembleSegments(
  segments: Segment[],
  input: Omit<AssembleInput, 'clips' | 'includeUnapproved'>,
  ctx: OpContext,
): Timeline {
  const gen = ctx.newId ?? ((k) => newId(k));
  const timeline = emptyTimeline({ fps: input.fps, width: input.width, height: input.height });
  const video = primaryTrack(timeline);
  const speaker = (id: string | null) => (id ? (input.characters?.[id]?.name ?? '') : '');
  const captionSpans: {
    itemId: string;
    lines: { speaker: string; line: string; start?: number; end?: number }[];
  }[] = [];
  const dialogueSpans: { itemId: string; media: MediaRef }[] = [];
  for (const seg of segments) {
    const item: VideoItem = {
      id: gen('item'),
      kind: 'video',
      source: seg.source,
      start: 0,
      in: 0,
      out: Math.max(0.1, seg.durationSec),
      speed: 1,
      // A segment with a TTS mix is heard through the Dialogue track; its own sound would double the voices.
      volume: seg.audio?.dialogue ? 0 : 1,
      transitionIn: video.items.length > 0 ? seg.transitionIn : null,
      label: seg.label,
    };
    video.items.push(item);
    if (seg.audio?.dialogue) dialogueSpans.push({ itemId: item.id, media: seg.audio.dialogue });
    if (input.captions && seg.audio?.lines.length) {
      // Real line timings from the speech.
      captionSpans.push({
        itemId: item.id,
        lines: seg.audio.lines.map((l) => ({
          speaker: speaker(l.characterId),
          line: l.text,
          start: l.start,
          end: l.end,
        })),
      });
    } else if (input.captions && seg.shot.dialogue.length > 0) {
      captionSpans.push({
        itemId: item.id,
        lines: seg.shot.dialogue.map((d) => ({ speaker: speaker(d.characterId), line: d.line })),
      });
    }
  }
  const items = video.items as VideoItem[];
  // Never crossfade into an item shorter than twice the transition.
  items.forEach((it, i) => {
    if (i === 0 || !it.transitionIn) return;
    const prev = items[i - 1]!;
    const max = Math.min(prev.out - prev.in, it.out - it.in) / 2;
    if (it.transitionIn.duration > max)
      it.transitionIn = max >= 0.1 ? { type: 'crossfade', duration: max } : null;
  });
  if (items.length > 0) {
    const first = items[0]!;
    const last = items[items.length - 1]!;
    first.fadeIn = Math.min(1, (first.out - first.in) / 3);
    last.fadeOut = Math.min(1.5, (last.out - last.in) / 3);
  }
  layoutPrimary(video);
  const total = items.length ? itemEnd(items[items.length - 1]!) : 0;

  if (dialogueSpans.length) {
    const dialogue: AudioItem[] = [];
    for (const span of dialogueSpans) {
      const item = items.find((it) => it.id === span.itemId)!;
      const len = Math.min(span.media.durationSec ?? itemDuration(item), itemDuration(item));
      if (len < 0.1) continue;
      dialogue.push({
        id: gen('item'),
        kind: 'audio',
        source: { type: 'media', media: span.media },
        start: item.start,
        in: 0,
        out: len,
        volume: 1,
      });
    }
    // After the music bed, so lookups of "the audio track" keep finding the music.
    const at = timeline.tracks.findIndex((t) => t.kind === 'text');
    timeline.tracks.splice(at < 0 ? timeline.tracks.length : at, 0, {
      id: DIALOGUE_TRACK_ID,
      kind: 'audio',
      name: 'Dialogue',
      items: dialogue,
    });
  }

  if (input.music && total > 0) {
    const music = timeline.tracks.find((t) => t.id === DEFAULT_TRACK_IDS.audio)!;
    const len = input.music.media.durationSec ?? total;
    let cursor = 0;
    const musicItems: AudioItem[] = [];
    while (cursor < total - 0.05 && len > 0.5) {
      const piece = Math.min(len, total - cursor);
      musicItems.push({
        id: gen('item'),
        kind: 'audio',
        source: { type: 'media', media: input.music.media, resourceId: input.music.resourceId },
        start: cursor,
        in: 0,
        out: piece,
        volume: input.music.volume ?? 0.35,
      });
      cursor += piece;
    }
    if (musicItems.length) {
      musicItems[0]!.fadeIn = Math.min(2, (musicItems[0]!.out - musicItems[0]!.in) / 3);
      const lastM = musicItems[musicItems.length - 1]!;
      lastM.fadeOut = Math.min(3, (lastM.out - lastM.in) / 3);
    }
    music.items.push(...musicItems);
  }

  if (input.captions) {
    const textTrack = timeline.tracks.find((t) => t.kind === 'text')!;
    for (const span of captionSpans) {
      const item = items.find((it) => it.id === span.itemId);
      if (!item) continue;
      const start = item.start;
      const dur = itemEnd(item) - start;
      const each = dur / span.lines.length;
      span.lines.forEach((l, k) => {
        const timed = l.start !== undefined && l.end !== undefined && l.start < dur;
        const text: TextItem = {
          id: gen('item'),
          kind: 'text',
          start: timed ? start + l.start! : start + k * each,
          duration: timed ? Math.max(0.8, Math.min(l.end!, dur) - l.start!) : Math.max(0.5, each - 0.1),
          text: (l.speaker ? `${l.speaker}: ${l.line}` : l.line).slice(0, 500),
          style: { preset: 'caption', position: 'bottom' },
        };
        textTrack.items.push(text);
      });
    }
  }
  return timeline;
}

/**
 * Builds the story timeline: selected takes in clip/shot order, scene crossfades, the dialogue track, music bed,
 * captions.
 */
export function assembleStoryTimeline(input: AssembleInput, ctx: OpContext = {}): Timeline {
  const clips = [...input.clips]
    .filter((c) => input.includeUnapproved || c.status === 'approved')
    .sort((a, b) => a.index - b.index);
  const segments: Segment[] = [];
  clips.forEach((clip, ci) => {
    let firstInClip = true;
    for (const shot of [...clip.shots].sort((a, b) => a.index - b.index)) {
      const take = shot.takes.find((t) => t.id === shot.selectedTakeId);
      if (!take?.video) continue;
      segments.push({
        source: { type: 'take', clipId: clip.id, shotId: shot.id, takeId: take.id, media: take.video },
        durationSec: take.video.durationSec ?? take.durationSec ?? shot.durationSec,
        label: `C${clip.index + 1}·S${shot.index + 1}`,
        transitionIn: ci > 0 && firstInClip ? { type: 'crossfade', duration: 0.5 } : null,
        audio: take.audio ?? null,
        shot,
      });
      firstInClip = false;
    }
  });
  return assembleSegments(segments, input, ctx);
}

/**
 * The animatic (docs/design/storyboard.md#animatic): every board frame as a still for its shot's length (or its
 * dialogue's, when longer), hard cuts, the boards' TTS dialogue, temp music and captions.
 */
export function assembleAnimatic(input: AssembleInput, ctx: OpContext = {}): Timeline {
  const segments: Segment[] = [];
  for (const clip of [...input.clips].sort((a, b) => a.index - b.index)) {
    for (const shot of [...clip.shots].sort((a, b) => a.index - b.index)) {
      const board = shot.board;
      if (!board) continue;
      segments.push({
        source: { type: 'media', media: board.keyframe },
        durationSec: Math.max(shot.durationSec, board.audio?.dialogue?.durationSec ?? 0),
        label: `C${clip.index + 1}·S${shot.index + 1}`,
        transitionIn: null,
        audio: board.audio ?? null,
        shot,
      });
    }
  }
  return assembleSegments(segments, input, ctx);
}

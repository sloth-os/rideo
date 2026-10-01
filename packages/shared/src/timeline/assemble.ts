import { newId } from '../ids';
import type { Character } from '../schemas/character';
import type { Clip } from '../schemas/clip';
import type { MediaRef } from '../schemas/common';
import type { AudioItem, TextItem, Timeline, VideoItem } from '../schemas/timeline';
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

/**
 * Builds the story timeline: selected takes in clip/shot order, scene crossfades, the dialogue track, music bed,
 * captions.
 */
export function assembleStoryTimeline(input: AssembleInput, ctx: OpContext = {}): Timeline {
  const gen = ctx.newId ?? ((k) => newId(k));
  const timeline = emptyTimeline({ fps: input.fps, width: input.width, height: input.height });
  const video = primaryTrack(timeline);
  const clips = [...input.clips]
    .filter((c) => input.includeUnapproved || c.status === 'approved')
    .sort((a, b) => a.index - b.index);

  const speaker = (id: string | null) => (id ? (input.characters?.[id]?.name ?? '') : '');
  const captionSpans: {
    itemId: string;
    lines: { speaker: string; line: string; start?: number; end?: number }[];
  }[] = [];
  const dialogueSpans: { itemId: string; media: MediaRef }[] = [];
  clips.forEach((clip, ci) => {
    const shots = [...clip.shots].sort((a, b) => a.index - b.index);
    let firstInClip = true;
    for (const shot of shots) {
      const take = shot.takes.find((t) => t.id === shot.selectedTakeId);
      if (!take?.video) continue;
      const dur = take.video.durationSec ?? take.durationSec ?? shot.durationSec;
      const item: VideoItem = {
        id: gen('item'),
        kind: 'video',
        source: { type: 'take', clipId: clip.id, shotId: shot.id, takeId: take.id, media: take.video },
        start: 0,
        in: 0,
        out: Math.max(0.1, dur),
        speed: 1,
        // A take with a TTS mix is heard through the Dialogue track; its own sound would double the voices.
        volume: take.audio?.dialogue ? 0 : 1,
        transitionIn:
          ci > 0 && firstInClip && video.items.length > 0 ? { type: 'crossfade', duration: 0.5 } : null,
        label: `C${clip.index + 1}·S${shot.index + 1}`,
      };
      video.items.push(item);
      firstInClip = false;
      if (take.audio?.dialogue) dialogueSpans.push({ itemId: item.id, media: take.audio.dialogue });
      if (input.captions && take.audio?.lines.length) {
        // Real line timings from the take's speech.
        captionSpans.push({
          itemId: item.id,
          lines: take.audio.lines.map((l) => ({
            speaker: speaker(l.characterId),
            line: l.text,
            start: l.start,
            end: l.end,
          })),
        });
      } else if (input.captions && shot.dialogue.length > 0) {
        captionSpans.push({
          itemId: item.id,
          lines: shot.dialogue.map((d) => ({ speaker: speaker(d.characterId), line: d.line })),
        });
      }
    }
  });
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

import { newId } from '../ids';
import type { Character } from '../schemas/character';
import type { Clip } from '../schemas/clip';
import type { MediaRef } from '../schemas/common';
import type { AudioItem, TextItem, Timeline, VideoItem } from '../schemas/timeline';
import { emptyTimeline, itemEnd, layoutPrimary, type OpContext, primaryTrack } from './ops';

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

/** Builds the story timeline: selected takes in clip/shot order, scene crossfades, music bed, captions. */
export function assembleStoryTimeline(input: AssembleInput, ctx: OpContext = {}): Timeline {
  const gen = ctx.newId ?? ((k) => newId(k));
  const timeline = emptyTimeline(
    { fps: input.fps, width: input.width, height: input.height },
    { newId: gen },
  );
  const video = primaryTrack(timeline);
  const clips = [...input.clips]
    .filter((c) => input.includeUnapproved || c.status === 'approved')
    .sort((a, b) => a.index - b.index);

  const captionSpans: { itemId: string; lines: { speaker: string; line: string }[] }[] = [];
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
        volume: 1,
        transitionIn:
          ci > 0 && firstInClip && video.items.length > 0 ? { type: 'crossfade', duration: 0.5 } : null,
        label: `C${clip.index + 1}·S${shot.index + 1}`,
      };
      video.items.push(item);
      firstInClip = false;
      if (input.captions && shot.dialogue.length > 0) {
        captionSpans.push({
          itemId: item.id,
          lines: shot.dialogue.map((d) => ({
            speaker: d.characterId ? (input.characters?.[d.characterId]?.name ?? '') : '',
            line: d.line,
          })),
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

  if (input.music && total > 0) {
    const music = timeline.tracks.find((t) => t.kind === 'audio')!;
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
        const text: TextItem = {
          id: gen('item'),
          kind: 'text',
          start: start + k * each,
          duration: Math.max(0.5, each - 0.1),
          text: (l.speaker ? `${l.speaker}: ${l.line}` : l.line).slice(0, 500),
          style: { preset: 'caption', position: 'bottom' },
        };
        textTrack.items.push(text);
      });
    }
  }
  return timeline;
}

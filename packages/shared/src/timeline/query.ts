import type { z } from 'zod';
import { textAt } from '../captions';
import type { MediaRef } from '../schemas/common';
import type {
  AudioItem,
  AudioRole,
  Effects,
  FocusPoint,
  SpeechSpans,
  TextItem,
  Timeline,
  Track,
  TransitionSchema,
  VideoItem,
} from '../schemas/timeline';
import { isIdentity, opacityAt, type TransformState, transformAt } from './keyframes';
import { isOverlayTrack, itemDuration, itemEnd, primaryTrack, sourceAtItemTime, trackRole } from './ops';

type Transition = z.infer<typeof TransitionSchema>;

export function timelineDuration(t: Timeline): number {
  let end = 0;
  for (const track of t.tracks) for (const item of track.items) end = Math.max(end, itemEnd(item));
  return end;
}

export interface VideoLayer {
  item: VideoItem;
  /** Source media time to show. */
  sourceTime: number;
  /** 0..1 opacity when composited over the layer below. */
  opacity: number;
  /** 0..1 fraction of the frame revealed from the left (wipe), undefined = full frame. */
  wipe?: number;
  /** 0..1 brightness multiplier (fades and dip-to-black); 1 = unchanged. */
  dim: number;
  effects?: Effects;
  /** Position, scale, rotation and opacity at this time, for transformed items and overlays. */
  transform?: TransformState;
  /** On an overlay track (composited over the tracks below; docs/design/editor.md#timeline-model). */
  overlay?: boolean;
}

export interface ActiveAudio {
  item: VideoItem | AudioItem;
  sourceTime: number;
  gain: number;
}

export interface ActiveState {
  video: VideoLayer[];
  audio: ActiveAudio[];
  text: TextItem[];
}

/** Source seconds an item shows at a timeline time (through its speed or ramp). */
export function sourceTimeAt(item: VideoItem | AudioItem, time: number): number {
  const st = sourceAtItemTime(item, time - item.start);
  return Math.min(Math.max(st, item.in), Math.max(item.in, item.out - 1e-3));
}

/** The transform of a primary item at a time, when it has one. */
function primaryTransform(item: VideoItem, time: number): TransformState | undefined {
  return isIdentity(item.transform) ? undefined : transformAt(item.transform, time - item.start);
}

function fadeFactor(item: VideoItem | AudioItem, time: number): number {
  const local = time - item.start;
  const dur = itemDuration(item);
  let f = 1;
  if (item.fadeIn && local < item.fadeIn) f = Math.min(f, Math.max(0, local / item.fadeIn));
  if (item.fadeOut && dur - local < item.fadeOut) f = Math.min(f, Math.max(0, (dur - local) / item.fadeOut));
  return f;
}

/** Everything visible and audible at `time` (seconds). Preview and render both use this. */
export function activeAt(t: Timeline, time: number): ActiveState {
  const primary = primaryTrack(t);
  const items = primary.items as VideoItem[];
  const video: VideoLayer[] = [];
  const audio: ActiveAudio[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const start = item.start;
    const end = itemEnd(item);
    if (time < start || time >= end) continue;
    const next = items[i + 1];
    const tr: Transition | null | undefined = item.transitionIn;
    const inTransition = i > 0 && tr && time < start + tr.duration;
    // The outgoing item of a transition is emitted when handling the incoming one.
    if (next?.transitionIn && time >= next.start) continue;
    const layer: VideoLayer = {
      item,
      sourceTime: sourceTimeAt(item, time),
      opacity: 1,
      dim: fadeFactor(item, time),
      effects: item.effects,
      transform: primaryTransform(item, time),
    };
    if (inTransition && tr) {
      const prev = items[i - 1]!;
      const p = Math.min(1, Math.max(0, (time - start) / tr.duration));
      const out: VideoLayer = {
        item: prev,
        sourceTime: sourceTimeAt(prev, time),
        opacity: 1,
        dim: fadeFactor(prev, time),
        effects: prev.effects,
        transform: primaryTransform(prev, time),
      };
      if (tr.type === 'crossfade') {
        layer.opacity = p;
        video.push(out, layer);
      } else if (tr.type === 'wipe') {
        layer.wipe = p;
        video.push(out, layer);
      } else {
        // dip_to_black: first half fades the outgoing item down, second half fades the incoming one up.
        if (p < 0.5) {
          out.dim *= 1 - p * 2;
          video.push(out);
        } else {
          layer.dim *= (p - 0.5) * 2;
          video.push(layer);
        }
      }
      if (!prev.muted && !prev.ramp && prev.volume > 0 && prev.source.media.hasAudio !== false) {
        audio.push({
          item: prev,
          sourceTime: sourceTimeAt(prev, time),
          gain: prev.volume * (1 - p) * fadeFactor(prev, time),
        });
      }
      if (!item.muted && !item.ramp && item.volume > 0 && item.source.media.hasAudio !== false) {
        audio.push({ item, sourceTime: layer.sourceTime, gain: item.volume * p * fadeFactor(item, time) });
      }
    } else {
      video.push(layer);
      if (!item.muted && !item.ramp && item.volume > 0 && item.source.media.hasAudio !== false) {
        audio.push({ item, sourceTime: layer.sourceTime, gain: item.volume * fadeFactor(item, time) });
      }
    }
  }

  // Overlay tracks over the primary one, in track order (docs/design/editor.md#multitrack-transforms-and-keyframes)
  for (const track of t.tracks) {
    if (!isOverlayTrack(t, track)) continue;
    const tv = track.muted ? 0 : (track.volume ?? 1);
    for (const item of track.items as VideoItem[]) {
      if (time < item.start || time >= itemEnd(item)) continue;
      const local = time - item.start;
      const transform = transformAt(item.transform, local);
      transform.opacity = opacityAt(item.transform, item, itemDuration(item), local);
      video.push({
        item,
        sourceTime: sourceTimeAt(item, time),
        opacity: transform.opacity,
        dim: 1,
        effects: item.effects,
        transform,
        overlay: true,
      });
      if (tv > 0 && !item.muted && !item.ramp && item.volume > 0 && item.source.media.hasAudio !== false)
        audio.push({
          item,
          sourceTime: sourceTimeAt(item, time),
          gain: item.volume * tv * transform.opacity,
        });
    }
  }

  const text: TextItem[] = [];
  for (const track of t.tracks) {
    if (track.kind === 'audio') {
      if (track.muted) continue;
      const tv = track.volume ?? 1;
      for (const item of track.items as AudioItem[]) {
        if (time >= item.start && time < itemEnd(item)) {
          audio.push({
            item,
            sourceTime: sourceTimeAt(item, time),
            gain: item.volume * tv * fadeFactor(item, time),
          });
        }
      }
    } else if (track.kind === 'text') {
      for (const item of track.items as TextItem[]) {
        if (time < item.start || time >= item.start + item.duration) continue;
        // Animated captions show their current word frame (docs/design/localization.md).
        const shown = textAt(item, time - item.start);
        if (shown !== null) text.push(shown === item.text ? item : { ...item, text: shown });
      }
    }
  }
  return { video, audio, text };
}

export interface VideoSegment {
  itemId: string;
  media: MediaRef;
  start: number;
  end: number;
  in: number;
  out: number;
  speed: number;
  transitionIn: Transition | null;
  fadeIn: number;
  fadeOut: number;
  effects?: Effects;
  /** Reframed around these focus points (docs/design/finishing.md). */
  crop: FocusPoint[] | null;
  /** The item: its transform, ramp, LUT and mask (docs/design/editor.md#multitrack-transforms-and-keyframes). */
  item: VideoItem;
}

/** Primary-track segments in order (server render input). */
export function videoSegments(t: Timeline): VideoSegment[] {
  return (primaryTrack(t).items as VideoItem[]).map((item, i) => ({
    item,
    itemId: item.id,
    media: item.source.media,
    start: item.start,
    end: itemEnd(item),
    in: item.in,
    out: item.out,
    speed: item.speed,
    transitionIn: i > 0 ? (item.transitionIn ?? null) : null,
    fadeIn: item.fadeIn ?? 0,
    fadeOut: item.fadeOut ?? 0,
    effects: item.effects,
    crop: item.crop?.focus ?? null,
  }));
}

/** Items of the overlay tracks, bottom track first, each in time order. */
export function overlaySegments(t: Timeline): { trackIndex: number; segments: VideoSegment[] }[] {
  return t.tracks
    .filter((tr) => isOverlayTrack(t, tr))
    .map((tr, k) => ({
      trackIndex: k,
      segments: (tr.items as VideoItem[])
        .slice()
        .sort((a, b) => a.start - b.start)
        .map((item) => ({
          item,
          itemId: item.id,
          media: item.source.media,
          start: item.start,
          end: itemEnd(item),
          in: item.in,
          out: item.out,
          speed: item.speed,
          transitionIn: null,
          fadeIn: item.fadeIn ?? 0,
          fadeOut: item.fadeOut ?? 0,
          effects: item.effects,
          crop: item.crop?.focus ?? null,
        })),
    }));
}

export interface AudioSegment {
  itemId: string;
  media: MediaRef;
  start: number;
  end: number;
  in: number;
  out: number;
  speed: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** The stem (docs/design/post-audio.md#stems). */
  role: AudioRole;
  /** The primary video's own sound (true) or an audio track item. */
  primary: boolean;
  /** Spans of speech in source time, when the item says where its speech is. */
  speech: SpeechSpans | null;
}

/**
 * Every audible segment on the timeline (embedded audio of primary video items plus audio tracks).
 * Transition overlaps become audio crossfades, so browser mixdown and server render sound the same.
 */
/** A still image used as a video item (storyboard frames in the animatic, docs/design/storyboard.md#animatic). */
export function isStillMedia(media: Pick<MediaRef, 'mime'>): boolean {
  return media.mime.startsWith('image/');
}

export function audioSegments(t: Timeline): AudioSegment[] {
  const out: AudioSegment[] = [];
  const primary = primaryTrack(t);
  const primaryRole = trackRole(primary) ?? 'dialogue';
  const items = primary.items as VideoItem[];
  items.forEach((item, i) => {
    if (item.muted || item.volume <= 0 || item.source.media.hasAudio === false) return;
    // A ramped item's sound is muted (docs/design/editor.md#speed-ramps).
    if (isStillMedia(item.source.media) || item.ramp) return;
    const next = items[i + 1];
    const tin = i > 0 && item.transitionIn ? item.transitionIn.duration : 0;
    const tout = next?.transitionIn ? next.transitionIn.duration : 0;
    out.push({
      itemId: item.id,
      media: item.source.media,
      start: item.start,
      end: itemEnd(item),
      in: item.in,
      out: item.out,
      speed: item.speed,
      volume: item.volume,
      fadeIn: Math.max(item.fadeIn ?? 0, tin),
      fadeOut: Math.max(item.fadeOut ?? 0, tout),
      role: primaryRole,
      primary: true,
      speech: item.speech ?? null,
    });
  });
  // The sound of overlay items, on their track's stem (effects unless set)
  for (const track of t.tracks as Track[]) {
    if (!isOverlayTrack(t, track) || track.muted) continue;
    const tv = track.volume ?? 1;
    for (const item of track.items as VideoItem[]) {
      if (item.muted || item.ramp || item.volume <= 0 || item.source.media.hasAudio === false) continue;
      if (isStillMedia(item.source.media)) continue;
      out.push({
        itemId: item.id,
        media: item.source.media,
        start: item.start,
        end: itemEnd(item),
        in: item.in,
        out: item.out,
        speed: item.speed,
        volume: item.volume * tv,
        fadeIn: item.fadeIn ?? 0,
        fadeOut: item.fadeOut ?? 0,
        role: track.role ?? 'effects',
        primary: false,
        speech: item.speech ?? null,
      });
    }
  }
  for (const track of t.tracks as Track[]) {
    if (track.kind !== 'audio' || track.muted) continue;
    const tv = track.volume ?? 1;
    const role = trackRole(track) ?? 'effects';
    for (const item of track.items as AudioItem[]) {
      out.push({
        itemId: item.id,
        media: item.source.media,
        start: item.start,
        end: itemEnd(item),
        in: item.in,
        out: item.out,
        speed: 1,
        volume: item.volume * tv,
        fadeIn: item.fadeIn ?? 0,
        fadeOut: item.fadeOut ?? 0,
        role,
        primary: false,
        speech: item.speech ?? null,
      });
    }
  }
  return out;
}

export function textItems(t: Timeline): TextItem[] {
  return t.tracks.filter((tr) => tr.kind === 'text').flatMap((tr) => tr.items as TextItem[]);
}

/** Every media file the timeline references (for prefetch, GC and render inputs). */
export function referencedMedia(t: Timeline): MediaRef[] {
  const seen = new Map<string, MediaRef>();
  for (const track of t.tracks) {
    for (const item of track.items) {
      if (item.kind === 'text') continue;
      seen.set(item.source.media.hash, item.source.media);
      if (item.kind === 'video' && item.lut) seen.set(item.lut.media.hash, item.lut.media);
      if (item.kind === 'video' && item.mask) seen.set(item.mask.media.hash, item.mask.media);
    }
  }
  return [...seen.values()];
}

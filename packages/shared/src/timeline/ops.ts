import { newId } from '../ids';
import {
  type AudioItem,
  type AudioRole,
  DuckingSchema,
  type Item,
  ItemSchema,
  MixSchema,
  type TextItem,
  type Timeline,
  type TimelineOp,
  TimelineSchema,
  type Track,
  type VideoItem,
} from '../schemas/timeline';
import { deepClone } from '../util/canonical-json';
import { sourceAtLocal, timeMapOf } from './ramp';

const EPS = 1e-6;

export class TimelineOpError extends Error {
  readonly code = 'timeline_op_invalid';
  constructor(
    message: string,
    public readonly opIndex: number,
  ) {
    super(message);
    this.name = 'TimelineOpError';
  }
}

export interface OpContext {
  newId?: (kind: 'item' | 'track') => string;
}

/** Stable ids of the default tracks, so every client addresses the same tracks of a not-yet-saved timeline. */
export const DEFAULT_TRACK_IDS = {
  video: 'trk_primaryvideo01',
  audio: 'trk_musicbed000001',
  text: 'trk_titles00000001',
} as const;

/** The track that holds the TTS dialogue of the takes (docs/design/dialogue.md#timeline). */
export const DIALOGUE_TRACK_ID = 'trk_dialoguetrack01';
/** The track of generated sound effects (docs/design/post-audio.md#effects-from-action-lines). */
export const EFFECTS_TRACK_ID = 'trk_effectstrack01';

/**
 * The stem of a track's sound (docs/design/post-audio.md#stems): its `role`, else the primary video's production
 * sound and the Dialogue track are dialogue, the Music track is music and other audio tracks are effects.
 */
export function trackRole(track: Pick<Track, 'id' | 'kind' | 'role'>): AudioRole | null {
  if (track.kind === 'text') return null;
  if (track.role) return track.role;
  if (track.kind === 'video' || track.id === DIALOGUE_TRACK_ID) return 'dialogue';
  if (track.id === DEFAULT_TRACK_IDS.audio) return 'music';
  return 'effects';
}

export function emptyTimeline(opts: { fps: number; width: number; height: number }): Timeline {
  return {
    version: 1,
    fps: opts.fps,
    width: opts.width,
    height: opts.height,
    tracks: [
      { id: DEFAULT_TRACK_IDS.video, kind: 'video', name: 'Video', items: [] },
      { id: DEFAULT_TRACK_IDS.audio, kind: 'audio', name: 'Music', items: [] },
      { id: DEFAULT_TRACK_IDS.text, kind: 'text', name: 'Titles', items: [] },
    ],
  };
}

export function primaryTrack(t: Timeline): Track {
  const track = t.tracks.find((tr) => tr.kind === 'video');
  if (!track) throw new Error('timeline has no video track');
  return track;
}

export function itemDuration(item: Item): number {
  if (item.kind === 'text') return item.duration;
  if (item.kind === 'video' && item.ramp) return timeMapOf(item).duration;
  const speed = item.kind === 'video' ? item.speed : 1;
  return (item.out - item.in) / speed;
}

/** Source seconds shown `local` seconds into a video or audio item (through its speed or ramp). */
export function sourceAtItemTime(item: VideoItem | AudioItem, local: number): number {
  if (item.kind === 'video' && item.ramp) return sourceAtLocal(timeMapOf(item), local);
  return item.in + local * (item.kind === 'video' ? item.speed : 1);
}

/** Whether a track is an overlay video track (a video track after the primary one). */
export function isOverlayTrack(t: Timeline, track: Pick<Track, 'id' | 'kind'>): boolean {
  return track.kind === 'video' && primaryTrack(t).id !== track.id;
}

export function itemEnd(item: Item): number {
  return item.start + itemDuration(item);
}

/** Recomputes start times of the magnetic primary track. The first item never has a transition. */
export function layoutPrimary(track: Track): void {
  let cursor = 0;
  track.items.forEach((raw, i) => {
    const item = raw as VideoItem;
    if (i === 0 && item.transitionIn) item.transitionIn = null;
    const d = i > 0 && item.transitionIn ? item.transitionIn.duration : 0;
    const prev = i > 0 ? (track.items[i - 1] as VideoItem) : undefined;
    const start = prev ? Math.max(prev.start, cursor - d) : 0;
    item.start = round6(start);
    cursor = start + itemDuration(item);
  });
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function sortFree(track: Track): void {
  track.items.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

interface Found {
  track: Track;
  index: number;
  item: Item;
}

function findItem(t: Timeline, itemId: string, opIndex: number): Found {
  for (const track of t.tracks) {
    const index = track.items.findIndex((it) => it.id === itemId);
    if (index >= 0) return { track, index, item: track.items[index]! };
  }
  throw new TimelineOpError(`item ${itemId} not found`, opIndex);
}

function findTrack(t: Timeline, trackId: string, opIndex: number): Track {
  const track = t.tracks.find((tr) => tr.id === trackId);
  if (!track) throw new TimelineOpError(`track ${trackId} not found`, opIndex);
  return track;
}

function mediaDuration(item: VideoItem | AudioItem): number | undefined {
  return item.source.media.durationSec;
}

function checkRange(item: VideoItem | AudioItem, opIndex: number): void {
  if (!(item.in >= 0)) throw new TimelineOpError('in must be >= 0', opIndex);
  if (!(item.out > item.in + EPS)) throw new TimelineOpError('out must be greater than in', opIndex);
  const dur = mediaDuration(item);
  if (dur !== undefined && item.out > dur + 0.05) {
    throw new TimelineOpError(`out ${item.out} exceeds media duration ${dur}`, opIndex);
  }
}

function checkTransition(track: Track, index: number, opIndex: number): void {
  const item = track.items[index] as VideoItem;
  if (!item.transitionIn) return;
  if (index === 0) throw new TimelineOpError('the first item cannot have a transition', opIndex);
  const prev = track.items[index - 1] as VideoItem;
  const max = Math.min(itemDuration(prev), itemDuration(item)) / 2 + EPS;
  if (item.transitionIn.duration > max) {
    throw new TimelineOpError(
      `transition of ${item.transitionIn.duration}s exceeds half the shorter neighbour (${(max - EPS).toFixed(2)}s)`,
      opIndex,
    );
  }
}

function parseItem(raw: unknown, opIndex: number): Item {
  const res = ItemSchema.safeParse(raw);
  if (!res.success) {
    throw new TimelineOpError(
      `invalid item: ${res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      opIndex,
    );
  }
  return res.data;
}

function isPrimary(t: Timeline, track: Track): boolean {
  return primaryTrack(t).id === track.id;
}

/** Applies timeline operations atomically; throws TimelineOpError and leaves the input untouched on failure. */
export function applyOps(timeline: Timeline, ops: TimelineOp[], ctx: OpContext = {}): Timeline {
  const gen = ctx.newId ?? ((k) => newId(k));
  const t = deepClone(timeline);
  ops.forEach((op, i) => {
    applyOne(t, op, i, gen);
  });
  layoutPrimary(primaryTrack(t));
  for (const track of t.tracks) if (!isPrimary(t, track)) sortFree(track);
  const checked = TimelineSchema.safeParse(t);
  if (!checked.success) {
    throw new TimelineOpError(
      `resulting timeline invalid: ${checked.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`,
      Math.max(0, ops.length - 1),
    );
  }
  return checked.data;
}

function applyOne(t: Timeline, op: TimelineOp, i: number, gen: (k: 'item' | 'track') => string): void {
  switch (op.op) {
    case 'insert': {
      const track = findTrack(t, op.trackId, i);
      if (op.item.kind !== track.kind) {
        throw new TimelineOpError(`cannot insert a ${op.item.kind} item into a ${track.kind} track`, i);
      }
      const base: Record<string, unknown> = { ...op.item, id: op.item.id ?? gen('item') };
      if (base.kind === 'video') {
        base.speed ??= 1;
        base.volume ??= 1;
        base.start ??= 0;
      }
      if (base.kind === 'audio') base.volume ??= 1;
      if (t.tracks.some((tr) => tr.items.some((it) => it.id === base.id))) {
        throw new TimelineOpError(`duplicate item id ${String(base.id)}`, i);
      }
      const item = parseItem(base, i);
      if (item.kind !== 'text') checkRange(item, i);
      if (item.kind === 'video' && item.transitionIn && !isPrimary(t, track))
        throw new TimelineOpError('overlay items have no transitions; fade their opacity', i);
      if (isPrimary(t, track)) {
        const index = Math.min(op.index ?? track.items.length, track.items.length);
        track.items.splice(index, 0, item);
        layoutPrimary(track);
        checkTransition(track, index, i);
      } else {
        track.items.push(item);
        sortFree(track);
      }
      return;
    }
    case 'remove': {
      const found = findItem(t, op.itemId, i);
      found.track.items.splice(found.index, 1);
      if (isPrimary(t, found.track)) layoutPrimary(found.track);
      return;
    }
    case 'move': {
      const found = findItem(t, op.itemId, i);
      if (isPrimary(t, found.track)) {
        if (op.index === undefined) throw new TimelineOpError('move on the primary track needs index', i);
        found.track.items.splice(found.index, 1);
        const index = Math.min(op.index, found.track.items.length);
        found.track.items.splice(index, 0, found.item);
        layoutPrimary(found.track);
        const pos = found.track.items.indexOf(found.item);
        checkTransition(found.track, pos, i);
        if (pos + 1 < found.track.items.length) checkTransition(found.track, pos + 1, i);
      } else {
        if (op.start === undefined) throw new TimelineOpError('move on a free track needs start', i);
        found.item.start = op.start;
        sortFree(found.track);
      }
      return;
    }
    case 'trim': {
      const found = findItem(t, op.itemId, i);
      const item = found.item;
      if (item.kind === 'text') throw new TimelineOpError('use update_text to change text timing', i);
      if (op.in !== undefined) item.in = op.in;
      if (op.out !== undefined) item.out = op.out;
      checkRange(item, i);
      if (isPrimary(t, found.track)) {
        layoutPrimary(found.track);
        checkTransition(found.track, found.index, i);
        if (found.index + 1 < found.track.items.length) checkTransition(found.track, found.index + 1, i);
      }
      return;
    }
    case 'split': {
      const found = findItem(t, op.itemId, i);
      const item = found.item;
      const start = item.start;
      const end = itemEnd(item);
      if (!(op.at > start + 0.05 && op.at < end - 0.05)) {
        throw new TimelineOpError(
          `split point ${op.at} is outside item (${start.toFixed(2)}–${end.toFixed(2)})`,
          i,
        );
      }
      let second: Item;
      if (item.kind === 'text') {
        const firstDur = op.at - start;
        second = { ...item, id: gen('item'), start: op.at, duration: item.duration - firstDur };
        item.duration = firstDur;
      } else {
        // A ramp is in source time, so both halves keep it (docs/design/editor.md#speed-ramps).
        const cut = sourceAtItemTime(item, op.at - start);
        second = { ...deepClone(item), id: gen('item'), in: cut } as Item;
        item.out = cut;
        if (item.kind === 'video') {
          delete item.fadeOut;
          const v2 = second as VideoItem;
          v2.transitionIn = null;
          delete v2.fadeIn;
        } else {
          delete item.fadeOut;
          delete (second as AudioItem).fadeIn;
        }
        if (second.kind !== 'text') (second as VideoItem | AudioItem).start = op.at;
      }
      found.track.items.splice(found.index + 1, 0, second);
      if (isPrimary(t, found.track)) layoutPrimary(found.track);
      else sortFree(found.track);
      return;
    }
    case 'set_transition': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind !== 'video' || !isPrimary(t, found.track)) {
        throw new TimelineOpError('transitions apply to items of the primary video track', i);
      }
      found.item.transitionIn = op.transition;
      layoutPrimary(found.track);
      checkTransition(found.track, found.index, i);
      return;
    }
    case 'set_speed': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('speed applies to video items', i);
      found.item.speed = op.speed;
      // A constant speed replaces a ramp.
      delete found.item.ramp;
      layoutPrimary(found.track);
      checkTransition(found.track, found.index, i);
      return;
    }
    case 'set_volume': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind === 'text') throw new TimelineOpError('volume applies to video and audio items', i);
      found.item.volume = op.volume;
      if (found.item.kind === 'video' && op.muted !== undefined) found.item.muted = op.muted;
      return;
    }
    case 'set_fades': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind === 'text') throw new TimelineOpError('fades apply to video and audio items', i);
      const dur = itemDuration(found.item);
      if ((op.fadeIn ?? 0) + (op.fadeOut ?? 0) > dur + EPS) {
        throw new TimelineOpError('fades are longer than the item', i);
      }
      if (op.fadeIn !== undefined) found.item.fadeIn = op.fadeIn;
      if (op.fadeOut !== undefined) found.item.fadeOut = op.fadeOut;
      return;
    }
    case 'set_effects': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('effects apply to video items', i);
      found.item.effects = { ...found.item.effects, ...op.effects };
      return;
    }
    case 'add_text': {
      let track = op.trackId ? findTrack(t, op.trackId, i) : t.tracks.find((tr) => tr.kind === 'text');
      if (!track) {
        track = { id: gen('track'), kind: 'text', name: 'Titles', items: [] };
        t.tracks.push(track);
      }
      if (track.kind !== 'text') throw new TimelineOpError('add_text needs a text track', i);
      const item = parseItem({ ...op.item, kind: 'text', id: op.item.id ?? gen('item') }, i) as TextItem;
      track.items.push(item);
      sortFree(track);
      return;
    }
    case 'update_text': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind !== 'text') throw new TimelineOpError('update_text applies to text items', i);
      if (op.text !== undefined && op.text !== found.item.text) {
        found.item.text = op.text;
        // The words timed the old text: the caption shows statically (docs/design/localization.md).
        delete found.item.words;
      }
      if (op.style !== undefined) found.item.style = op.style;
      if (op.start !== undefined) found.item.start = op.start;
      if (op.duration !== undefined) found.item.duration = op.duration;
      sortFree(found.track);
      return;
    }
    case 'add_track': {
      const id = op.track.id ?? gen('track');
      if (t.tracks.some((tr) => tr.id === id)) throw new TimelineOpError(`duplicate track id ${id}`, i);
      const track: Track = {
        id,
        kind: op.track.kind,
        name: op.track.name,
        ...(op.track.role && op.track.kind !== 'text' ? { role: op.track.role } : {}),
        items: [],
      };
      // Overlay tracks go above the other video tracks: composited in track order (docs/design/editor.md).
      if (track.kind === 'video') {
        const last = t.tracks.reduce((k, tr, idx) => (tr.kind === 'video' ? idx : k), -1);
        t.tracks.splice(last + 1, 0, track);
      } else t.tracks.push(track);
      return;
    }
    case 'remove_track': {
      const track = findTrack(t, op.trackId, i);
      if (isPrimary(t, track)) throw new TimelineOpError('the primary video track cannot be removed', i);
      t.tracks = t.tracks.filter((tr) => tr.id !== track.id);
      return;
    }
    case 'set_track': {
      const track = findTrack(t, op.trackId, i);
      if (op.name !== undefined) track.name = op.name;
      if (op.muted !== undefined) track.muted = op.muted;
      if (op.volume !== undefined) track.volume = op.volume;
      if (op.role !== undefined) {
        if (track.kind === 'text') throw new TimelineOpError('text tracks have no sound', i);
        track.role = op.role;
      }
      return;
    }
    case 'set_caption_style': {
      for (const track of t.tracks)
        for (const item of track.items)
          if (item.kind === 'text' && item.style.preset === 'caption') {
            const style = { ...item.style };
            for (const [k, v] of Object.entries(op.style))
              if (v !== undefined) (style as Record<string, unknown>)[k] = v;
            item.style = style;
          }
      return;
    }
    case 'set_mix': {
      const cur = t.mix ?? MixSchema.parse({});
      t.mix = { ...cur, ducking: DuckingSchema.parse({ ...cur.ducking, ...op.ducking }) };
      return;
    }
    case 'replace_source': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind === 'text') throw new TimelineOpError('text items have no source', i);
      const item = found.item;
      item.source = op.source;
      const dur = op.source.media.durationSec;
      if (dur !== undefined && item.out > dur) {
        const len = Math.min(item.out - item.in, dur);
        item.in = Math.max(0, Math.min(item.in, dur - len));
        item.out = item.in + len;
      }
      checkRange(item, i);
      if (isPrimary(t, found.track)) layoutPrimary(found.track);
      return;
    }
    case 'add_bumper': {
      // An intro or outro on the picture track; an intro moves every other track later (docs/design/brand-kits.md)
      const track = primaryTrack(t);
      const still = op.source.media.mime.startsWith('image/');
      const dur = op.source.media.durationSec;
      const len = !still && dur !== undefined ? Math.min(op.durationSec, dur) : op.durationSec;
      const item = parseItem(
        {
          id: gen('item'),
          kind: 'video',
          source: op.source,
          start: 0,
          in: 0,
          out: len,
          speed: 1,
          volume: 1,
          label: op.position === 'intro' ? 'Intro' : 'Outro',
        },
        i,
      );
      if (op.position === 'intro') {
        track.items.unshift(item);
        const first = track.items[1] as VideoItem | undefined;
        if (first?.transitionIn) first.transitionIn = null;
        for (const other of t.tracks)
          if (other.id !== track.id)
            for (const x of other.items) x.start = Math.round((x.start + len) * 1e6) / 1e6;
      } else track.items.push(item);
      layoutPrimary(track);
      return;
    }
    case 'set_transform': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('transforms apply to video items', i);
      if (op.transform)
        found.item.transform = { keyframes: [...op.transform.keyframes].sort((a, b) => a.t - b.t) };
      else delete found.item.transform;
      return;
    }
    case 'set_ramp': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('speed ramps apply to video items', i);
      if (op.ramp) {
        const pts = [...op.ramp.points].sort((a, b) => a.at - b.at);
        const v = found.item;
        if (pts.some((p) => p.at < v.in - EPS || p.at > v.out + EPS))
          throw new TimelineOpError('ramp points must lie inside the item’s source range', i);
        found.item.ramp = { points: pts };
      } else delete found.item.ramp;
      if (isPrimary(t, found.track)) {
        layoutPrimary(found.track);
        checkTransition(found.track, found.index, i);
        if (found.index + 1 < found.track.items.length) checkTransition(found.track, found.index + 1, i);
      }
      return;
    }
    case 'set_lut': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('LUTs apply to video items', i);
      if (op.lut) found.item.lut = op.lut;
      else delete found.item.lut;
      return;
    }
    case 'set_mask': {
      const found = findItem(t, op.itemId, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('masks apply to video items', i);
      if (op.mask) found.item.mask = op.mask;
      else delete found.item.mask;
      return;
    }
    case 'remove_ranges': {
      const track = primaryTrack(t);
      const cuts = [...op.ranges].filter(([a, b]) => b > a + EPS).sort((x, y) => x[0] - y[0]);
      const next: Item[] = [];
      for (const raw of track.items) {
        const item = raw as VideoItem;
        if (item.source.media.path !== op.media) {
          next.push(item);
          continue;
        }
        // The parts of [in, out] that stay; the first keeps the item's id, transition and fade-in.
        let parts: [number, number][] = [[item.in, item.out]];
        for (const [a, b] of cuts)
          parts = parts.flatMap(([x, y]) =>
            b <= x || a >= y
              ? [[x, y] as [number, number]]
              : (
                  [
                    [x, a],
                    [b, y],
                  ] as [number, number][]
                ).filter(([p, q]) => q - p > 0.04),
          );
        parts.forEach(([x, y], k) => {
          const piece: VideoItem = { ...deepClone(item), id: k === 0 ? item.id : gen('item'), in: x, out: y };
          if (k > 0) {
            piece.transitionIn = null;
            delete piece.fadeIn;
          }
          if (k < parts.length - 1) delete piece.fadeOut;
          if (k === 0 && x > item.in + EPS) piece.transitionIn = null;
          next.push(piece);
        });
      }
      track.items = next;
      layoutPrimary(track);
      // Shorter neighbours: transitions shrink to half the shorter one (or go).
      track.items.forEach((raw, k) => {
        const item = raw as VideoItem;
        if (!item.transitionIn || k === 0) return;
        const max = Math.min(itemDuration(track.items[k - 1]!), itemDuration(item)) / 2;
        if (item.transitionIn.duration > max)
          item.transitionIn =
            max >= 0.04 ? { ...item.transitionIn, duration: Math.floor(max * 1000) / 1000 } : null;
      });
      layoutPrimary(track);
      return;
    }
    case 'set_output': {
      if (op.fps !== undefined) t.fps = op.fps;
      if (op.width !== undefined) t.width = op.width;
      if (op.height !== undefined) t.height = op.height;
      return;
    }
  }
}

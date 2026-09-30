import { newId } from '../ids';
import {
  type AudioItem,
  type Item,
  ItemSchema,
  type TextItem,
  type Timeline,
  type TimelineOp,
  TimelineSchema,
  type Track,
  type VideoItem,
} from '../schemas/timeline';
import { deepClone } from '../util/canonical-json';

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
  const speed = item.kind === 'video' ? item.speed : 1;
  return (item.out - item.in) / speed;
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
        const speed = item.kind === 'video' ? item.speed : 1;
        const cut = item.in + (op.at - start) * speed;
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
      if (op.text !== undefined) found.item.text = op.text;
      if (op.style !== undefined) found.item.style = op.style;
      if (op.start !== undefined) found.item.start = op.start;
      if (op.duration !== undefined) found.item.duration = op.duration;
      sortFree(found.track);
      return;
    }
    case 'add_track': {
      const id = op.track.id ?? gen('track');
      if (t.tracks.some((tr) => tr.id === id)) throw new TimelineOpError(`duplicate track id ${id}`, i);
      t.tracks.push({ id, kind: op.track.kind, name: op.track.name, items: [] });
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
    case 'set_output': {
      if (op.fps !== undefined) t.fps = op.fps;
      if (op.width !== undefined) t.width = op.width;
      if (op.height !== undefined) t.height = op.height;
      return;
    }
  }
}

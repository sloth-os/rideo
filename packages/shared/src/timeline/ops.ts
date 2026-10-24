import { newId } from '../ids';
import {
  type AudioItem,
  type AudioRole,
  DuckingSchema,
  FREEZE_SPAN,
  type Item,
  ItemSchema,
  MarkerSchema,
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
  newId?: (kind: 'item' | 'track' | 'marker') => string;
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
  // A freeze frame holds its frame for its duration (docs/design/editing-tools.md#freeze-frame)
  if (item.kind === 'video' && item.freeze) return item.freeze.duration;
  if (item.kind === 'video' && item.ramp) return timeMapOf(item).duration;
  const speed = item.kind === 'video' ? item.speed : 1;
  return (item.out - item.in) / speed;
}

/** Source seconds shown `local` seconds into a video or audio item (through its speed or ramp). */
export function sourceAtItemTime(item: VideoItem | AudioItem, local: number): number {
  if (item.kind === 'video' && item.freeze) return item.in;
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

/** A locked track's items cannot change (docs/design/editing-tools.md#track-controls). */
function guard(track: Track, opIndex: number): void {
  if (track.locked) throw new TimelineOpError(`track "${track.name}" is locked`, opIndex);
}

const isStill = (item: VideoItem | AudioItem) => item.source.media.mime.startsWith('image/');

/**
 * Splits an item at `at` (timeline seconds) into two; the second gets a fresh id and is placed after the first.
 * Returns the second item.
 */
function splitAt(t: Timeline, found: Found, at: number, i: number, gen: (k: 'item') => string): Item {
  const item = found.item;
  const start = item.start;
  const end = itemEnd(item);
  if (!(at > start + 0.05 && at < end - 0.05)) {
    throw new TimelineOpError(`split point ${at} is outside item (${start.toFixed(2)}–${end.toFixed(2)})`, i);
  }
  let second: Item;
  if (item.kind === 'text') {
    const firstDur = at - start;
    second = { ...item, id: gen('item'), start: at, duration: item.duration - firstDur };
    item.duration = firstDur;
  } else if (item.kind === 'video' && item.freeze) {
    // Two holds of the same frame
    if (at - start < 0.1 || end - at < 0.1)
      throw new TimelineOpError('each part of a freeze frame lasts at least 0.1 s', i);
    second = { ...deepClone(item), id: gen('item'), start: at, freeze: { duration: end - at } };
    item.freeze = { duration: at - start };
    (second as VideoItem).transitionIn = null;
    delete item.fadeOut;
    delete (second as VideoItem).fadeIn;
  } else {
    // A ramp is in source time, so both halves keep it (docs/design/editor.md#speed-ramps).
    const cut = sourceAtItemTime(item, at - start);
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
    if (second.kind !== 'text') (second as VideoItem | AudioItem).start = at;
  }
  found.track.items.splice(found.index + 1, 0, second);
  if (isPrimary(t, found.track)) layoutPrimary(found.track);
  else sortFree(found.track);
  return second;
}

/** Checks the transitions around position `pos` of the primary track after it changed. */
function checkAround(track: Track, pos: number, opIndex: number): void {
  if (pos >= 0 && pos < track.items.length) checkTransition(track, pos, opIndex);
  if (pos + 1 < track.items.length) checkTransition(track, pos + 1, opIndex);
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
  if (t.markers) {
    if (t.markers.length) t.markers.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
    else delete t.markers;
  }
  const checked = TimelineSchema.safeParse(t);
  if (!checked.success) {
    throw new TimelineOpError(
      `resulting timeline invalid: ${checked.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`,
      Math.max(0, ops.length - 1),
    );
  }
  return checked.data;
}

function applyOne(
  t: Timeline,
  op: TimelineOp,
  i: number,
  gen: (k: 'item' | 'track' | 'marker') => string,
): void {
  switch (op.op) {
    case 'insert': {
      const track = findTrack(t, op.trackId, i);
      guard(track, i);
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
      guard(found.track, i);
      found.track.items.splice(found.index, 1);
      if (isPrimary(t, found.track)) layoutPrimary(found.track);
      return;
    }
    case 'move': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      const target = op.trackId ? findTrack(t, op.trackId, i) : found.track;
      if (target !== found.track) {
        // To another track of the same kind (docs/design/editing-tools.md#moving-items)
        guard(target, i);
        if (target.kind !== found.track.kind)
          throw new TimelineOpError(`a ${found.item.kind} item cannot move to a ${target.kind} track`, i);
        const item = found.item;
        // Leaving a track is a remove from it; joining one, an insert into it
        found.track.items.splice(found.index, 1);
        if (isPrimary(t, found.track)) layoutPrimary(found.track);
        if (item.kind === 'video') item.transitionIn = null;
        if (isPrimary(t, target)) {
          if (op.index === undefined)
            throw new TimelineOpError('a move onto the primary track needs index', i);
          const index = Math.min(op.index, target.items.length);
          target.items.splice(index, 0, item);
          layoutPrimary(target);
          checkAround(target, index, i);
        } else {
          if (op.start === undefined) throw new TimelineOpError('a move to a free track needs start', i);
          item.start = op.start;
          target.items.push(item);
          sortFree(target);
        }
        return;
      }
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
      guard(found.track, i);
      const item = found.item;
      if (item.kind === 'text') throw new TimelineOpError('use update_text to change text timing', i);
      if (item.kind === 'video' && item.freeze) {
        // `in` chooses the held frame; its length is its duration (set_freeze)
        if (op.out !== undefined)
          throw new TimelineOpError('a freeze frame lasts its duration: use set_freeze', i);
        if (op.in !== undefined) {
          const dur = mediaDuration(item);
          item.in = Math.max(0, dur !== undefined ? Math.min(op.in, dur - FREEZE_SPAN) : op.in);
          item.out = item.in + FREEZE_SPAN;
        }
        checkRange(item, i);
        return;
      }
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
      guard(found.track, i);
      splitAt(t, found, op.at, i, gen);
      return;
    }
    case 'set_transition': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
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
      guard(found.track, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('speed applies to video items', i);
      if (found.item.freeze) throw new TimelineOpError('a freeze frame has no speed', i);
      found.item.speed = op.speed;
      // A constant speed replaces a ramp.
      delete found.item.ramp;
      layoutPrimary(found.track);
      checkTransition(found.track, found.index, i);
      return;
    }
    case 'set_volume': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      if (found.item.kind === 'text') throw new TimelineOpError('volume applies to video and audio items', i);
      found.item.volume = op.volume;
      if (found.item.kind === 'video' && op.muted !== undefined) found.item.muted = op.muted;
      return;
    }
    case 'set_fades': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
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
      guard(found.track, i);
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
      guard(track, i);
      const item = parseItem({ ...op.item, kind: 'text', id: op.item.id ?? gen('item') }, i) as TextItem;
      track.items.push(item);
      sortFree(track);
      return;
    }
    case 'update_text': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
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
      guard(track, i);
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
      // Track controls (docs/design/editing-tools.md#track-controls)
      if (op.locked !== undefined) {
        if (op.locked) track.locked = true;
        else delete track.locked;
      }
      if (op.hidden !== undefined) {
        if (track.kind !== 'video') throw new TimelineOpError('only video tracks hide', i);
        if (op.hidden) track.hidden = true;
        else delete track.hidden;
      }
      return;
    }
    case 'set_caption_style': {
      for (const track of t.tracks)
        if (!track.locked)
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
      guard(found.track, i);
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
      guard(track, i);
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
        for (const m of t.markers ?? []) m.t = Math.round((m.t + len) * 1e6) / 1e6;
      } else track.items.push(item);
      layoutPrimary(track);
      return;
    }
    case 'set_transform': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('transforms apply to video items', i);
      if (op.transform)
        found.item.transform = { keyframes: [...op.transform.keyframes].sort((a, b) => a.t - b.t) };
      else delete found.item.transform;
      return;
    }
    case 'set_ramp': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('speed ramps apply to video items', i);
      if (op.ramp && found.item.freeze) throw new TimelineOpError('a freeze frame has no speed', i);
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
      guard(found.track, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('LUTs apply to video items', i);
      if (op.lut) found.item.lut = op.lut;
      else delete found.item.lut;
      return;
    }
    case 'set_mask': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('masks apply to video items', i);
      if (op.mask && found.item.key)
        throw new TimelineOpError('an item is keyed or has its background removed, not both', i);
      // A matte plays; a freeze frame holds still (docs/design/editing-tools.md#freeze-frame)
      if (op.mask && found.item.freeze) throw new TimelineOpError('a freeze frame has no mask', i);
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
        // A freeze frame holds a frame; it does not play the media
        if (item.source.media.path !== op.media || item.freeze) {
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
      if (next.length !== track.items.length || next.some((x, k) => x !== track.items[k])) guard(track, i);
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
    // Editing tools (docs/design/editing-tools.md)
    case 'duplicate': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      const copy = { ...deepClone(found.item), id: gen('item') } as Item;
      if (isPrimary(t, found.track)) {
        (copy as VideoItem).transitionIn = null;
        found.track.items.splice(found.index + 1, 0, copy);
        layoutPrimary(found.track);
        checkAround(found.track, found.index + 1, i);
      } else {
        copy.start = round6(itemEnd(found.item));
        found.track.items.push(copy);
        sortFree(found.track);
      }
      return;
    }
    case 'add_marker': {
      const markers = t.markers ?? [];
      if (markers.length >= 1000) throw new TimelineOpError('a cut holds at most 1000 markers', i);
      const id = op.marker.id ?? gen('marker');
      if (markers.some((m) => m.id === id)) throw new TimelineOpError(`duplicate marker id ${id}`, i);
      const parsed = MarkerSchema.safeParse({ ...op.marker, id });
      if (!parsed.success) throw new TimelineOpError(`invalid marker: ${parsed.error.message}`, i);
      t.markers = [...markers, parsed.data];
      return;
    }
    case 'update_marker': {
      const m = (t.markers ?? []).find((x) => x.id === op.markerId);
      if (!m) throw new TimelineOpError(`marker ${op.markerId} not found`, i);
      if (op.t !== undefined) m.t = op.t;
      if (op.label !== undefined) m.label = op.label;
      if (op.color !== undefined) m.color = op.color;
      return;
    }
    case 'remove_marker': {
      if (!(t.markers ?? []).some((x) => x.id === op.markerId))
        throw new TimelineOpError(`marker ${op.markerId} not found`, i);
      t.markers = t.markers!.filter((x) => x.id !== op.markerId);
      return;
    }
    case 'freeze_frame': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      const item = found.item;
      if (item.kind !== 'video') throw new TimelineOpError('freeze frames hold a frame of a video item', i);
      if (isStill(item)) throw new TimelineOpError('a still is already a single frame', i);
      if (item.freeze)
        throw new TimelineOpError('the item is a freeze frame already: set_freeze changes it', i);
      const start = item.start;
      const end = itemEnd(item);
      if (op.at < start - EPS || op.at > end + EPS)
        throw new TimelineOpError(`${op.at} is outside the item (${start.toFixed(2)}–${end.toFixed(2)})`, i);
      const duration = op.duration ?? 2;
      // The frame shown at `at` (the last one at the item's end)
      const local = Math.min(Math.max(op.at - start, 0), itemDuration(item));
      const shown = Math.min(
        Math.max(sourceAtItemTime(item, local), item.in),
        Math.max(item.in, item.out - 1e-3),
      );
      const dur = mediaDuration(item);
      const frame = Math.max(0, dur !== undefined ? Math.min(shown, dur - FREEZE_SPAN) : shown);
      const hold: VideoItem = {
        ...deepClone(item),
        id: gen('item'),
        in: frame,
        out: frame + FREEZE_SPAN,
        speed: 1,
        freeze: { duration },
        transitionIn: null,
      };
      for (const k of ['ramp', 'mask', 'fadeIn', 'fadeOut', 'speech'] as const) delete hold[k];
      const inside = op.at > start + 0.05 && op.at < end - 0.05;
      const atStart = !inside && op.at <= start + 0.05;
      if (isPrimary(t, found.track)) {
        if (inside) splitAt(t, found, op.at, i, gen);
        if (atStart && item.transitionIn) {
          // Before the item, the hold takes the transition into it
          hold.transitionIn = item.transitionIn;
          item.transitionIn = null;
        }
        const index = atStart ? found.index : found.index + 1;
        found.track.items.splice(index, 0, hold);
        layoutPrimary(found.track);
        checkAround(found.track, index, i);
      } else {
        // A free track does not ripple: what follows the frame moves later by its length
        if (inside) {
          const second = splitAt(t, found, op.at, i, gen);
          second.start = round6(op.at + duration);
          hold.start = op.at;
        } else if (atStart) {
          hold.start = start;
          item.start = round6(start + duration);
        } else hold.start = round6(end);
        found.track.items.push(hold);
        sortFree(found.track);
      }
      return;
    }
    case 'set_freeze': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      if (found.item.kind !== 'video' || !found.item.freeze)
        throw new TimelineOpError('set_freeze applies to freeze frames', i);
      found.item.freeze = { duration: op.duration };
      if (isPrimary(t, found.track)) {
        layoutPrimary(found.track);
        checkAround(found.track, found.index, i);
      }
      return;
    }
    case 'detach_audio': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      const item = found.item;
      if (item.kind !== 'video') throw new TimelineOpError('detach_audio applies to video items', i);
      if (isStill(item) || item.source.media.hasAudio === false)
        throw new TimelineOpError('the item has no sound to detach', i);
      if (item.freeze || item.ramp || Math.abs(item.speed - 1) > EPS)
        throw new TimelineOpError('sound detaches at 1× (no ramp, not a freeze frame)', i);
      if (item.muted) throw new TimelineOpError('the item’s sound is muted', i);
      let track: Track;
      if (op.trackId) {
        track = findTrack(t, op.trackId, i);
        if (track.kind !== 'audio') throw new TimelineOpError('detached sound goes onto an audio track', i);
        guard(track, i);
      } else {
        track = {
          id: gen('track'),
          kind: 'audio',
          name: 'Sound',
          role: trackRole(found.track) ?? 'dialogue',
          items: [],
        };
        t.tracks.push(track);
      }
      const sound: AudioItem = {
        id: gen('item'),
        kind: 'audio',
        source: deepClone(item.source),
        start: item.start,
        in: item.in,
        out: item.out,
        volume: item.volume,
        ...(item.fadeIn ? { fadeIn: item.fadeIn } : {}),
        ...(item.fadeOut ? { fadeOut: item.fadeOut } : {}),
        ...(item.label ? { label: item.label } : {}),
        ...(item.speech ? { speech: deepClone(item.speech) } : {}),
      };
      track.items.push(parseItem(sound, i));
      sortFree(track);
      item.muted = true;
      return;
    }
    case 'set_flip': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('mirroring applies to video items', i);
      if (op.flip && (op.flip.x || op.flip.y))
        found.item.flip = { ...(op.flip.x ? { x: true } : {}), ...(op.flip.y ? { y: true } : {}) };
      else delete found.item.flip;
      return;
    }
    case 'set_key': {
      const found = findItem(t, op.itemId, i);
      guard(found.track, i);
      if (found.item.kind !== 'video') throw new TimelineOpError('chroma keys apply to video items', i);
      if (op.key && found.item.mask)
        throw new TimelineOpError('an item is keyed or has its background removed, not both', i);
      if (op.key) found.item.key = op.key;
      else delete found.item.key;
      return;
    }
  }
}

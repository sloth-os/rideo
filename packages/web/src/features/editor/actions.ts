import {
  type Item,
  isOverlayTrack,
  itemDuration,
  itemEnd,
  primaryTrack,
  type Timeline,
  type TimelineOp,
  type Track,
} from '@rideo/shared';

/**
 * The editor's editing actions as timeline operations (docs/design/editing-tools.md#the-workflow): pure, so the keys,
 * the context menu and the inspector make the same ops and tests check them without a browser.
 */

const ms = (v: number) => Math.round(v * 1000) / 1000;

/** The place on the primary track nearest a time: how many items end before it, by their middles. */
export function primaryIndexAt(t: Timeline, time: number): number {
  return primaryTrack(t).items.filter((i) => i.start + itemDuration(i) / 2 < time).length;
}

export function findItem(t: Timeline, itemId: string): { track: Track; item: Item } | null {
  for (const track of t.tracks) {
    const item = track.items.find((i) => i.id === itemId);
    if (item) return { track, item };
  }
  return null;
}

/** What `S` splits: the selected item when the playhead is inside it, else the primary item under the playhead. */
export function splitTarget(t: Timeline, selected: string | null, time: number): Item | null {
  const inside = (i: Item) => time > i.start + 0.05 && time < itemEnd(i) - 0.05;
  const sel = selected ? findItem(t, selected) : null;
  if (sel) return inside(sel.item) && !sel.track.locked ? sel.item : null;
  const primary = primaryTrack(t);
  if (primary.locked) return null;
  return primary.items.find(inside) ?? null;
}

/** An item in the session's clipboard and the track it came from. */
export interface Clip {
  item: Item;
  trackId: string;
}

/**
 * Paste at the playhead as an insert (docs/design/editing-tools.md#copy-paste-and-duplicate): on its own track when it
 * is still there, else the first track of its kind (video: the primary track); at the playhead's place on the primary
 * track.
 */
export function pasteOps(t: Timeline, clip: Clip, time: number): TimelineOp[] {
  const own = t.tracks.find((x) => x.id === clip.trackId && x.kind === clip.item.kind);
  const track =
    own ?? (clip.item.kind === 'video' ? primaryTrack(t) : t.tracks.find((x) => x.kind === clip.item.kind));
  if (!track || track.locked) return [];
  const { id: _id, ...rest } = clip.item;
  if (track.id === primaryTrack(t).id) {
    const item = { ...rest, transitionIn: null } as never;
    return [{ op: 'insert', trackId: track.id, index: primaryIndexAt(t, time), item }];
  }
  const item = { ...rest, start: ms(Math.max(0, time)) } as never;
  return [{ op: 'insert', trackId: track.id, item }];
}

/** `Alt+←/→`: a free item a frame earlier or later, a primary item one place. */
export function nudgeOps(t: Timeline, itemId: string, dir: -1 | 1): TimelineOp[] {
  const found = findItem(t, itemId);
  if (!found || found.track.locked) return [];
  const primary = primaryTrack(t);
  if (found.track.id === primary.id) {
    const index = primary.items.indexOf(found.item) + dir;
    if (index < 0 || index >= primary.items.length) return [];
    return [{ op: 'move', itemId, index }];
  }
  const start = ms(Math.max(0, found.item.start + dir / t.fps));
  if (start === found.item.start) return [];
  if (found.item.kind === 'text') return [{ op: 'update_text', itemId, start }];
  return [{ op: 'move', itemId, start }];
}

/**
 * A dragged item dropped on a track at a time (its new start): the move that puts it there
 * (docs/design/editing-tools.md#moving-items), or nothing when it cannot go there.
 */
export function dropOps(t: Timeline, itemId: string, trackId: string, start: number): TimelineOp[] {
  const found = findItem(t, itemId);
  const target = t.tracks.find((x) => x.id === trackId);
  if (!found || !target || found.track.locked || target.locked) return [];
  if (target.kind !== found.track.kind) return [];
  const primary = primaryTrack(t);
  const time = ms(Math.max(0, start));
  if (target.id === primary.id) {
    // The place the drop's middle falls at, counted without the item itself
    const mid = time + itemDuration(found.item) / 2;
    const others = primary.items.filter((i) => i.id !== itemId);
    const index = others.filter((i) => i.start + itemDuration(i) / 2 < mid).length;
    if (found.track.id === primary.id) {
      if (primary.items.indexOf(found.item) === index) return [];
      return [{ op: 'move', itemId, index }];
    }
    return [{ op: 'move', itemId, trackId, index }];
  }
  if (found.track.id === target.id) {
    if (Math.abs(found.item.start - time) < 1e-3) return [];
    return found.item.kind === 'text'
      ? [{ op: 'update_text', itemId, start: time }]
      : [{ op: 'move', itemId, start: time }];
  }
  return [{ op: 'move', itemId, trackId, start: time }];
}

/** Whether an item may be dragged off its track to another one (text and audio stay among their kind). */
export function dropTargets(t: Timeline, itemId: string): string[] {
  const found = findItem(t, itemId);
  if (!found) return [];
  return t.tracks
    .filter((x) => x.kind === found.track.kind && !x.locked)
    .filter((x) => found.item.kind !== 'video' || isOverlayTrack(t, x) || x.id === primaryTrack(t).id)
    .map((x) => x.id);
}

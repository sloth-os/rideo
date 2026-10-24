import {
  applyOps,
  type CommitSummary,
  emptyTimeline,
  type Item,
  type Timeline,
  type VideoItem,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  dropOps,
  dropTargets,
  nudgeOps,
  pasteOps,
  primaryIndexAt,
  splitTarget,
} from '../src/features/editor/actions';
import {
  HISTORY_LIMIT,
  recordEdit,
  redone,
  redoTarget,
  seedHistory,
  undone,
  undoTarget,
} from '../src/features/editor/history';
import { actionFor, chordLabel, keysOf, SHORTCUTS, typing } from '../src/features/editor/shortcuts';
import { trimOps } from '../src/features/editor/trim';

const commit = (id: string, parent: string | null, paths = ['timeline.json']): CommitSummary => ({
  id,
  parents: parent ? [parent] : [],
  author: { kind: 'user', id: 'usr_000000000001', name: 'Ada' },
  message: 'Edit timeline',
  timestamp: '2026-10-24T09:00:00.000Z',
  changes: paths.map((path) => ({ path, op: 'modify' })) as CommitSummary['changes'],
});

describe('edit history (docs/design/editing-tools.md#undo-and-redo)', () => {
  it('seeds from the last timeline change, records edits and walks back and forth', () => {
    // newest first: a screenplay edit after the last timeline edit c2
    let h = seedHistory([commit('c3', 'c2', ['screenplay.json']), commit('c2', 'c1'), commit('c1', null)]);
    expect(h).toEqual({ undo: ['c1'], redo: [], current: 'c2' });
    h = recordEdit(h, commit('c4', 'c3'));
    expect(h).toEqual({ undo: ['c1', 'c3'], redo: [], current: 'c4' });
    expect(recordEdit(h, null)).toBe(h);
    // undo restores c3 as r1; redo then restores c4 as r2
    expect(undoTarget(h)).toBe('c3');
    h = undone(h, 'r1');
    expect(h).toEqual({ undo: ['c1'], redo: ['c4'], current: 'r1' });
    expect(redoTarget(h)).toBe('c4');
    h = redone(h, 'r2');
    expect(h).toEqual({ undo: ['c1', 'r1'], redo: [], current: 'r2' });
    // a new edit empties redo
    h = undone(h, 'r3');
    h = recordEdit(h, commit('c5', 'r3'));
    expect(h.redo).toEqual([]);
    // nothing to undo: unchanged
    const empty = seedHistory([]);
    expect(undone(empty, null)).toBe(empty);
    expect(redone(empty, null)).toBe(empty);
  });

  it('keeps the last hundred states', () => {
    let h = seedHistory([]);
    for (let i = 0; i < 150; i++) h = recordEdit(h, commit(`c${i + 1}`, `c${i}`));
    expect(h.undo).toHaveLength(HISTORY_LIMIT);
    expect(h.undo[0]).toBe('c50');
  });
});

describe('shortcuts (docs/design/editing-tools.md#shortcuts)', () => {
  const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) =>
    actionFor({
      key: k,
      ctrlKey: !!mods.ctrl,
      metaKey: !!mods.meta,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
    });

  it('maps keys to actions with their modifiers', () => {
    expect(key(' ')).toBe('playPause');
    expect(key('j')).toBe('reverse');
    expect(key('ArrowLeft')).toBe('frameBack');
    expect(key('ArrowLeft', { shift: true })).toBe('secondBack');
    expect(key('ArrowLeft', { alt: true })).toBe('nudgeBack');
    expect(key('ArrowDown')).toBe('nextEdit');
    expect(key('s')).toBe('split');
    expect(key('S', { shift: true })).toBeNull();
    expect(key('k', { ctrl: true })).toBe('split');
    expect(key('b', { meta: true })).toBe('split');
    expect(key('k')).toBe('pause');
    expect(key('z', { ctrl: true })).toBe('undo');
    expect(key('Z', { ctrl: true, shift: true })).toBe('redo');
    expect(key('y', { ctrl: true })).toBe('redo');
    expect(key('m')).toBe('addMarker');
    expect(key('M', { shift: true })).toBe('nextMarker');
    expect(key('M', { meta: true, shift: true })).toBe('previousMarker');
    expect(key('d', { ctrl: true })).toBe('duplicate');
    expect(key('d')).toBeNull();
    // symbols, with or without Shift
    expect(key('+', { shift: true })).toBe('zoomIn');
    expect(key('=')).toBe('zoomIn');
    expect(key('?', { shift: true })).toBe('help');
    expect(key('\\')).toBe('zoomFit');
    expect(key('Escape')).toBe('deselect');
  });

  it('names chords for each platform and every action once', () => {
    expect(chordLabel({ key: 'z', mod: true, shift: true }, false)).toBe('Ctrl+Shift+Z');
    expect(chordLabel({ key: 'z', mod: true, shift: true }, true)).toBe('⌘⇧Z');
    expect(chordLabel({ key: 'ArrowLeft', alt: true }, false)).toBe('Alt+←');
    expect(keysOf('split', false)).toEqual(['S', 'Ctrl+K', 'Ctrl+B']);
    expect(new Set(SHORTCUTS.map((s) => s.action)).size).toBe(SHORTCUTS.length);
    const input = document.createElement('input');
    expect(typing(input)).toBe(true);
    expect(typing(document.body)).toBe(false);
  });
});

describe('editing actions (docs/design/editing-tools.md#the-workflow)', () => {
  const media = f.media({ durationSec: 10 });
  const PRIMARY = 'trk_primaryvideo01';
  const OVERLAY = 'trk_overlay000001';
  function cut(): Timeline {
    return applyOps(emptyTimeline({ fps: 25, width: 320, height: 180 }), [
      {
        op: 'insert',
        trackId: PRIMARY,
        item: { id: 'itm_a00000000001', kind: 'video', source: { type: 'media', media }, in: 0, out: 4 },
      },
      {
        op: 'insert',
        trackId: PRIMARY,
        item: { id: 'itm_b00000000001', kind: 'video', source: { type: 'media', media }, in: 0, out: 2 },
      },
      { op: 'add_track', track: { id: OVERLAY, kind: 'video', name: 'B-roll' } },
      {
        op: 'insert',
        trackId: OVERLAY,
        item: {
          id: 'itm_o00000000001',
          kind: 'video',
          source: { type: 'media', media },
          start: 1,
          in: 0,
          out: 1,
        } as never,
      },
    ]);
  }
  const item = (t: Timeline, id: string) => t.tracks.flatMap((x) => x.items).find((i) => i.id === id) as Item;

  it('pastes at the playhead: its place on the primary track, the playhead elsewhere', () => {
    const t = cut();
    expect(primaryIndexAt(t, 1)).toBe(0);
    expect(primaryIndexAt(t, 3)).toBe(1);
    expect(primaryIndexAt(t, 5.5)).toBe(2);
    const [op] = pasteOps(t, { item: item(t, 'itm_b00000000001'), trackId: PRIMARY }, 3);
    expect(op).toMatchObject({
      op: 'insert',
      trackId: PRIMARY,
      index: 1,
      item: { transitionIn: null, in: 0 },
    });
    expect((op as { item: { id?: string } }).item.id).toBeUndefined();
    const pasted = applyOps(t, [op!]);
    expect(pasted.tracks[0]!.items).toHaveLength(3);
    const [onOverlay] = pasteOps(t, { item: item(t, 'itm_o00000000001'), trackId: OVERLAY }, 2.5);
    expect(onOverlay).toMatchObject({ op: 'insert', trackId: OVERLAY, item: { start: 2.5 } });
    // its track gone: the primary track for video
    const [fallback] = pasteOps(t, { item: item(t, 'itm_o00000000001'), trackId: 'trk_gone00000001' }, 0);
    expect(fallback).toMatchObject({ trackId: PRIMARY, index: 0 });
    const locked = applyOps(t, [{ op: 'set_track', trackId: OVERLAY, locked: true }]);
    expect(pasteOps(locked, { item: item(t, 'itm_o00000000001'), trackId: OVERLAY }, 1)).toEqual([]);
  });

  it('splits the selection or the picture under the playhead, nudges and drops', () => {
    const t = cut();
    expect(splitTarget(t, null, 2)?.id).toBe('itm_a00000000001');
    expect(splitTarget(t, 'itm_o00000000001', 1.5)?.id).toBe('itm_o00000000001');
    expect(splitTarget(t, 'itm_o00000000001', 3)).toBeNull();
    expect(nudgeOps(t, 'itm_o00000000001', 1)).toEqual([
      { op: 'move', itemId: 'itm_o00000000001', start: 1.04 },
    ]);
    expect(nudgeOps(t, 'itm_a00000000001', 1)).toEqual([
      { op: 'move', itemId: 'itm_a00000000001', index: 1 },
    ]);
    expect(nudgeOps(t, 'itm_a00000000001', -1)).toEqual([]);
    // dropping: in time on its track, onto the primary track at a place, off it onto an overlay
    expect(dropOps(t, 'itm_o00000000001', OVERLAY, 3)).toEqual([
      { op: 'move', itemId: 'itm_o00000000001', start: 3 },
    ]);
    expect(dropOps(t, 'itm_o00000000001', PRIMARY, 3.9)).toEqual([
      { op: 'move', itemId: 'itm_o00000000001', trackId: PRIMARY, index: 1 },
    ]);
    expect(dropOps(t, 'itm_a00000000001', PRIMARY, 4.5)).toEqual([
      { op: 'move', itemId: 'itm_a00000000001', index: 1 },
    ]);
    expect(dropOps(t, 'itm_a00000000001', PRIMARY, 0.2)).toEqual([]);
    expect(dropOps(t, 'itm_a00000000001', OVERLAY, 2)).toEqual([
      { op: 'move', itemId: 'itm_a00000000001', trackId: OVERLAY, start: 2 },
    ]);
    expect(dropOps(t, 'itm_a00000000001', 'trk_musicbed000001', 2)).toEqual([]);
    expect(dropTargets(t, 'itm_o00000000001')).toEqual([PRIMARY, OVERLAY]);
    const moved = applyOps(t, dropOps(t, 'itm_a00000000001', OVERLAY, 2));
    expect(item(moved, 'itm_a00000000001').start).toBe(2);
  });

  it('drags a freeze frame’s edges to change how long it holds', () => {
    const t = applyOps(cut(), [{ op: 'freeze_frame', itemId: 'itm_o00000000001', at: 1.5, duration: 2 }]);
    const hold = t.tracks[1]!.items.find((i) => (i as VideoItem).freeze)!;
    expect(trimOps(hold, 'end', 1, true)).toEqual([{ op: 'set_freeze', itemId: hold.id, duration: 3 }]);
    expect(trimOps(hold, 'start', 0.5, true)).toEqual([
      { op: 'set_freeze', itemId: hold.id, duration: 1.5 },
      { op: 'move', itemId: hold.id, start: 2 },
    ]);
    expect(() => applyOps(t, trimOps(hold, 'start', 0.5, true))).not.toThrow();
  });
});

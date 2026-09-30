import { applyOps, emptyTimeline, type Item, newId, primaryTrack } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { trimOps } from '../src/features/editor/trim';

describe('trimOps (timeline edge drag)', () => {
  const media = f.media({ durationSec: 10 });
  const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
  const clip = newId('item');
  const music = newId('item');
  const t = applyOps(base, [
    {
      op: 'insert',
      trackId: primaryTrack(base).id,
      item: { id: clip, kind: 'video', source: { type: 'media', media }, in: 2, out: 6, speed: 2 },
    },
    {
      op: 'insert',
      trackId: base.tracks.find((x) => x.kind === 'audio')!.id,
      item: { id: music, kind: 'audio', source: { type: 'media', media }, start: 3, in: 1, out: 5 },
    },
  ]);
  const item = (id: string) => t.tracks.flatMap((x) => x.items).find((i) => i.id === id) as Item;

  it('scales drag distance by speed and clamps to the media', () => {
    expect(trimOps(item(clip), 'start', 0.5, false)).toEqual([{ op: 'trim', itemId: clip, in: 3 }]);
    expect(trimOps(item(clip), 'end', 10, false)).toEqual([{ op: 'trim', itemId: clip, out: 10 }]);
    expect(trimOps(item(clip), 'start', -5, false)).toEqual([{ op: 'trim', itemId: clip, in: 0 }]);
    expect(trimOps(item(clip), 'end', -5, false)).toEqual([{ op: 'trim', itemId: clip, out: 2.2 }]);
  });

  it('keeps the right edge fixed on free tracks and applies cleanly', () => {
    const ops = trimOps(item(music), 'start', 1, true);
    expect(ops).toEqual([
      { op: 'trim', itemId: music, in: 2 },
      { op: 'move', itemId: music, start: 4 },
    ]);
    const next = applyOps(t, ops);
    const m = next.tracks.flatMap((x) => x.items).find((i) => i.id === music)!;
    expect(m.start + (m.kind === 'audio' ? m.out - m.in : 0)).toBe(7);
  });
});

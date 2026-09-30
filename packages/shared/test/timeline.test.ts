import { describe, expect, it } from 'vitest';
import {
  activeAt,
  applyOps,
  applySuggestions,
  assembleStoryTimeline,
  audioSegments,
  type EditSuggestion,
  emptyTimeline,
  itemDuration,
  keptRanges,
  mapSourceToOutput,
  newId,
  primaryTrack,
  type Timeline,
  TimelineOpError,
  timelineDuration,
  type VideoItem,
  videoSegments,
} from '../src';
import * as f from '../src/testing/fixtures';

function base(): Timeline {
  return emptyTimeline({ fps: 24, width: 320, height: 180 });
}

function videoItem(durationSec = 5, extra: Partial<VideoItem> = {}) {
  return {
    kind: 'video' as const,
    source: { type: 'media' as const, media: f.media({ durationSec }) },
    in: 0,
    out: durationSec,
    ...extra,
  };
}

function withThree(): Timeline {
  const t = base();
  const track = primaryTrack(t).id;
  return applyOps(t, [
    { op: 'insert', trackId: track, item: videoItem(5) },
    { op: 'insert', trackId: track, item: videoItem(4) },
    { op: 'insert', trackId: track, item: videoItem(6) },
  ]);
}

describe('timeline ops', () => {
  it('lays out the primary track magnetically', () => {
    const t = withThree();
    const items = primaryTrack(t).items;
    expect(items.map((i) => i.start)).toEqual([0, 5, 9]);
    expect(timelineDuration(t)).toBe(15);
  });

  it('inserts at an index and ripples', () => {
    const t0 = withThree();
    const t = applyOps(t0, [{ op: 'insert', trackId: primaryTrack(t0).id, item: videoItem(2), index: 0 }]);
    expect(primaryTrack(t).items.map((i) => i.start)).toEqual([0, 2, 7, 11]);
  });

  it('removes with ripple and drops the transition of a new first item', () => {
    const t0 = withThree();
    const [a, b] = primaryTrack(t0).items;
    const t1 = applyOps(t0, [
      { op: 'set_transition', itemId: b!.id, transition: { type: 'crossfade', duration: 1 } },
    ]);
    expect(primaryTrack(t1).items[1]!.start).toBe(4);
    const t2 = applyOps(t1, [{ op: 'remove', itemId: a!.id }]);
    const first = primaryTrack(t2).items[0] as VideoItem;
    expect(first.id).toBe(b!.id);
    expect(first.transitionIn).toBeNull();
    expect(first.start).toBe(0);
  });

  it('reorders by index', () => {
    const t0 = withThree();
    const ids = primaryTrack(t0).items.map((i) => i.id);
    const t = applyOps(t0, [{ op: 'move', itemId: ids[2]!, index: 0 }]);
    expect(primaryTrack(t).items.map((i) => i.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(primaryTrack(t).items.map((i) => i.start)).toEqual([0, 6, 11]);
  });

  it('trims within media bounds', () => {
    const t0 = withThree();
    const id = primaryTrack(t0).items[0]!.id;
    const t = applyOps(t0, [{ op: 'trim', itemId: id, in: 1, out: 3 }]);
    expect(itemDuration(primaryTrack(t).items[0]!)).toBe(2);
    expect(() => applyOps(t0, [{ op: 'trim', itemId: id, out: 9 }])).toThrow(TimelineOpError);
    expect(() => applyOps(t0, [{ op: 'trim', itemId: id, in: 3, out: 2 }])).toThrow(/greater than in/);
  });

  it('splits at the playhead into two contiguous items', () => {
    const t0 = withThree();
    const id = primaryTrack(t0).items[1]!.id;
    const t = applyOps(t0, [{ op: 'split', itemId: id, at: 6.5 }]);
    const items = primaryTrack(t).items as VideoItem[];
    expect(items).toHaveLength(4);
    expect(items[1]!.out).toBeCloseTo(1.5);
    expect(items[2]!.in).toBeCloseTo(1.5);
    expect(items[2]!.start).toBeCloseTo(6.5);
    expect(timelineDuration(t)).toBe(15);
    expect(() => applyOps(t0, [{ op: 'split', itemId: id, at: 100 }])).toThrow(/outside item/);
  });

  it('splits respecting speed', () => {
    const t0 = withThree();
    const id = primaryTrack(t0).items[0]!.id;
    const t1 = applyOps(t0, [{ op: 'set_speed', itemId: id, speed: 2 }]);
    expect(itemDuration(primaryTrack(t1).items[0]!)).toBe(2.5);
    const t2 = applyOps(t1, [{ op: 'split', itemId: id, at: 1 }]);
    const [a, b] = primaryTrack(t2).items as VideoItem[];
    expect(a!.out).toBeCloseTo(2);
    expect(b!.in).toBeCloseTo(2);
  });

  it('rejects transitions longer than half the shorter neighbour and on the first item', () => {
    const t0 = withThree();
    const [a, b] = primaryTrack(t0).items;
    expect(() =>
      applyOps(t0, [{ op: 'set_transition', itemId: b!.id, transition: { type: 'wipe', duration: 3 } }]),
    ).toThrow(/exceeds half/);
    const t = applyOps(t0, [
      { op: 'set_transition', itemId: a!.id, transition: { type: 'crossfade', duration: 1 } },
    ]);
    expect((primaryTrack(t).items[0] as VideoItem).transitionIn).toBeNull();
  });

  it('is atomic: a failing op leaves the input untouched', () => {
    const t0 = withThree();
    const before = JSON.stringify(t0);
    expect(() =>
      applyOps(t0, [
        { op: 'set_speed', itemId: primaryTrack(t0).items[0]!.id, speed: 2 },
        { op: 'remove', itemId: newId('item') },
      ]),
    ).toThrow(TimelineOpError);
    expect(JSON.stringify(t0)).toBe(before);
  });

  it('reports the failing op index', () => {
    const t0 = withThree();
    try {
      applyOps(t0, [
        { op: 'set_speed', itemId: primaryTrack(t0).items[0]!.id, speed: 2 },
        { op: 'remove', itemId: newId('item') },
      ]);
      expect.unreachable();
    } catch (e) {
      expect((e as TimelineOpError).opIndex).toBe(1);
    }
  });

  it('manages text, audio tracks, fades, effects, volume and output', () => {
    const t0 = withThree();
    const audioTrack = t0.tracks.find((tr) => tr.kind === 'audio')!;
    const id = primaryTrack(t0).items[0]!.id;
    const t = applyOps(t0, [
      {
        op: 'add_text',
        item: { kind: 'text', start: 1, duration: 2, text: 'Hello', style: { preset: 'title' } },
      },
      {
        op: 'insert',
        trackId: audioTrack.id,
        item: {
          kind: 'audio',
          source: { type: 'media', media: f.media({ durationSec: 30, mime: 'audio/mpeg' }) },
          start: 0,
          in: 0,
          out: 15,
        },
      },
      { op: 'set_fades', itemId: id, fadeIn: 1, fadeOut: 1 },
      { op: 'set_effects', itemId: id, effects: { brightness: 0.1 } },
      { op: 'set_volume', itemId: id, volume: 0.5, muted: true },
      { op: 'set_track', trackId: audioTrack.id, volume: 0.8 },
      { op: 'set_output', fps: 30 },
      { op: 'add_track', track: { kind: 'audio', name: 'VO' } },
    ]);
    expect(t.fps).toBe(30);
    expect(t.tracks).toHaveLength(4);
    const v = primaryTrack(t).items[0] as VideoItem;
    expect(v.effects?.brightness).toBe(0.1);
    expect(v.muted).toBe(true);
    const text = t.tracks.find((tr) => tr.kind === 'text')!.items[0]!;
    const t2 = applyOps(t, [{ op: 'update_text', itemId: text.id, text: 'World', start: 3 }]);
    expect(t2.tracks.find((tr) => tr.kind === 'text')!.items[0]).toMatchObject({ text: 'World', start: 3 });
    expect(() => applyOps(t, [{ op: 'remove_track', trackId: primaryTrack(t).id }])).toThrow(
      /cannot be removed/,
    );
    expect(() => applyOps(t, [{ op: 'set_fades', itemId: id, fadeIn: 3, fadeOut: 3 }])).toThrow(
      /longer than the item/,
    );
  });

  it('rejects inserting an item into a track of another kind', () => {
    const t0 = base();
    const audio = t0.tracks.find((tr) => tr.kind === 'audio')!;
    expect(() => applyOps(t0, [{ op: 'insert', trackId: audio.id, item: videoItem(2) }])).toThrow(
      /cannot insert/,
    );
  });

  it('replaces a source and clamps to the new media', () => {
    const t0 = withThree();
    const id = primaryTrack(t0).items[2]!.id;
    const t = applyOps(t0, [
      { op: 'replace_source', itemId: id, source: { type: 'media', media: f.media({ durationSec: 3 }) } },
    ]);
    const item = primaryTrack(t).items[2] as VideoItem;
    expect(item.out).toBeLessThanOrEqual(3);
    expect(item.out - item.in).toBe(3);
  });
});

describe('timeline queries', () => {
  it('computes crossfade layers and audio crossfades', () => {
    const t0 = withThree();
    const b = primaryTrack(t0).items[1]!;
    const t = applyOps(t0, [
      { op: 'set_transition', itemId: b.id, transition: { type: 'crossfade', duration: 2 } },
    ]);
    const mid = activeAt(t, 4); // transition runs 3..5
    expect(mid.video).toHaveLength(2);
    expect(mid.video[1]!.opacity).toBeCloseTo(0.5);
    expect(mid.video[0]!.sourceTime).toBeCloseTo(4);
    expect(mid.video[1]!.sourceTime).toBeCloseTo(1);
    expect(mid.audio.map((a) => a.gain)).toEqual([expect.closeTo(0.5), expect.closeTo(0.5)]);
    expect(activeAt(t, 2).video).toHaveLength(1);
    expect(activeAt(t, 5.5).video).toHaveLength(1);
  });

  it('dips to black through the midpoint', () => {
    const t0 = withThree();
    const b = primaryTrack(t0).items[1]!;
    const t = applyOps(t0, [
      { op: 'set_transition', itemId: b.id, transition: { type: 'dip_to_black', duration: 2 } },
    ]);
    expect(activeAt(t, 3.5).video[0]!.dim).toBeCloseTo(0.5);
    expect(activeAt(t, 4).video[0]!.dim).toBeCloseTo(0);
    expect(activeAt(t, 4.5).video[0]!.dim).toBeCloseTo(0.5);
  });

  it('reveals wipes from the left and applies fades', () => {
    const t0 = withThree();
    const [a, b] = primaryTrack(t0).items;
    const t = applyOps(t0, [
      { op: 'set_transition', itemId: b!.id, transition: { type: 'wipe', duration: 1 } },
      { op: 'set_fades', itemId: a!.id, fadeIn: 2 },
    ]);
    expect(activeAt(t, 4.5).video[1]!.wipe).toBeCloseTo(0.5);
    expect(activeAt(t, 1).video[0]!.dim).toBeCloseTo(0.5);
  });

  it('exports video and audio segments with transition crossfades', () => {
    const t0 = withThree();
    const b = primaryTrack(t0).items[1]!;
    const t = applyOps(t0, [
      { op: 'set_transition', itemId: b.id, transition: { type: 'crossfade', duration: 1 } },
    ]);
    const vs = videoSegments(t);
    expect(vs[1]!.transitionIn?.duration).toBe(1);
    const as = audioSegments(t);
    expect(as[0]!.fadeOut).toBe(1);
    expect(as[1]!.fadeIn).toBe(1);
  });
});

describe('assembleStoryTimeline', () => {
  it('uses selected takes of approved clips with scene crossfades, music and captions', () => {
    const mira = f.character();
    const s1 = f.readyShot([mira], {
      index: 0,
      dialogue: [{ characterId: mira.id, line: 'Who sent this?' }],
    });
    const s2 = f.readyShot([mira], { index: 1 });
    const s3 = f.readyShot([mira], { index: 0 });
    const c1 = f.clip({ index: 0, status: 'approved', shots: [s1, s2] });
    const c2 = f.clip({ index: 1, status: 'approved', shots: [s3] });
    const draft = f.clip({ index: 2, status: 'review', shots: [f.readyShot([mira])] });
    const t = assembleStoryTimeline({
      clips: [c2, draft, c1],
      fps: 24,
      width: 320,
      height: 180,
      characters: { [mira.id]: mira },
      music: { media: f.media({ durationSec: 8, mime: 'audio/mpeg' }), resourceId: newId('resource') },
      captions: true,
    });
    const items = primaryTrack(t).items as VideoItem[];
    expect(items).toHaveLength(3);
    expect(items[0]!.source).toMatchObject({ type: 'take', clipId: c1.id, shotId: s1.id });
    expect(items[1]!.transitionIn).toBeNull();
    expect(items[2]!.transitionIn).toEqual({ type: 'crossfade', duration: 0.5 });
    expect(timelineDuration(t)).toBeCloseTo(14.5);
    const music = t.tracks.find((tr) => tr.kind === 'audio')!.items;
    expect(music).toHaveLength(2);
    const captions = t.tracks.find((tr) => tr.kind === 'text')!.items;
    expect(captions[0]).toMatchObject({ text: 'Mira: Who sent this?' });
  });
});

describe('applySuggestions', () => {
  const sug = (
    params: EditSuggestion['params'],
    status: EditSuggestion['status'] = 'accepted',
  ): EditSuggestion => ({
    id: newId('suggestion'),
    source: 'rules',
    description: params.kind,
    rationale: '',
    confidence: 0.9,
    params,
    status,
  });

  it('computes kept ranges from cuts, silences and highlights', () => {
    expect(
      keptRanges(20, [
        sug({ kind: 'cut', start: 0, end: 2 }),
        sug({ kind: 'tighten_silence', start: 10, end: 14, keepSec: 0.4 }),
      ]),
    ).toEqual([
      { start: 2, end: 10.2 },
      { start: 13.8, end: 20 },
    ]);
    expect(
      keptRanges(20, [
        sug({
          kind: 'highlight',
          segments: [
            { start: 5, end: 8 },
            { start: 12, end: 13 },
          ],
        }),
      ]),
    ).toEqual([
      { start: 5, end: 8 },
      { start: 12, end: 13 },
    ]);
  });

  it('builds a timeline with speed, transitions, titles, captions, fades, colour and music', () => {
    const source = f.media({ durationSec: 30 });
    const musicId = newId('resource');
    const t = applySuggestions({
      source: { media: source },
      durationSec: 30,
      fps: 24,
      width: 320,
      height: 180,
      music: { [musicId]: f.media({ durationSec: 100, mime: 'audio/mpeg' }) },
      suggestions: [
        sug({ kind: 'cut', start: 0, end: 3 }),
        sug({ kind: 'cut', start: 10, end: 12 }),
        sug({ kind: 'speed', start: 20, end: 24, factor: 2 }),
        sug({ kind: 'transition', at: 12, type: 'crossfade', duration: 0.5 }),
        sug({ kind: 'title', text: 'Morning', start: 3, duration: 2 }),
        sug({ kind: 'caption', start: 14, end: 16, text: 'hello there' }),
        sug({ kind: 'fade', in: 1, out: 1 }),
        sug({ kind: 'color', saturation: 1.2 }),
        sug({ kind: 'music', resourceId: musicId, volume: 0.25 }),
        sug({ kind: 'cut', start: 25, end: 30 }, 'rejected'),
      ],
    });
    const items = primaryTrack(t).items as VideoItem[];
    expect(items.map((i) => [i.in, i.out, i.speed])).toEqual([
      [3, 10, 1],
      [12, 20, 1],
      [20, 24, 2],
      [24, 30, 1],
    ]);
    expect(items[1]!.transitionIn).toEqual({ type: 'crossfade', duration: 0.5 });
    expect(items[0]!.fadeIn).toBe(1);
    expect(items[3]!.fadeOut).toBe(1);
    expect(items[0]!.effects?.saturation).toBe(1.2);
    const texts = t.tracks.find((tr) => tr.kind === 'text')!.items;
    expect(texts.map((x) => (x as { text: string }).text)).toEqual(['Morning', 'hello there']);
    expect(texts[0]!.start).toBe(0);
    expect(t.tracks.find((tr) => tr.kind === 'audio')!.items).toHaveLength(1);
    expect(mapSourceToOutput(items, 11)).toBeCloseTo(items[1]!.start);
    expect(mapSourceToOutput(items, 40)).toBeNull();
  });
});

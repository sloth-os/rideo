import { describe, expect, it } from 'vitest';
import {
  type AudioItem,
  activeAt,
  adjustmentFilters,
  applyAdjustments,
  applyKey,
  applyOps,
  audioSegments,
  channelGains,
  chunkGraph,
  circleStops,
  circleWeight,
  dipWeights,
  editPoints,
  emptyTimeline,
  exportCut,
  fromOtio,
  gainTable,
  hueMatrix,
  type InterchangeContext,
  itemDuration,
  keyAlpha,
  lrint,
  type MediaRef,
  nextEditPoint,
  overlaySegments,
  planChunks,
  previousEditPoint,
  primaryTrack,
  renderInputs,
  type Source,
  slideOffsets,
  snapSpan,
  snapTargets,
  snapTime,
  sourceTimeAt,
  type Timeline,
  type TimelineOp,
  TimelineOpSchema,
  type TransitionType,
  timelineDuration,
  toEdl,
  toFcpxml,
  toneTable,
  toXmeml,
  type VideoItem,
  videoSegments,
  vignetteFactor,
  wipeEdge,
} from '../src';
import * as f from '../src/testing/fixtures';

const footage = (name: string, over: Partial<MediaRef> = {}): MediaRef =>
  f.media({
    path: `media/uploads/${name}.mp4`,
    durationSec: 10,
    hasAudio: true,
    width: 1920,
    height: 1080,
    ...over,
  });
let n = 0;
const gen = (k: 'item' | 'track' | 'marker') =>
  `${k === 'item' ? 'itm' : k === 'track' ? 'trk' : 'mrk'}_${String(++n).padStart(12, '0')}`;
const apply = (t: Timeline, ops: TimelineOp[]) => applyOps(t, ops, { newId: gen });
const PRIMARY = 'trk_primaryvideo01';
const MUSIC = 'trk_musicbed000001';
const TITLES = 'trk_titles00000001';
const OVERLAY = 'trk_overlay000001';
const OVERLAY2 = 'trk_overlay000002';

/** Two primary items (A 0–4 s of a, B 2–8 s of b), an overlay item (5–7 s), music and a title. */
function cut(): Timeline {
  return apply(emptyTimeline({ fps: 24, width: 1280, height: 720 }), [
    {
      op: 'insert',
      trackId: PRIMARY,
      item: {
        id: 'itm_a00000000001',
        kind: 'video',
        source: { type: 'media', media: footage('a') },
        in: 0,
        out: 4,
      },
    },
    {
      op: 'insert',
      trackId: PRIMARY,
      item: {
        id: 'itm_b00000000001',
        kind: 'video',
        source: { type: 'media', media: footage('b') },
        in: 2,
        out: 8,
      },
    },
    { op: 'add_track', track: { id: OVERLAY, kind: 'video', name: 'B-roll' } },
    { op: 'add_track', track: { id: OVERLAY2, kind: 'video', name: 'B-roll 2' } },
    {
      op: 'insert',
      trackId: OVERLAY,
      item: {
        id: 'itm_o00000000001',
        kind: 'video',
        source: { type: 'media', media: footage('o') },
        start: 5,
        in: 1,
        out: 3,
      } as never,
    },
    {
      op: 'insert',
      trackId: MUSIC,
      item: {
        id: 'itm_m00000000001',
        kind: 'audio',
        source: {
          type: 'media',
          media: f.media({ path: 'media/music/bed.mp3', mime: 'audio/mpeg', durationSec: 60 }),
        },
        start: 0,
        in: 0,
        out: 30,
      },
    },
    {
      op: 'add_text',
      item: { kind: 'text', text: 'Opening', start: 0, duration: 2, style: { preset: 'caption' } },
    },
  ]);
}
const A = 'itm_a00000000001';
const B = 'itm_b00000000001';
const O = 'itm_o00000000001';
const items = (t: Timeline, trackId: string) => t.tracks.find((x) => x.id === trackId)!.items;
const video = (t: Timeline, id: string) =>
  t.tracks.flatMap((x) => x.items).find((x) => x.id === id) as VideoItem | undefined;

describe('markers (docs/design/editing-tools.md#markers)', () => {
  it('adds, edits and removes markers, kept in time order, and an intro moves them later', () => {
    let t = apply(cut(), [
      { op: 'add_marker', marker: { t: 6, label: 'Beat' } },
      { op: 'add_marker', marker: { id: 'mrk_000000000late', t: 9, color: 'red' } },
      { op: 'add_marker', marker: { t: 1 } },
    ]);
    expect(t.markers!.map((m) => [m.t, m.label, m.color])).toEqual([
      [1, '', 'orange'],
      [6, 'Beat', 'orange'],
      [9, '', 'red'],
    ]);
    expect(t.markers![0]!.id).toMatch(/^mrk_/);
    t = apply(t, [
      { op: 'update_marker', markerId: 'mrk_000000000late', t: 0.5, label: 'Cold open', color: 'cyan' },
    ]);
    expect(t.markers![0]).toEqual({ id: 'mrk_000000000late', t: 0.5, label: 'Cold open', color: 'cyan' });
    expect(() => apply(t, [{ op: 'add_marker', marker: { id: 'mrk_000000000late', t: 2 } }])).toThrow(
      'duplicate marker id',
    );
    expect(() => apply(t, [{ op: 'remove_marker', markerId: 'mrk_000000missing' }])).toThrow('not found');
    // Markers stay put when the picture ripples
    const rippled = apply(t, [{ op: 'remove', itemId: A }]);
    expect(rippled.markers!.map((m) => m.t)).toEqual([0.5, 1, 6]);
    // An intro bumper moves everything later, markers too
    const bumper = footage('intro', { durationSec: 2 });
    const withIntro = apply(t, [
      { op: 'add_bumper', position: 'intro', source: { type: 'media', media: bumper }, durationSec: 2 },
    ]);
    expect(withIntro.markers!.map((m) => m.t)).toEqual([2.5, 3, 8]);
    // The last one removed leaves no markers field
    const none = apply(
      t,
      t.markers!.map((m) => ({ op: 'remove_marker', markerId: m.id }) as TimelineOp),
    );
    expect(none.markers).toBeUndefined();
    // At most 1000
    const full = {
      ...t,
      markers: Array.from({ length: 1000 }, (_, i) => ({
        id: `mrk_${String(i).padStart(12, '0')}`,
        t: i,
        label: '',
        color: 'orange' as const,
      })),
    };
    expect(() => apply(full, [{ op: 'add_marker', marker: { t: 1 } }])).toThrow('at most 1000 markers');
  });

  it('validates markers at the boundary', () => {
    expect(TimelineOpSchema.safeParse({ op: 'add_marker', marker: { t: -1 } }).success).toBe(false);
    expect(TimelineOpSchema.safeParse({ op: 'add_marker', marker: { t: 1, color: 'pink' } }).success).toBe(
      false,
    );
    expect(
      TimelineOpSchema.safeParse({ op: 'add_marker', marker: { t: 1, label: 'x'.repeat(201) } }).success,
    ).toBe(false);
  });
});

describe('track controls (docs/design/editing-tools.md#track-controls)', () => {
  it('a locked track refuses every change to its items, and caption styles skip it', () => {
    const t = apply(cut(), [{ op: 'set_track', trackId: PRIMARY, locked: true }]);
    expect(t.tracks[0]!.locked).toBe(true);
    const refused: TimelineOp[] = [
      { op: 'remove', itemId: A },
      { op: 'move', itemId: A, index: 1 },
      { op: 'trim', itemId: A, out: 3 },
      { op: 'split', itemId: A, at: 2 },
      { op: 'set_speed', itemId: A, speed: 2 },
      { op: 'set_volume', itemId: A, volume: 0.5 },
      { op: 'set_effects', itemId: A, effects: { exposure: 1 } },
      { op: 'duplicate', itemId: A },
      { op: 'freeze_frame', itemId: A, at: 1 },
      { op: 'detach_audio', itemId: A },
      { op: 'set_flip', itemId: A, flip: { x: true } },
      { op: 'set_key', itemId: A, key: { color: '#00ff00', similarity: 0.3, blend: 0.1 } },
      { op: 'move', itemId: O, trackId: PRIMARY, index: 0 },
      {
        op: 'insert',
        trackId: PRIMARY,
        item: { kind: 'video', source: { type: 'media', media: footage('c') }, in: 0, out: 1 },
      },
      {
        op: 'add_bumper',
        position: 'outro',
        source: { type: 'media', media: footage('outro', { durationSec: 2 }) },
        durationSec: 2,
      },
    ];
    for (const op of refused) expect(() => apply(t, [op]), op.op).toThrow('track "Video" is locked');
    // Other tracks still change; unlocking frees it
    expect(apply(t, [{ op: 'move', itemId: O, start: 1 }]).tracks[1]!.items[0]!.start).toBe(1);
    const unlocked = apply(t, [{ op: 'set_track', trackId: PRIMARY, locked: false }]);
    expect(unlocked.tracks[0]!.locked).toBeUndefined();
    expect(() => apply(unlocked, [{ op: 'remove', itemId: A }])).not.toThrow();
    // A locked track cannot be removed; caption styles leave its items alone
    const titles = apply(cut(), [{ op: 'set_track', trackId: TITLES, locked: true }]);
    expect(() => apply(titles, [{ op: 'remove_track', trackId: TITLES }])).toThrow('is locked');
    const styled = apply(titles, [{ op: 'set_caption_style', style: { color: '#ff0000' } }]);
    expect(styled).toEqual(titles);
    const free = apply(cut(), [{ op: 'set_caption_style', style: { color: '#ff0000' } }]);
    expect((items(free, TITLES)[0] as { style: { color?: string } }).style.color).toBe('#ff0000');
  });

  it('hides video tracks: a hidden primary track is black, hidden overlays are left out; their sound plays', () => {
    const t = cut();
    expect(() => apply(t, [{ op: 'set_track', trackId: MUSIC, hidden: true }])).toThrow(
      'only video tracks hide',
    );
    const hiddenPrimary = apply(t, [{ op: 'set_track', trackId: PRIMARY, hidden: true }]);
    const at1 = activeAt(hiddenPrimary, 1);
    expect(at1.video).toEqual([]);
    expect(at1.audio.map((a) => a.item.id)).toContain(A);
    expect(videoSegments(hiddenPrimary)).toEqual([]);
    expect(audioSegments(hiddenPrimary).some((s) => s.itemId === A)).toBe(true);
    const at6 = activeAt(hiddenPrimary, 6);
    expect(at6.video.map((l) => l.item.id)).toEqual([O]);
    const hiddenOverlay = apply(t, [{ op: 'set_track', trackId: OVERLAY, hidden: true }]);
    expect(activeAt(hiddenOverlay, 6).video.map((l) => l.item.id)).toEqual([B]);
    expect(activeAt(hiddenOverlay, 6).audio.map((a) => a.item.id)).toContain(O);
    expect(overlaySegments(hiddenOverlay).flatMap((o) => o.segments)).toEqual([]);
    expect(renderInputs(hiddenOverlay).some((m) => m.path.endsWith('/o.mp4'))).toBe(true);
    // the render plan draws a hidden primary track as black
    const [chunk] = planChunks(hiddenPrimary, { targetSec: 60 });
    const g = chunkGraph(hiddenPrimary, chunk!, {
      quality: 'standard',
      inputPath: (m) => `/in/${m.path.split('/').at(-1)}`,
      textPath: (i) => `/text/t${i}.txt`,
    });
    const graph = g.args[g.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('color=c=black:s=1280x720');
    expect(g.args).not.toContain('/in/a.mp4');
  });
});

describe('moving, duplicating (docs/design/editing-tools.md#moving-items)', () => {
  it('moves items between tracks of the same kind', () => {
    let t = apply(cut(), [{ op: 'move', itemId: O, trackId: OVERLAY2, start: 3 }]);
    expect(items(t, OVERLAY)).toEqual([]);
    expect(items(t, OVERLAY2)[0]).toMatchObject({ id: O, start: 3 });
    // onto the primary track at an index: it ripples
    t = apply(t, [{ op: 'move', itemId: O, trackId: PRIMARY, index: 1 }]);
    expect(items(t, PRIMARY).map((x) => [x.id, x.start])).toEqual([
      [A, 0],
      [O, 4],
      [B, 6],
    ]);
    // off the primary track: the rest closes up and the item drops its transition
    t = apply(t, [
      { op: 'set_transition', itemId: O, transition: { type: 'crossfade', duration: 0.5 } },
      { op: 'move', itemId: O, trackId: OVERLAY, start: 8 },
    ]);
    expect(items(t, PRIMARY).map((x) => [x.id, x.start])).toEqual([
      [A, 0],
      [B, 4],
    ]);
    expect(video(t, O)).toMatchObject({ start: 8, transitionIn: null });
    // kinds stay apart; the target needs its index or start
    expect(() => apply(t, [{ op: 'move', itemId: O, trackId: MUSIC, start: 1 }])).toThrow(
      'a video item cannot move to a audio track',
    );
    expect(() => apply(t, [{ op: 'move', itemId: O, trackId: PRIMARY }])).toThrow('needs index');
    expect(() => apply(t, [{ op: 'move', itemId: A, trackId: OVERLAY2 }])).toThrow('needs start');
  });

  it('duplicates after the item: the next place on the primary track, its end elsewhere', () => {
    const t = apply(cut(), [
      { op: 'set_transition', itemId: B, transition: { type: 'crossfade', duration: 1 } },
      { op: 'duplicate', itemId: B },
      { op: 'duplicate', itemId: O },
    ]);
    const primary = items(t, PRIMARY) as VideoItem[];
    expect(primary).toHaveLength(3);
    expect(primary[2]).toMatchObject({ in: 2, out: 8, transitionIn: null, start: 9 });
    expect(primary[2]!.id).not.toBe(B);
    expect(items(t, OVERLAY).map((x) => x.start)).toEqual([5, 7]);
  });
});

describe('freeze frames (docs/design/editing-tools.md#freeze-frame)', () => {
  it('splits the item and holds the frame shown there; the freeze is silent and keeps the look', () => {
    const t0 = apply(cut(), [
      { op: 'set_effects', itemId: A, effects: { exposure: 0.5 } },
      { op: 'set_flip', itemId: A, flip: { x: true } },
      { op: 'set_fades', itemId: A, fadeIn: 0.5 },
    ]);
    const t = apply(t0, [{ op: 'freeze_frame', itemId: A, at: 1.5 }]);
    const [a1, hold, a2, b] = items(t, PRIMARY) as VideoItem[];
    expect(a1).toMatchObject({ id: A, start: 0, in: 0, out: 1.5, fadeIn: 0.5 });
    expect(hold).toMatchObject({ start: 1.5, in: 1.5, freeze: { duration: 2 }, flip: { x: true } });
    expect(hold!.out).toBeCloseTo(1.54);
    expect(hold!.effects).toEqual({ exposure: 0.5 });
    expect(hold!.fadeIn).toBeUndefined();
    expect(itemDuration(hold!)).toBe(2);
    expect(a2).toMatchObject({ start: 3.5, in: 1.5, out: 4 });
    expect(b!.start).toBe(6);
    expect(b!.start + itemDuration(b!)).toBe(12);
    expect(timelineDuration(t)).toBe(30);
    // the frame at `in` for the whole hold, no sound
    expect(sourceTimeAt(hold!, 2)).toBe(1.5);
    expect(sourceTimeAt(hold!, 3.4)).toBe(1.5);
    const mid = activeAt(t, 2.5);
    expect(mid.video.map((l) => [l.item.id, l.sourceTime])).toEqual([[hold!.id, 1.5]]);
    expect(mid.audio.map((a) => a.item.id)).toEqual(['itm_m00000000001']);
    expect(audioSegments(t).some((s) => s.itemId === hold!.id)).toBe(false);
  });

  it('freezes at either end, on free tracks without rippling them, and edits a freeze', () => {
    const atStart = apply(cut(), [{ op: 'freeze_frame', itemId: A, at: 0, duration: 1 }]);
    expect((items(atStart, PRIMARY) as VideoItem[]).map((x) => [x.start, x.in, x.freeze?.duration])).toEqual([
      [0, 0, 1],
      [1, 0, undefined],
      [5, 2, undefined],
    ]);
    // before an item with a transition, the hold takes the transition into it
    const intoB = apply(cut(), [
      { op: 'set_transition', itemId: B, transition: { type: 'crossfade', duration: 0.5 } },
      { op: 'freeze_frame', itemId: B, at: 3.5, duration: 1 },
    ]);
    expect(
      (items(intoB, PRIMARY) as VideoItem[]).map((x) => [x.start, x.freeze?.duration, x.transitionIn?.type]),
    ).toEqual([
      [0, undefined, undefined],
      [3.5, 1, 'crossfade'],
      [4.5, undefined, undefined],
    ]);
    const atEnd = apply(cut(), [{ op: 'freeze_frame', itemId: A, at: 4, duration: 1 }]);
    const endHold = items(atEnd, PRIMARY)[1] as VideoItem;
    expect(endHold).toMatchObject({ start: 4, freeze: { duration: 1 } });
    expect(endHold.in).toBeCloseTo(3.999);
    // an overlay: the second half moves later by the hold
    let t = apply(cut(), [{ op: 'freeze_frame', itemId: O, at: 6, duration: 1.5 }]);
    expect((items(t, OVERLAY) as VideoItem[]).map((x) => [x.start, x.in, x.out, x.freeze?.duration])).toEqual(
      [
        [5, 1, 2, undefined],
        [6, 2, 2.04, 1.5],
        [7.5, 2, 3, undefined],
      ],
    );
    const hold = items(t, OVERLAY)[1] as VideoItem;
    // its length, its frame; no speed, no ramp, no out
    t = apply(t, [
      { op: 'set_freeze', itemId: hold.id, duration: 3 },
      { op: 'trim', itemId: hold.id, in: 2.5 },
    ]);
    expect(video(t, hold.id)).toMatchObject({ in: 2.5, freeze: { duration: 3 } });
    expect(video(t, hold.id)!.out).toBeCloseTo(2.54);
    expect(() => apply(t, [{ op: 'set_speed', itemId: hold.id, speed: 2 }])).toThrow('no speed');
    expect(() => apply(t, [{ op: 'trim', itemId: hold.id, out: 3 }])).toThrow('use set_freeze');
    expect(() => apply(t, [{ op: 'freeze_frame', itemId: hold.id, at: 7 }])).toThrow('freeze frame already');
    expect(() => apply(t, [{ op: 'set_freeze', itemId: O, duration: 2 }])).toThrow(
      'applies to freeze frames',
    );
    const matte = f.media({ path: 'media/masks/m.mp4', durationSec: 10, hasAudio: false });
    expect(() =>
      apply(t, [{ op: 'set_mask', itemId: hold.id, mask: { media: matte, offset: 0 } } as TimelineOp]),
    ).toThrow('no mask');
    // a split gives two holds of the same frame
    const split = apply(t, [{ op: 'split', itemId: hold.id, at: 7 }]);
    expect(
      (items(split, OVERLAY) as VideoItem[])
        .filter((x) => x.freeze)
        .map((x) => [x.start, x.in, x.freeze!.duration]),
    ).toEqual([
      [6, 2.5, 1],
      [7, 2.5, 2],
    ]);
    // a still is one frame already
    const still = apply(cut(), [
      {
        op: 'insert',
        trackId: PRIMARY,
        item: {
          id: 'itm_still0000001',
          kind: 'video',
          source: { type: 'media', media: f.imageMedia({ path: 'media/boards/frame.png' }) },
          in: 0,
          out: 3,
        },
      },
    ]);
    expect(() => apply(still, [{ op: 'freeze_frame', itemId: 'itm_still0000001', at: 11 }])).toThrow(
      'already a single frame',
    );
  });

  it('renders the hold from one frame, cloned for its part of the chunk', () => {
    const t = apply(cut(), [{ op: 'freeze_frame', itemId: A, at: 1.5 }]);
    const [chunk] = planChunks(t, { targetSec: 60 });
    const g = chunkGraph(t, chunk!, {
      quality: 'standard',
      inputPath: (m) => `/in/${m.path.split('/').at(-1)}`,
      textPath: (i) => `/text/t${i}.txt`,
    });
    const graph = g.args[g.args.indexOf('-filter_complex') + 1]!;
    // seeked to 0.5 (a second early, whole milliseconds); the frame at 1.5 is 1 s in
    expect(g.args.join(' ')).toContain('-ss 0.5 -t 1.45 -i /in/a.mp4');
    expect(graph).toContain(
      "trim=start=0.9:end=1.2,select='lte(t\\,1.0001)+eq(n\\,0)',reverse,trim=end_frame=1,setpts=PTS-STARTPTS,",
    );
    expect(graph).toContain('fps=24,tpad=stop_mode=clone:stop=47,trim=end_frame=48,format=yuv420p');
  });
});

describe('detach audio (docs/design/editing-tools.md#detach-audio)', () => {
  it('moves the sound of a video item to an audio item at the same time and mutes the picture', () => {
    const t0 = apply(cut(), [
      { op: 'set_volume', itemId: A, volume: 0.8 },
      { op: 'set_fades', itemId: A, fadeOut: 0.5 },
    ]);
    const t = apply(t0, [{ op: 'detach_audio', itemId: A }]);
    const sound = t.tracks.at(-1)!;
    expect(sound).toMatchObject({ kind: 'audio', name: 'Sound', role: 'dialogue' });
    expect(sound.items[0]).toMatchObject({
      kind: 'audio',
      start: 0,
      in: 0,
      out: 4,
      volume: 0.8,
      fadeOut: 0.5,
    } satisfies Partial<AudioItem>);
    expect((sound.items[0] as AudioItem).source).toEqual(video(t0, A)!.source);
    expect(video(t, A)!.muted).toBe(true);
    // the same sound, now from the audio item
    const before = audioSegments(t0).find((s) => s.itemId === A)!;
    const after = audioSegments(t).find((s) => s.itemId === sound.items[0]!.id)!;
    expect(after).toMatchObject({
      start: before.start,
      in: before.in,
      out: before.out,
      volume: 0.8,
      role: 'dialogue',
    });
    expect(audioSegments(t).some((s) => s.itemId === A)).toBe(false);
    // onto a given audio track; only from sound at 1×
    const onMusic = apply(t0, [{ op: 'detach_audio', itemId: B, trackId: MUSIC }]);
    expect(items(onMusic, MUSIC).map((x) => x.start)).toEqual([0, 4]);
    expect(() => apply(t, [{ op: 'detach_audio', itemId: A }])).toThrow('muted');
    expect(() => apply(t0, [{ op: 'detach_audio', itemId: A, trackId: OVERLAY }])).toThrow('audio track');
    const fast = apply(t0, [{ op: 'set_speed', itemId: B, speed: 2 }]);
    expect(() => apply(fast, [{ op: 'detach_audio', itemId: B }])).toThrow('at 1×');
    const silent = apply(cut(), [
      {
        op: 'insert',
        trackId: OVERLAY2,
        item: {
          id: 'itm_silent000001',
          kind: 'video',
          source: { type: 'media', media: footage('s', { hasAudio: false }) },
          start: 0,
          in: 0,
          out: 2,
        } as never,
      },
    ]);
    expect(() => apply(silent, [{ op: 'detach_audio', itemId: 'itm_silent000001' }])).toThrow('no sound');
  });
});

describe('mirror and chroma key', () => {
  it('sets and clears the mirror, keys or masks but not both, and renders them', () => {
    const matte = f.media({ path: 'media/masks/matte.mp4', durationSec: 10, hasAudio: false });
    let t = apply(cut(), [
      { op: 'set_flip', itemId: A, flip: { x: true, y: false } },
      { op: 'set_key', itemId: O, key: { color: '#00ff00', similarity: 0.25, blend: 0.05 } },
    ]);
    expect(video(t, A)!.flip).toEqual({ x: true });
    expect(video(t, O)!.key).toEqual({ color: '#00ff00', similarity: 0.25, blend: 0.05 });
    expect(() =>
      apply(t, [{ op: 'set_mask', itemId: O, mask: { media: matte, offset: 0 } } as TimelineOp]),
    ).toThrow('not both');
    const [chunk] = planChunks(t, { targetSec: 60 });
    const g = chunkGraph(t, chunk!, {
      quality: 'standard',
      inputPath: (m) => `/in/${m.path.split('/').at(-1)}`,
      textPath: (i) => `/text/t${i}.txt`,
    });
    const graph = g.args[g.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toMatch(/pad=1280:720:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black,hflip,setsar=1/);
    expect(graph).toContain('format=rgba,colorkey=0x00FF00:0.25:0.05');
    t = apply(t, [
      { op: 'set_flip', itemId: A, flip: null },
      { op: 'set_key', itemId: O, key: null },
    ]);
    expect(video(t, A)!.flip).toBeUndefined();
    expect(video(t, O)!.key).toBeUndefined();
    // a keyed primary picture is composited over black, like a masked one
    const keyed = apply(cut(), [
      { op: 'set_key', itemId: A, key: { color: '#0000ff', similarity: 0.3, blend: 0 } },
    ]);
    const kg = chunkGraph(keyed, planChunks(keyed, { targetSec: 60 })[0]!, {
      quality: 'standard',
      inputPath: (m) => `/in/${m.path.split('/').at(-1)}`,
      textPath: (i) => `/text/t${i}.txt`,
    });
    const kgraph = kg.args[kg.args.indexOf('-filter_complex') + 1]!;
    expect(kgraph).toContain('scale=1280:720,setsar=1');
    expect(kgraph).toContain('colorkey=0x0000FF:0.3:0');
    expect(kgraph).toMatch(/color=c=black:s=1280x720:r=24:d=4,format=yuv420p,settb=AVTB\[bg\d+\]/);
  });

  it('keys like colorkey: a hard edge without blend, a ramp with it', () => {
    const key = { color: '#00ff00', similarity: 0.3, blend: 0 };
    expect(keyAlpha(0, 255, 0, key)).toBe(0);
    expect(keyAlpha(255, 0, 255, key)).toBe(255);
    const soft = { color: '#00ff00', similarity: 0.1, blend: 0.2 };
    // diff of (0, 205, 0) from pure green: 50/(255·√3) ≈ 0.1132 → (0.1132 − 0.1)/0.2 · 255 ≈ 16.8
    expect(keyAlpha(0, 205, 0, soft)).toBe(16);
    const px = new Uint8ClampedArray([0, 255, 0, 255, 200, 30, 40, 255]);
    applyKey(px, soft);
    expect([px[3], px[7]]).toEqual([0, 255]);
  });
});

describe('color adjustments (docs/design/editing-tools.md#color-adjustments)', () => {
  it('computes gains, tone, hue and vignette as the filters do', () => {
    expect(channelGains({})).toBeNull();
    expect(channelGains({ exposure: 1 })).toEqual([2, 2, 2]);
    expect(channelGains({ temperature: 1 })).toEqual([1.3, 1, 0.7]);
    expect(channelGains({ tint: 1 })).toEqual([1.1, 0.8, 1.1]);
    // lutrgb: truncated and clipped
    const g = gainTable(1.3);
    expect([g[0], g[100], g[196], g[197], g[255]]).toEqual([0, 130, 254, 255, 255]);
    expect(toneTable({})).toBeNull();
    const lift = toneTable({ shadows: 1 })!;
    // f(64) = 64 + 0.6·64·(1 − 64/255)·(1 − 64/255) ≈ 85.5; black and white stay
    expect([lift[0], lift[64], lift[255]]).toEqual([0, 85, 255]);
    expect(hueMatrix(0)).toBeNull();
    const h180 = hueMatrix(180)!;
    expect(h180[0]).toBeCloseTo(0.213 - 0.787, 9);
    expect(lrint(2.5)).toBe(2);
    expect(lrint(3.5)).toBe(4);
    expect(lrint(-0.5) === 0).toBe(true);
    expect(lrint(-1.5)).toBe(-2);
    // the vignette: 1 at the centre, cos(A)⁴ toward the corners, 0 beyond
    expect(vignetteFactor(50, 50, 100, 100, Math.PI / 4)).toBe(1);
    expect(vignetteFactor(0, 0, 100, 100, Math.PI / 4)).toBeCloseTo(Math.cos(Math.PI / 4) ** 4, 5);
    expect(adjustmentFilters({})).toEqual([]);
    expect(adjustmentFilters({ exposure: 1, shadows: 0.5, hue: 90, vignette: 0.5 })).toEqual([
      "lutrgb=r='val*2':g='val*2':b='val*2'",
      "lutrgb=r='val+0.6*val*(1-val/255)*(0.5*(1-val/255)+0*val/255)':g='val+0.6*val*(1-val/255)*(0.5*(1-val/255)+0*val/255)':b='val+0.6*val*(1-val/255)*(0.5*(1-val/255)+0*val/255)'",
      `colorchannelmixer=${['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'].map((k, i) => `${k}=${hueMatrix(90)![i]}`).join(':')}`,
      `vignette=angle=${Math.round((Math.PI / 4) * 1e9) / 1e9}:dither=0`,
    ]);
  });

  it('applies them to pixels in the chain order, the vignette over its space', () => {
    // one pixel through gains (×1.3 red), tone (shadows), hue (180°)
    const e = { temperature: 1, shadows: 0.5, hue: 180 };
    const px = new Uint8ClampedArray([100, 50, 200, 255]);
    applyAdjustments(px, 1, 1, e);
    const r1 = Math.trunc(100 * 1.3);
    const g1 = 50;
    const b1 = Math.trunc(200 * 0.7);
    const tone = (v: number) => Math.trunc(v + 0.6 * v * (1 - v / 255) * (0.5 * (1 - v / 255)));
    const [r2, g2, b2] = [tone(r1), tone(g1), tone(b1)];
    const m = hueMatrix(180)!;
    const clip = (v: number) => Math.min(255, Math.max(0, v));
    const out = [0, 1, 2].map((row) =>
      clip(lrint(r2 * m[row * 3]!) + lrint(g2 * m[row * 3 + 1]!) + lrint(b2 * m[row * 3 + 2]!)),
    );
    expect([...px]).toEqual([...out, 255]);
    // a letterboxed picture's vignette is centred on the frame: its top-left pixel at (10, 0) of a 40 × 20 frame
    const pic = new Uint8ClampedArray(20 * 20 * 4).fill(200);
    applyAdjustments(pic, 20, 20, { vignette: 1 }, { x: 10, y: 0, width: 40, height: 20 });
    const f0 = vignetteFactor(10, 0, 40, 20, Math.fround(Math.PI / 2));
    expect(pic[0]).toBe(Math.trunc(Math.fround(200 * f0)));
  });
});

describe('transitions (docs/design/editing-tools.md#transitions)', () => {
  const withTransition = (type: TransitionType) =>
    apply(cut(), [{ op: 'set_transition', itemId: B, transition: { type, duration: 2 } }]);

  it('dips with the weights of xfade, over black or white', () => {
    const t = withTransition('dip_to_white');
    // the transition runs 2–4 s; at 2.2 s q = 0.1: the outgoing frame at 0.45, a trace of the incoming, white
    const s = activeAt(t, 2.2);
    const w = dipWeights(0.1);
    expect(w.out).toBeCloseTo(0.45, 6);
    expect(s.fill).toBe('#ffffff');
    expect(s.video.map((l) => l.item.id)).toEqual([B, A]);
    expect(s.video[1]!.opacity).toBeCloseTo(w.out);
    expect(s.video[0]!.opacity).toBeCloseTo(w.in / (1 - w.out));
    expect(s.video[0]!.transition).toEqual({
      type: 'dip_to_white',
      progress: expect.closeTo(0.1),
      role: 'in',
    });
    // past a fifth the outgoing frame is gone; at the end only the incoming one is left
    expect(activeAt(t, 2.5).video[1]!.opacity).toBeCloseTo(0);
    expect(dipWeights(1)).toEqual({ out: 0, in: 1 });
    // the composite: fill·(1 − out − in) + in + out
    expect(activeAt(withTransition('dip_to_black'), 2.2).fill).toBeUndefined();
    const graph = chunkGraph(t, planChunks(t, { targetSec: 60 })[0]!, {
      quality: 'standard',
      inputPath: (m) => `/in/${m.path.split('/').at(-1)}`,
      textPath: (i) => `/text/t${i}.txt`,
    }).args.find((a) => a.includes('xfade'))!;
    expect(graph).toMatch(
      /\[v0\]format=gbrp\[ga1\];\[v1\]format=gbrp\[gb1\];\[ga1\]\[gb1\]xfade=transition=fadewhite:duration=2:offset=2,format=yuv420p\[x1\]/,
    );
  });

  it('slides whole frames by whole pixels and opens a soft circle', () => {
    expect(slideOffsets('slide_left', 0.25, 100, 50)).toEqual({ in: [75, 0], out: [-25, 0] });
    expect(slideOffsets('slide_right', 0.25, 100, 50)).toEqual({ in: [-75, 0], out: [25, 0] });
    expect(slideOffsets('slide_up', 0.5, 100, 50)).toEqual({ in: [0, 25], out: [0, -25] });
    expect(slideOffsets('slide_down', 0.5, 100, 50)).toEqual({ in: [0, -25], out: [0, 25] });
    // the circle: nothing of the incoming frame at the start, all of it at the end, the centre first
    expect(circleWeight(50, 25, 100, 50, 0)).toBe(0);
    expect(circleWeight(0, 0, 100, 50, 1)).toBe(1);
    expect(circleWeight(50, 25, 100, 50, 0.5)).toBeGreaterThan(circleWeight(10, 10, 100, 50, 0.5));
    // the canvas's gradient: 16 stops from the centre to the corner, within a level of the curve between them
    const g = circleStops(100, 50, 0.5);
    expect([g.cx, g.cy, g.radius]).toEqual([50.5, 25.5, Math.hypot(50, 25)]);
    expect(g.stops).toHaveLength(16);
    for (let d = 0; d <= g.radius; d += 0.5) {
      const k = Math.min(14, Math.floor((d / g.radius) * 15));
      const [a, b] = [g.stops[k]!, g.stops[k + 1]!];
      const lerp = a.weight + ((b.weight - a.weight) * (d / g.radius - a.offset)) / (b.offset - a.offset);
      expect(Math.abs(lerp - circleWeight(50 + d, 25, 100, 50, 0.5))).toBeLessThan(1 / 255);
    }
    // the wipe: the incoming frame right of the edge, which moves leftward
    expect(wipeEdge(0, 100)).toBe(101);
    expect(wipeEdge(0.25, 100)).toBe(76);
    expect(wipeEdge(1, 100)).toBe(1);
    for (const [type, xfade] of [
      ['slide_left', 'slideleft'],
      ['slide_up', 'slideup'],
      ['circle_open', 'circleopen'],
    ] as const) {
      const t = withTransition(type);
      expect(activeAt(t, 3).video.map((l) => [l.item.id, l.opacity, l.transition?.role])).toEqual([
        [A, 1, 'out'],
        [B, 1, 'in'],
      ]);
      const g = chunkGraph(t, planChunks(t, { targetSec: 60 })[0]!, {
        quality: 'standard',
        inputPath: (m) => `/in/${m.path.split('/').at(-1)}`,
        textPath: (i) => `/text/t${i}.txt`,
      });
      expect(g.args.find((a) => a.includes('xfade'))).toContain(
        `[v0][v1]xfade=transition=${xfade}:duration=2`,
      );
    }
  });
});

describe('snapping and edit points (docs/design/editing-tools.md#snapping)', () => {
  it('lists the targets and snaps to the nearest within the tolerance', () => {
    const t = apply(cut(), [{ op: 'add_marker', marker: { t: 3.3 } }]);
    const targets = snapTargets(t, { exclude: [O], playhead: 2.5 });
    expect(targets.map((x) => [x.t, x.kind])).toEqual([
      [0, 'origin'],
      [2, 'item'],
      [2.5, 'playhead'],
      [3.3, 'marker'],
      [4, 'item'],
      [10, 'item'],
      [30, 'item'],
    ]);
    expect(snapTime(3.9, targets, 0.2)).toBe(4);
    expect(snapTime(3.5, targets, 0.1)).toBe(3.5);
    expect(snapTime(3.2, targets, 0.25)).toBe(3.3);
    // a span snaps by whichever edge lands nearer
    expect(snapSpan(1.9, 1, targets, 0.2)).toEqual({ start: 2, target: { t: 2, kind: 'item' } });
    expect(snapSpan(2.95, 1, targets, 0.2)).toEqual({ start: 3, target: { t: 4, kind: 'item' } });
    expect(snapSpan(6, 1, targets, 0.2)).toEqual({ start: 6, target: null });
  });

  it('steps through edit points of every track and the markers', () => {
    const t = apply(cut(), [{ op: 'add_marker', marker: { t: 3.3 } }]);
    expect(editPoints(t)).toEqual([0, 2, 3.3, 4, 5, 7, 10, 30]);
    expect(nextEditPoint(t, 4)).toBe(5);
    expect(previousEditPoint(t, 4)).toBe(3.3);
    expect(previousEditPoint(t, 0)).toBeNull();
    expect(nextEditPoint(t, 30)).toBeNull();
  });
});

describe('interchange of the new tools (docs/design/interchange.md)', () => {
  const ctx: InterchangeContext = { title: 'Tools', mediaUrl: (m) => `file:///dav/${m.path}` };

  it('exports a freeze as speed 0 and the new transitions by their nearest NLE names', () => {
    const t = apply(cut(), [
      { op: 'freeze_frame', itemId: A, at: 1.5, duration: 1 },
      { op: 'set_transition', itemId: B, transition: { type: 'slide_left', duration: 0.5 } },
    ]);
    const edl = toEdl(t, ctx);
    expect(edl).toContain('M2   AX       000.0');
    expect(edl).toMatch(/W001 012/);
    const xml = toXmeml(t, ctx);
    expect(xml).toContain('<name>Push</name>');
    expect(xml).toMatch(/<parameterid>speed<\/parameterid>[\s\S]*?<value>0<\/value>/);
    const fcp = toFcpxml(t, ctx);
    expect(fcp).toContain('name="Slide Left"');
    expect(fcp).toMatch(
      /<timept time="36\/24s" value="36\/24s" interp="linear"\/>\s*<timept time="60\/24s" value="36\/24s"/,
    );
  });

  it('reads an OTIO freeze back as a freeze frame', () => {
    const t = apply(cut(), [
      { op: 'freeze_frame', itemId: A, at: 1.5, duration: 1 },
      { op: 'set_transition', itemId: B, transition: { type: 'circle_open', duration: 0.5 } },
    ]);
    const doc = JSON.parse(exportCut('otio', t, ctx));
    const back = fromOtio(doc, {
      base: t,
      resolve: (clip) =>
        ((clip.rideo?.item as { source?: Source } | undefined)?.source ?? null) as Source | null,
    });
    const picture = primaryTrack(back.timeline).items as VideoItem[];
    expect(picture.map((x) => [x.start, x.in, x.freeze?.duration ?? null])).toEqual(
      (items(t, PRIMARY) as VideoItem[]).map((x) => [
        x.start,
        expect.closeTo(x.in, 3),
        x.freeze?.duration ?? null,
      ]),
    );
    expect(picture.at(-1)!.transitionIn).toEqual({ type: 'circle_open', duration: 0.5 });
    // a foreign freeze (FreezeFrame effect) too
    const clip = doc.tracks.children[0].children[1];
    clip.effects = [{ OTIO_SCHEMA: 'FreezeFrame.1', effect_name: 'FreezeFrame', metadata: {}, name: '' }];
    delete clip.metadata.rideo;
    const foreign = fromOtio(doc, {
      base: t,
      resolve: () => ({ type: 'media', media: footage('a') }),
    });
    expect((primaryTrack(foreign.timeline).items[1] as VideoItem).freeze).toEqual({ duration: 1 });
  });
});

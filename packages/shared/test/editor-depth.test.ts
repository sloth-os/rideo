import { describe, expect, it } from 'vitest';
import {
  activeAt,
  applyCube,
  applyOps,
  attachWords,
  audioSegments,
  CubeError,
  chunkGraph,
  cutRanges,
  emptyTimeline,
  fillerWords,
  identityCube,
  interpolate,
  isIdentity,
  itemDuration,
  linearExpression,
  localAtSource,
  type MediaRef,
  opacityAt,
  overlaySegments,
  parseCube,
  planChunks,
  propertyCurve,
  rampPreset,
  renderInputs,
  sliceTimeMap,
  sourceAtLocal,
  sourceTimeAt,
  spreadWords,
  type Timeline,
  timeMapOf,
  transformAt,
  type VideoItem,
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
const lutMedia = f.media({ path: 'media/luts/warm-0123456789ab.cube', mime: 'application/x-cube' });
const matte = f.media({ path: 'media/masks/matte-0123456789ab.mp4', durationSec: 8, hasAudio: false });
let n = 0;
const gen = (k: 'item' | 'track') => `${k === 'item' ? 'itm' : 'trk'}_${String(++n).padStart(12, '0')}`;

/** A cut: two primary items and nothing else. */
function cut(): Timeline {
  return applyOps(
    emptyTimeline({ fps: 24, width: 1280, height: 720 }),
    [
      {
        op: 'insert',
        trackId: 'trk_primaryvideo01',
        item: { kind: 'video', source: { type: 'media', media: footage('a') }, in: 0, out: 4 },
      },
      {
        op: 'insert',
        trackId: 'trk_primaryvideo01',
        item: { kind: 'video', source: { type: 'media', media: footage('b') }, in: 2, out: 8 },
      },
    ],
    { newId: gen },
  );
}
const ids = (t: Timeline, k = 0) => t.tracks[k]!.items.map((i) => i.id);

describe('keyframes (docs/design/editor.md#multitrack-transforms-and-keyframes)', () => {
  it('interpolates each property between the keyframes that set it and holds outside', () => {
    const tr = {
      keyframes: [
        { t: 2, x: 0.2, opacity: 0 },
        { t: 0, x: 0.8 },
        { t: 4, opacity: 1 },
      ],
    };
    expect(propertyCurve(tr, 'x')).toEqual([
      [0, 0.8],
      [2, 0.2],
    ]);
    expect(propertyCurve(tr, 'scale')).toBeNull();
    expect(transformAt(tr, 1)).toEqual({ x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 0 });
    expect(transformAt(tr, 3).opacity).toBeCloseTo(0.5);
    expect(transformAt(tr, 9)).toMatchObject({ x: 0.2, opacity: 1 });
    expect(interpolate([[1, 10]], 5)).toBe(10);
    expect(isIdentity({ keyframes: [{ t: 0, scale: 1, opacity: 1 }] })).toBe(true);
    expect(isIdentity(tr)).toBe(false);
  });

  it('writes piecewise-linear ffmpeg expressions and fades overlays to transparent', () => {
    expect(linearExpression([[0, 0.5]])).toBe('0.5');
    expect(
      linearExpression(
        [
          [0, 0],
          [2, 1],
        ],
        't',
        1,
      ),
    ).toBe('if(lt((t+1)\\,0)\\,0\\,if(lt((t+1)\\,2)\\,0+((t+1)-0)*0.5\\,1))');
    const tr = { keyframes: [{ t: 0, opacity: 0.8 }] };
    expect(opacityAt(tr, { fadeIn: 1, fadeOut: 1 }, 4, 0.5)).toBeCloseTo(0.4);
    expect(opacityAt(tr, { fadeIn: 1, fadeOut: 1 }, 4, 2)).toBeCloseTo(0.8);
    expect(opacityAt(tr, { fadeIn: 1, fadeOut: 1 }, 4, 3.75)).toBeCloseTo(0.2);
  });
});

describe('speed ramps (docs/design/editor.md#speed-ramps)', () => {
  it('maps item time to source time exactly at the points and through the integral between them', () => {
    const constant = timeMapOf({ in: 2, out: 8, speed: 2 });
    expect(constant.duration).toBe(3);
    const ramp = rampPreset('ease_in', { in: 0, out: 3 });
    const map = timeMapOf({ in: 0, out: 3, speed: 1, ramp });
    // 0.5× → 2× linearly over 3 s of source: ∫ ds / v = ln(4) / 0.5
    expect(map.duration).toBeCloseTo(Math.log(4) / 0.5, 6);
    expect(sourceAtLocal(map, 0)).toBe(0);
    expect(sourceAtLocal(map, map.duration)).toBeCloseTo(3, 9);
    for (const s of [0.3, 1.1, 2.9]) expect(sourceAtLocal(map, localAtSource(map, s))).toBeCloseTo(s, 9);
    // slow first: the first second of the item shows less than the last
    expect(sourceAtLocal(map, 1)).toBeLessThan(3 - sourceAtLocal(map, map.duration - 1));
    const part = sliceTimeMap(map, 1, 2);
    expect(part[0]).toEqual([0, 0]);
    expect(part.at(-1)![0]).toBeCloseTo(1);
    expect(part.at(-1)![1]).toBeCloseTo(sourceAtLocal(map, 2) - sourceAtLocal(map, 1));
    expect(rampPreset('speed_up_middle', { in: 2, out: 4 }).points.map((p) => [p.at, p.speed])).toEqual([
      [2, 1],
      [3, 3],
      [4, 1],
    ]);
  });
});

describe('transcript editing (docs/design/editor.md#transcript-editing)', () => {
  it('spreads words, keeps punctuation from the segment text and finds standalone fillers', () => {
    expect(spreadWords({ start: 0, end: 2, text: 'a bb' })).toEqual([
      { text: 'a', start: 0, end: 0.8 },
      { text: 'bb', start: 0.8, end: 2 },
    ]);
    const [seg] = attachWords(
      [{ start: 0, end: 4, text: 'Um, I mean, you know what, you know.' }],
      [
        ['Um', 0, 0.3],
        ['I', 0.35, 0.45],
        ['mean', 0.45, 0.7],
        ['you', 1.0, 1.2],
        ['know', 1.2, 1.4],
        ['what', 1.42, 1.7],
        ['you', 2.0, 2.2],
        ['know', 2.2, 2.5],
      ].map(([word, start, end]) => ({ word: word as string, start: start as number, end: end as number })),
    );
    expect(seg!.words.map((w) => w.text)).toEqual([
      'Um,',
      'I',
      'mean,',
      'you',
      'know',
      'what,',
      'you',
      'know.',
    ]);
    // "you know what" is a sentence; the closing "you know." and "I mean," stand alone
    expect(fillerWords(seg!.words).map((x) => [x.text, x.start, x.end])).toEqual([
      ['Um', 0, 0.3],
      ['I mean', 0.35, 0.7],
      ['you know', 2, 2.5],
    ]);
    expect(attachWords([{ start: 0, end: 1, text: 'no words' }], null)[0]).toMatchObject({ approx: true });
    expect(
      cutRanges([
        { start: 2, end: 2.5 },
        { start: 0, end: 0.3 },
        { start: 0.4, end: 0.7 },
      ]),
    ).toEqual([
      [0, 0.73],
      [1.97, 2.53],
    ]);
  });
});

describe('LUTs (docs/design/editor.md#luts)', () => {
  it('parses .cube files and applies them trilinearly, mixed by intensity', () => {
    const id = parseCube(identityCube(3));
    expect(id).toMatchObject({ size: 3, domainMin: [0, 0, 0], domainMax: [1, 1, 1] });
    const px = new Uint8ClampedArray([10, 128, 250, 255, 0, 0, 0, 7]);
    applyCube(id, px);
    expect([...px]).toEqual([10, 128, 250, 255, 0, 0, 0, 7]);
    // an inverting LUT, half applied
    const invert = parseCube(
      `TITLE "invert"\nLUT_3D_SIZE 2\n${[0, 1]
        .flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`)))
        .join('\n')}\n`,
    );
    expect(invert.title).toBe('invert');
    const full = new Uint8ClampedArray([0, 255, 100, 255]);
    applyCube(invert, full);
    expect([...full]).toEqual([255, 0, 155, 255]);
    const half = new Uint8ClampedArray([0, 255, 100, 255]);
    applyCube(invert, half, 0.5);
    expect([...half]).toEqual([128, 128, 128, 255]);
    expect(() => parseCube('LUT_1D_SIZE 4')).toThrow(CubeError);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow('expected 8 rows, found 1');
    expect(() => parseCube('0 0 0')).toThrow('missing LUT_3D_SIZE');
  });
});

describe('the reducer with overlay tracks, transforms, ramps, LUTs and masks', () => {
  it('adds overlay tracks above the video tracks and positions their items freely, without transitions', () => {
    let t = cut();
    t = applyOps(
      t,
      [{ op: 'add_track', track: { id: 'trk_overlay000001', kind: 'video', name: 'B-roll' } }],
      { newId: gen },
    );
    expect(t.tracks.map((x) => x.kind)).toEqual(['video', 'video', 'audio', 'text']);
    const insert = (start: number, extra: Partial<VideoItem> = {}) =>
      applyOps(
        t,
        [
          {
            op: 'insert',
            trackId: 'trk_overlay000001',
            item: {
              kind: 'video',
              source: { type: 'media', media: footage('c') },
              start,
              in: 1,
              out: 3,
              ...extra,
            } as never,
          },
        ],
        { newId: gen },
      );
    t = insert(5);
    expect(t.tracks[1]!.items[0]).toMatchObject({ start: 5, in: 1, out: 3 });
    expect(() => insert(1, { transitionIn: { type: 'crossfade', duration: 0.5 } })).toThrow(
      'overlay items have no transitions',
    );
    const overlayId = t.tracks[1]!.items[0]!.id;
    t = applyOps(t, [{ op: 'move', itemId: overlayId, start: 2 }]);
    expect(t.tracks[1]!.items[0]!.start).toBe(2);
    t = applyOps(t, [
      {
        op: 'set_transform',
        itemId: overlayId,
        transform: {
          keyframes: [
            { t: 1, scale: 0.5 },
            { t: 0, x: 0.75 },
          ],
        },
      },
    ]);
    expect((t.tracks[1]!.items[0] as VideoItem).transform!.keyframes.map((k) => k.t)).toEqual([0, 1]);
    t = applyOps(t, [{ op: 'set_transform', itemId: overlayId, transform: null }]);
    expect((t.tracks[1]!.items[0] as VideoItem).transform).toBeUndefined();
  });

  it('ramps change the layout, split keeps the ramp, and a constant speed replaces it', () => {
    let t = cut();
    const [a, b] = ids(t);
    expect(() =>
      applyOps(t, [
        {
          op: 'set_ramp',
          itemId: a!,
          ramp: {
            points: [
              { at: 0, speed: 1 },
              { at: 9, speed: 2 },
            ],
          },
        },
      ]),
    ).toThrow('inside the item');
    t = applyOps(t, [{ op: 'set_ramp', itemId: a!, ramp: rampPreset('ease_in', { in: 0, out: 4 }) }]);
    const first = t.tracks[0]!.items[0] as VideoItem;
    expect(itemDuration(first)).toBeCloseTo(Math.log(4) / (1.5 / 4), 6);
    expect(t.tracks[0]!.items[1]!.start).toBeCloseTo(itemDuration(first), 6);
    const at = itemDuration(first) / 2;
    t = applyOps(t, [{ op: 'split', itemId: a!, at }], { newId: gen });
    const [x, y] = t.tracks[0]!.items as VideoItem[];
    expect(x!.out).toBeCloseTo(sourceAtLocal(timeMapOf(first), at), 6);
    expect(y!.in).toBe(x!.out);
    expect(y!.ramp).toEqual(first.ramp);
    expect(itemDuration(x!) + itemDuration(y!)).toBeCloseTo(itemDuration(first), 3);
    t = applyOps(t, [{ op: 'set_speed', itemId: y!.id, speed: 2 }]);
    expect((t.tracks[0]!.items[1] as VideoItem).ramp).toBeUndefined();
    expect(ids(t).at(-1)).toBe(b);
  });

  it('cuts source ranges out of the primary track, ripples and keeps transitions within their neighbours', () => {
    let t = cut();
    const [, b] = ids(t);
    t = applyOps(t, [{ op: 'set_transition', itemId: b!, transition: { type: 'crossfade', duration: 1.5 } }]);
    t = applyOps(
      t,
      [
        {
          op: 'remove_ranges',
          media: 'media/uploads/b.mp4',
          ranges: [
            [2.5, 3.2],
            [5, 7.5],
            [9, 9.5],
          ],
        },
      ],
      {
        newId: gen,
      },
    );
    const items = t.tracks[0]!.items as VideoItem[];
    expect(items.map((i) => [i.source.media.path.slice(-5), i.in, i.out])).toEqual([
      ['a.mp4', 0, 4],
      ['b.mp4', 2, 2.5],
      ['b.mp4', 3.2, 5],
      ['b.mp4', 7.5, 8],
    ]);
    // the first piece keeps the id and its crossfade, shortened to half of its 0.5 s; the others follow at cuts
    expect(items[1]!.id).toBe(b);
    expect(items[1]!.transitionIn).toEqual({ type: 'crossfade', duration: 0.25 });
    expect(items[2]!.transitionIn).toBeNull();
    expect(items[2]!.start).toBeCloseTo(4.25, 6);
    expect(
      applyOps(t, [{ op: 'remove_ranges', media: 'media/uploads/a.mp4', ranges: [[0, 10]] }]).tracks[0]!
        .items,
    ).toHaveLength(3);
  });
});

describe('queries and the render graph with overlays', () => {
  function layered(): Timeline {
    let t = cut();
    const [a] = ids(t);
    t = applyOps(
      t,
      [
        { op: 'add_track', track: { id: 'trk_overlay000001', kind: 'video', name: 'B-roll', role: 'music' } },
        {
          op: 'insert',
          trackId: 'trk_overlay000001',
          item: {
            id: 'itm_0000000000o1',
            kind: 'video',
            source: { type: 'media', media: footage('c') },
            start: 1,
            in: 0,
            out: 2,
            fadeIn: 0.5,
            transform: {
              keyframes: [
                { t: 0, x: 0.75, y: 0.25, scale: 0.35 },
                { t: 2, x: 0.25, rotation: 30 },
              ],
            },
            lut: { media: lutMedia, intensity: 0.6 },
            mask: { media: matte, offset: 0, subject: 'the person', invert: true, model: 'mock-segment-v1' },
          },
        },
        { op: 'set_ramp', itemId: a!, ramp: rampPreset('ease_out', { in: 0, out: 4 }) },
      ],
      { newId: gen },
    );
    return t;
  }

  it('puts overlay layers over the primary one with their transform, and mixes their sound on their stem', () => {
    const t = layered();
    const state = activeAt(t, 1.25);
    expect(state.video.map((l) => [l.item.id === 'itm_0000000000o1', l.overlay ?? false])).toEqual([
      [false, false],
      [true, true],
    ]);
    const o = state.video[1]!;
    expect(o.transform!.x).toBeCloseTo(0.75 - 0.5 * 0.25 * 0.5, 6);
    expect(o.opacity).toBeCloseTo(0.5);
    expect(o.sourceTime).toBeCloseTo(0.25);
    expect(sourceTimeAt(t.tracks[0]!.items[0] as VideoItem, 1)).toBeCloseTo(
      sourceAtLocal(timeMapOf(t.tracks[0]!.items[0] as VideoItem), 1),
    );
    const sound = audioSegments(t);
    // the ramped item is silent; the overlay's sound is on its track's stem
    expect(sound.map((s) => [s.itemId === 'itm_0000000000o1', s.role])).toEqual([
      [false, 'dialogue'],
      [true, 'music'],
    ]);
    expect(overlaySegments(t)).toHaveLength(1);
    expect(renderInputs(t).map((m) => m.path.split('/').at(-1))).toEqual([
      'a.mp4',
      'b.mp4',
      'c.mp4',
      'warm-0123456789ab.cube',
      'matte-0123456789ab.mp4',
    ]);
  });

  it('composites overlays in the chunk graph with LUT, inverted matte, keyframed transform, fades and ramps', () => {
    const t = layered();
    const [chunk] = planChunks(t, { targetSec: 60 });
    const g = chunkGraph(t, chunk!, {
      quality: 'standard',
      inputPath: (m) => `/in/${m.path.split('/').at(-1)}`,
      textPath: (i) => `/text/t${i}.txt`,
    });
    const graph = g.args[g.args.indexOf('-filter_complex') + 1]!;
    // the ramp's inverse time map
    expect(graph).toMatch(/setpts='\(if\(lt\(\(T-STARTT\)/);
    // LUT at 60 %
    expect(graph).toContain("lut3d=file='/in/warm-0123456789ab.cube':interp=trilinear");
    expect(graph).toContain('blend=all_mode=normal:all_opacity=0.6');
    // the matte, inverted, as alpha
    expect(graph).toMatch(/format=gray,negate\[m\d+\]/);
    expect(graph).toContain('alphamerge');
    // a fixed scale (one keyframe) and a keyframed rotation, positioned in chunk time, enabled for its span
    expect(graph).toContain('format=rgba,scale=448:252,rotate=');
    // rotation set by one keyframe is held (30°); the position moves between its keyframes
    expect(graph).toContain("rotate=a='(30)*PI/180'");
    expect(graph).toContain(
      "overlay=x='W*(if(lt((t-1)\\,0)\\,0.75\\,if(lt((t-1)\\,2)\\,0.75+((t-1)-0)*-0.25\\,0.25)))-w/2'",
    );
    expect(graph).toContain("enable='between(t\\,1\\,3)'");
    // the fade-in as opacity commands, written before running
    const cmd = g.textFiles.find((x) => x.content.includes('colorchannelmixer@'))!;
    expect(cmd.content.split('\n')[0]).toMatch(/^1 colorchannelmixer@op\d+ aa 0;$/);
    expect(graph).toContain(`sendcmd=f='${cmd.path}'`);
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyOps,
  chunkGraph,
  cropFilter,
  cropSize,
  cropWindow,
  cutDown,
  DEFAULT_TRACK_IDS,
  DELIVERY_PRESETS,
  deliverySize,
  emptyTimeline,
  focusAt,
  planChunks,
  primaryTrack,
  reframeTimeline,
  resolveDelivery,
  type TextItem,
  type Timeline,
  thumbnailTimes,
  timelineDuration,
  type VideoItem,
} from '../src';
import * as f from '../src/testing/fixtures';

const HD = { width: 1920, height: 1080, fps: 24 };

describe('deliveries (docs/design/finishing.md#delivery-presets)', () => {
  it('resolves a preset, then the explicit options', () => {
    expect(resolveDelivery(HD, {}, 'standard')).toMatchObject({
      preset: 'web',
      format: 'mp4',
      width: 1920,
      height: 1080,
      fps: 24,
      aspect: 'source',
      loudness: 'streaming',
      captions: 'burn',
      thumbnails: false,
    });
    expect(resolveDelivery(HD, { preset: 'youtube' }, 'standard')).toMatchObject({
      width: 3840,
      height: 2160,
      captions: 'sidecar',
      thumbnails: true,
    });
    expect(resolveDelivery(HD, { preset: 'broadcast' }, 'standard')).toMatchObject({
      format: 'prores',
      loudness: 'broadcast',
      stems: true,
    });
    expect(
      resolveDelivery(HD, { preset: 'vertical', fps: 60, maxDurationSec: 15 }, 'standard'),
    ).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 60,
      aspect: '9:16',
      maxDurationSec: 15,
    });
    expect(resolveDelivery(HD, { preset: 'master_frames', loudness: 'streaming' }, 'high')).toMatchObject({
      format: 'frames',
      loudness: 'streaming',
    });
    expect(Object.keys(DELIVERY_PRESETS)).toHaveLength(7);
  });

  it('sizes deliveries by their short side; drafts stay small', () => {
    expect(deliverySize(HD, { aspect: '1:1', resolution: 'hd', quality: 'standard' })).toEqual({
      width: 1080,
      height: 1080,
    });
    // the project's own window of the aspect
    expect(deliverySize(HD, { aspect: '9:16', resolution: 'project', quality: 'standard' })).toEqual({
      width: 608,
      height: 1080,
    });
    expect(deliverySize(HD, { aspect: 'source', resolution: 'uhd', quality: 'draft' })).toEqual({
      width: 1280,
      height: 720,
    });
    expect(cropSize(1920, 1080, 1)).toEqual({ width: 1080, height: 1080 });
    expect(cropSize(1080, 1920, 16 / 9)).toEqual({ width: 1080, height: 608 });
  });
});

/** Evaluates an ffmpeg crop option expression (the subset cropFilter writes). */
function evalExpr(expr: string, vars: Record<string, number>): number {
  const js = expr.replace(/\\,/g, ',').replace(/\bif\(/g, 'iff(');
  const fn = new Function('iff', 'lt', 'clip', 'min', ...Object.keys(vars), `return ${js};`) as (
    ...a: unknown[]
  ) => number;
  return fn(
    (c: number, a: number, b: number) => (c ? a : b),
    (a: number, b: number) => (a < b ? 1 : 0),
    (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
    Math.min,
    ...Object.values(vars),
  );
}

describe('auto-reframe (docs/design/finishing.md#auto-reframe-and-cut-downs)', () => {
  const focus = [
    { t: 1, x: 0.2, y: 0.5 },
    { t: 3, x: 0.8, y: 0.4 },
  ];

  it('follows the subject between focus points and keeps the window in the frame', () => {
    expect(focusAt(focus, 0)).toEqual({ x: 0.2, y: 0.5 });
    expect(focusAt(focus, 2).x).toBeCloseTo(0.5, 9);
    expect(focusAt(focus, 9)).toEqual({ x: 0.8, y: 0.4 });
    expect(focusAt([], 1)).toEqual({ x: 0.5, y: 0.5 });
    const src = { width: 1920, height: 1080 };
    expect(cropWindow(src, 9 / 16, focus, 0)).toEqual({ x: 80.25, y: 0, width: 607.5, height: 1080 });
    expect(cropWindow(src, 9 / 16, [{ t: 0, x: 0, y: 0 }], 0).x).toBe(0);
    expect(cropWindow(src, 9 / 16, focus, 2).x).toBeCloseTo(960 - 607.5 / 2, 6);
    expect(cropWindow(src, 9 / 16, focus, 3).x).toBeCloseTo(1920 * 0.8 - 607.5 / 2, 6);
    expect(cropWindow(src, 9 / 16, [{ t: 0, x: 1, y: 1 }], 0).x).toBe(1920 - 607.5);
  });

  it('crops in ffmpeg exactly where the compositor draws', () => {
    const filter = cropFilter(focus, 9 / 16, 0.5, 2);
    const opt = (k: string) => new RegExp(`${k}='([^']*)'`).exec(filter)![1]!;
    const iw = 1920;
    const ih = 1080;
    const ow = evalExpr(opt('w'), { iw, ih });
    const oh = evalExpr(opt('h'), { iw, ih });
    expect([ow, oh]).toEqual([607.5, 1080]);
    // stream time t at speed 2 from source second 0.5
    for (const t of [0, 0.25, 0.5, 0.75, 1.5]) {
      const src = 0.5 + t * 2;
      expect(evalExpr(opt('x'), { t, iw, ih, ow, oh })).toBeCloseTo(
        cropWindow({ width: iw, height: ih }, 9 / 16, focus, src).x,
        3,
      );
      expect(evalExpr(opt('y'), { t, iw, ih, ow, oh })).toBeCloseTo(
        cropWindow({ width: iw, height: ih }, 9 / 16, focus, src).y,
        3,
      );
    }
  });

  it('reframes the cut: the crop size, every item following its take', () => {
    const base = emptyTimeline({ fps: 24, width: 1920, height: 1080 });
    const t = applyOps(base, [
      {
        op: 'insert',
        trackId: primaryTrack(base).id,
        item: {
          kind: 'video',
          source: {
            type: 'take',
            clipId: 'clp_0000000001',
            shotId: 'sht_0000000001',
            takeId: 'tak_0000000001',
            media: f.media({ durationSec: 10 }),
          },
          in: 0,
          out: 5,
        },
      },
      {
        op: 'insert',
        trackId: primaryTrack(base).id,
        item: {
          kind: 'video',
          source: { type: 'media', media: f.media({ durationSec: 10 }) },
          in: 0,
          out: 5,
        },
      },
    ]);
    const r = reframeTimeline(t, { aspect: '9:16', focusByTake: { tak_0000000001: focus } });
    expect([r.width, r.height]).toEqual([608, 1080]);
    const items = primaryTrack(r).items as VideoItem[];
    expect(items[0]!.crop).toEqual({ focus });
    expect(items[1]!.crop).toEqual({ focus: [{ t: 0, x: 0.5, y: 0.5 }] });
    expect(t.width).toBe(1920);
    const [chunk] = planChunks(r, { targetSec: 30 });
    const g = chunkGraph(r, chunk!, {
      quality: 'standard',
      inputPath: () => '/in',
      textPath: (i) => `/t/${i}`,
    });
    const graph = g.args[g.args.indexOf('-filter_complex') + 1]!;
    // the aspect of the even-sized frame (608×1080), as the compositor draws it
    expect(graph).toContain("crop=w='min(iw\\,ih*0.563)'");
    expect(graph).toContain(',scale=608:1080,setsar=1');
    expect(graph).not.toContain('force_original_aspect_ratio');
  });
});

describe('cut-downs and thumbnails', () => {
  function cut(): Timeline {
    const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
    const video = (out: number) => ({
      op: 'insert' as const,
      trackId: primaryTrack(base).id,
      item: {
        kind: 'video' as const,
        source: { type: 'media' as const, media: f.media({ durationSec: 30 }) },
        in: 0,
        out,
      },
    });
    return applyOps(base, [
      video(8),
      video(12),
      video(6),
      {
        op: 'insert',
        trackId: DEFAULT_TRACK_IDS.audio,
        item: {
          kind: 'audio',
          source: { type: 'media', media: f.media({ durationSec: 60 }) },
          start: 0,
          in: 0,
          out: 26,
        },
      },
      {
        op: 'add_text',
        item: { kind: 'text', start: 9, duration: 4, text: 'Hello', style: { preset: 'caption' } },
      },
      {
        op: 'add_text',
        item: { kind: 'text', start: 22, duration: 2, text: 'Later', style: { preset: 'caption' } },
      },
    ]);
  }

  it('keeps the cut up to the length, fading out with it', () => {
    const t = cutDown(cut(), 11);
    expect(timelineDuration(t)).toBeCloseTo(11, 6);
    const items = primaryTrack(t).items as VideoItem[];
    expect(items.map((i) => [i.start, i.out, i.fadeOut])).toEqual([
      [0, 8, undefined],
      [8, 3, 1],
    ]);
    const music = t.tracks.find((x) => x.id === DEFAULT_TRACK_IDS.audio)!.items[0]!;
    expect(music).toMatchObject({ out: 11, fadeOut: 1.5 });
    const texts = t.tracks.find((x) => x.kind === 'text')!.items as TextItem[];
    expect(texts.map((x) => [x.text, x.duration])).toEqual([['Hello', 2]]);
    // shorter cuts are untouched
    const whole = cut();
    expect(cutDown(whole, 600)).toBe(whole);
  });

  it('picks thumbnail candidates in the middle of the longest items, then spread over the cut', () => {
    expect(thumbnailTimes(cut(), 2)).toEqual([4, 14]);
    // three items, five candidates: two more from the evenly spread times
    const five = thumbnailTimes(cut(), 5);
    expect(five).toHaveLength(5);
    expect(five).toEqual(expect.arrayContaining([4, 14, 23]));
    expect(new Set(five).size).toBe(5);
  });
});

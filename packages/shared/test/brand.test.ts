import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  BRAND_BUG_TRACK_ID,
  brandTitleStyle,
  bugTransform,
  chunkGraph,
  emptyTimeline,
  fontFamily,
  isFontFile,
  lowerThirdItem,
  type MediaRef,
  type ProjectBrand,
  ProjectBrandSchema,
  planChunks,
  renderInputs,
  type Timeline,
  timelineDuration,
  withBrand,
} from '../src';
import * as f from '../src/testing/fixtures';

const font = (name: string): MediaRef =>
  f.media({ path: `media/brand/${name}-0123456789ab.ttf`, mime: 'font/ttf' });
const logo = f.media({
  path: 'media/brand/logo-0123456789ab.png',
  mime: 'image/png',
  width: 400,
  height: 200,
});

const brand: ProjectBrand = ProjectBrandSchema.parse({
  kitId: 'bkt_000000000001',
  name: 'Northwind',
  colors: { text: '#FFFFFF', accent: '#FF6B3D', box: '#102030', boxOpacity: 0.6 },
  fonts: { title: font('title'), body: font('body') },
  logo,
  bug: { enabled: true, corner: 'bottom_right', size: 0.1, opacity: 0.8, margin: 0.03 },
  intro: { media: f.media({ path: 'media/brand/intro-0123456789ab.mp4', durationSec: 4 }), durationSec: 4 },
  outro: {
    media: f.media({
      path: 'media/brand/outro-0123456789ab.png',
      mime: 'image/png',
      width: 1920,
      height: 1080,
    }),
    durationSec: 3,
  },
  lowerThirds: [
    { id: 'name-role', name: 'Name and role', position: 'left', font: 'body', color: 'text', box: true },
    { id: 'credit', name: 'Credit', position: 'right', font: 'title', color: 'accent', box: false, size: 40 },
  ],
  appliedAt: '2026-10-02T00:00:00.000Z',
});

function cut(): Timeline {
  return applyOps(emptyTimeline({ fps: 24, width: 1920, height: 1080 }), [
    {
      op: 'insert',
      trackId: 'trk_primaryvideo01',
      item: { kind: 'video', source: { type: 'media', media: f.media({ durationSec: 10 }) }, in: 0, out: 6 },
    },
    {
      op: 'add_text',
      item: { kind: 'text', start: 1, duration: 2, text: 'Hello', style: { preset: 'title' } },
    },
  ]);
}

describe('brand kits (docs/design/brand-kits.md)', () => {
  it('recognises fonts by their signature', () => {
    const dejavu = readFileSync(resolve(import.meta.dirname, '../../web/public/fonts/DejaVuSans.ttf'));
    expect(isFontFile(dejavu)).toBe(true);
    expect(isFontFile(Buffer.from('OTTO1234'))).toBe(true);
    expect(isFontFile(Buffer.from('\x89PNG'))).toBe(false);
  });

  it('puts the bug in its corner at its size, over every other video track, for the whole film', () => {
    const tr = bugTransform(brand.bug, logo, { width: 1920, height: 1080 });
    // 192 × 96 px, 57.6 px from the right and bottom edges
    expect(tr.x).toBeCloseTo((1920 - 57.6 - 96) / 1920, 9);
    expect(tr.y).toBeCloseTo((1080 - 57.6 - 48) / 1080, 9);
    expect(tr.scale).toBeCloseTo(0.1, 9);
    const t = cut();
    const branded = withBrand(t, brand, true);
    expect(branded.tracks.map((x) => x.id)).toEqual([
      'trk_primaryvideo01',
      BRAND_BUG_TRACK_ID,
      'trk_musicbed000001',
      'trk_titles00000001',
    ]);
    const bug = branded.tracks[1]!.items[0]!;
    expect(bug).toMatchObject({ start: 0, in: 0, out: timelineDuration(t), muted: true });
    expect(withBrand(t, brand, false)).toBe(t);
    expect(withBrand(t, { ...brand, logo: null }, true)).toBe(t);
  });

  it('styles titles and lower thirds with the brand', () => {
    expect(brandTitleStyle(brand, { preset: 'title' })).toEqual({
      preset: 'title',
      color: '#FFFFFF',
      font: { media: brand.fonts.title, family: fontFamily(brand.fonts.title!) },
      box: '#102030',
      boxOpacity: 0.6,
    });
    expect(brandTitleStyle(brand, { preset: 'title', color: '#00FF00', box: null }).box).toBeNull();
    expect(
      lowerThirdItem(brand, brand.lowerThirds[0]!, {
        name: ' Mira Okafor ',
        role: 'Lighthouse keeper',
        start: 2,
      }),
    ).toEqual({
      kind: 'text',
      start: 2,
      duration: 4,
      text: 'Mira Okafor\nLighthouse keeper',
      style: {
        preset: 'lower_third',
        align: 'left',
        color: '#FFFFFF',
        font: { media: brand.fonts.body, family: fontFamily(brand.fonts.body!) },
        box: '#102030',
        boxOpacity: 0.6,
      },
    });
    const credit = lowerThirdItem(brand, brand.lowerThirds[1]!, { name: 'Ben', start: 0 });
    expect(credit.text).toBe('Ben');
    expect(credit.style).toMatchObject({ align: 'right', color: '#FF6B3D', size: 40, box: null });
  });

  it('inserts an intro that moves the other tracks later, and an outro at the end', () => {
    let t = cut();
    t = applyOps(t, [
      {
        op: 'add_bumper',
        position: 'intro',
        source: { type: 'media', media: brand.intro!.media },
        durationSec: 4,
      },
    ]);
    expect(t.tracks[0]!.items.map((i) => [i.start, (i as { out: number }).out])).toEqual([
      [0, 4],
      [4, 6],
    ]);
    expect(t.tracks.find((x) => x.kind === 'text')!.items[0]!.start).toBe(5);
    t = applyOps(t, [
      {
        op: 'add_bumper',
        position: 'outro',
        source: { type: 'media', media: brand.outro!.media },
        durationSec: 3,
      },
    ]);
    expect(t.tracks[0]!.items.map((i) => i.start)).toEqual([0, 4, 10]);
    expect(timelineDuration(t)).toBe(13);
    // a video bumper is never longer than its file
    const short = applyOps(cut(), [
      {
        op: 'add_bumper',
        position: 'intro',
        source: { type: 'media', media: f.media({ durationSec: 2 }) },
        durationSec: 5,
      },
    ]);
    expect(short.tracks[0]!.items[0]).toMatchObject({ in: 0, out: 2 });
  });

  it('draws brand text with its font file and box in the ffmpeg graph', () => {
    let t = cut();
    t = applyOps(t, [
      {
        op: 'add_text',
        item: lowerThirdItem(brand, brand.lowerThirds[0]!, { name: 'Mira', role: 'Keeper', start: 0 }),
      },
    ]);
    t = applyOps(t, [
      { op: 'add_text', item: lowerThirdItem(brand, brand.lowerThirds[1]!, { name: 'Ben', start: 0 }) },
    ]);
    expect(renderInputs(t).map((m) => m.path.split('/').at(-1))).toEqual(
      expect.arrayContaining(['body-0123456789ab.ttf', 'title-0123456789ab.ttf']),
    );
    const [chunk] = planChunks(t, { targetSec: 60 });
    const g = chunkGraph(t, chunk!, {
      quality: 'standard',
      inputPath: (m) => `/in/${m.path.split('/').at(-1)}`,
      fontFile: '/fonts/DejaVuSans.ttf',
      textPath: (i) => `/text/t${i}.txt`,
    });
    const graph = g.args[g.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain("drawtext=fontfile='/in/body-0123456789ab.ttf'");
    expect(graph).toContain('box=1:boxcolor=#102030@0.6');
    expect(graph).toContain("drawtext=fontfile='/in/title-0123456789ab.ttf'");
    expect(graph).toContain("fontfile='/fonts/DejaVuSans.ttf'");
    expect(graph).toMatch(/title-0123456789ab\.ttf'[^[]*box=0/);
    expect(g.textFiles.map((x) => x.content)).toContain('Mira\nKeeper');
  });
});

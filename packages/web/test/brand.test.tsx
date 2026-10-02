import {
  fontFamily,
  lowerThirdItem,
  type ProjectBrand,
  ProjectBrandSchema,
  type TextItem,
  type TimelineOp,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandTools } from '../src/features/editor/BrandTools';
import { drawText } from '../src/features/editor/engine/compositor';

afterEach(cleanup);

const brand: ProjectBrand = ProjectBrandSchema.parse({
  kitId: 'bkt_000000000001',
  name: 'Northwind',
  colors: { text: '#FFFFFF', accent: '#FF6B3D', box: '#102030', boxOpacity: 0.6 },
  fonts: { title: null, body: f.media({ path: 'media/brand/body-0123456789ab.ttf', mime: 'font/ttf' }) },
  logo: null,
  bug: { enabled: false, corner: 'bottom_right', size: 0.1, opacity: 0.8, margin: 0.03 },
  intro: { media: f.media({ path: 'media/brand/intro-0123456789ab.mp4', durationSec: 2 }), durationSec: 2 },
  outro: null,
  lowerThirds: [
    { id: 'name-role', name: 'Name and role', position: 'left', font: 'body', color: 'text', box: true },
  ],
  appliedAt: '2026-10-02T00:00:00.000Z',
});

/** A 2D context that records text, boxes and the font. */
function recorder() {
  const calls: unknown[][] = [];
  const ctx = {
    font: '',
    fillStyle: '',
    textBaseline: '',
    textAlign: '',
    save() {},
    restore() {},
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillRect: (...a: number[]) => calls.push(['fillRect', ctx.fillStyle, ...a]),
    fillText: (t: string, x: number, y: number) => calls.push(['fillText', t, x, y, ctx.font]),
  };
  return { ctx, calls };
}

describe('brand text in the compositor (docs/design/brand-kits.md)', () => {
  it('draws a lower third on two lines in its font, with the brand box', () => {
    const item = {
      id: 'itm_0000000000l3',
      ...lowerThirdItem(brand, brand.lowerThirds[0]!, { name: 'Mira', role: 'Keeper', start: 0 }),
    } as TextItem;
    const { ctx, calls } = recorder();
    drawText(ctx as never, item, 1000, 600);
    const [box, first, second] = calls;
    expect(box![0]).toBe('fillRect');
    expect(box![1]).toBe('rgba(16,32,48,0.6)');
    expect(first!.slice(0, 2)).toEqual(['fillText', 'Mira']);
    expect(second!.slice(0, 2)).toEqual(['fillText', 'Keeper']);
    // one line height apart, from the same left edge, in the brand font
    expect(second![2]).toBe(first![2]);
    expect((second![3] as number) - (first![3] as number)).toBeCloseTo(Math.round(600 / 18) * 1.17, 6);
    expect(first![4]).toContain(`"${fontFamily(brand.fonts.body!)}"`);
  });

  it('draws no box when the style says none', () => {
    const { ctx, calls } = recorder();
    drawText(
      ctx as never,
      {
        id: 'itm_0000000000t1',
        kind: 'text',
        start: 0,
        duration: 1,
        text: 'Bare',
        style: { preset: 'title', box: null },
      },
      1000,
      600,
    );
    expect(calls.map((c) => c[0])).toEqual(['fillText']);
  });
});

describe('brand tools in the editor', () => {
  it('adds a lower third from a template at the playhead, and the intro', () => {
    const apply = vi.fn<(ops: TimelineOp[]) => void>();
    render(<BrandTools brand={brand} time={3.5} apply={apply} />);
    expect(screen.queryByTestId('add-outro')).toBeNull();
    fireEvent.click(screen.getByTestId('lower-third-open'));
    fireEvent.change(screen.getByTestId('lower-third-name'), { target: { value: 'Mira Okafor' } });
    fireEvent.change(screen.getByTestId('lower-third-role'), { target: { value: 'Keeper' } });
    fireEvent.click(screen.getByTestId('lower-third-add'));
    expect(apply).toHaveBeenLastCalledWith([
      {
        op: 'add_text',
        item: lowerThirdItem(brand, brand.lowerThirds[0]!, {
          name: 'Mira Okafor',
          role: 'Keeper',
          start: 3.5,
        }),
      },
    ]);
    fireEvent.click(screen.getByTestId('add-intro'));
    expect(apply).toHaveBeenLastCalledWith([
      {
        op: 'add_bumper',
        position: 'intro',
        source: { type: 'media', media: brand.intro!.media },
        durationSec: 2,
      },
    ]);
  });
});

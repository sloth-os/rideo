import {
  dipWeights,
  emptyTimeline,
  identityCube,
  parseCube,
  type Timeline,
  TimelineSchema,
  wipeEdge,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Compositor } from '../src/features/editor/engine/compositor';
import type { GpuRenderer } from '../src/features/editor/engine/gpu';
import type { GpuDraw } from '../src/features/editor/engine/gpu-plan';
import type { MediaPool } from '../src/features/editor/engine/media-pool';

/** A 2D context that records what is drawn (jsdom has no canvas). */
class Recorder {
  calls: [string, ...unknown[]][] = [];
  globalAlpha = 1;
  filter = 'none';
  fillStyle: unknown = '#000';
  globalCompositeOperation = 'source-over';
  font = '';
  textBaseline = 'alphabetic';
  textAlign = 'left';
  constructor(
    readonly width = 0,
    readonly height = 0,
  ) {}
  private rec(name: string, ...args: unknown[]) {
    this.calls.push([name, ...args]);
  }
  save() {
    this.rec('save');
  }
  restore() {
    this.rec('restore');
  }
  translate(x: number, y: number) {
    this.rec('translate', x, y);
  }
  rotate(a: number) {
    this.rec('rotate', a);
  }
  scale(x: number, y: number) {
    this.rec('scale', x, y);
  }
  fillRect(...a: number[]) {
    this.rec('fillRect', ...a, this.fillStyle, this.globalCompositeOperation);
  }
  clearRect() {}
  beginPath() {}
  rect(...a: number[]) {
    this.rec('rect', ...a);
  }
  clip() {}
  createRadialGradient(...a: number[]) {
    const stops: [number, string][] = [];
    this.rec('createRadialGradient', ...a, stops);
    return { addColorStop: (o: number, c: string) => stops.push([o, c]) };
  }
  measureText(t: string) {
    return { width: t.length * 5 };
  }
  fillText() {}
  drawImage(img: unknown, ...a: number[]) {
    this.rec('drawImage', img, ...a, `alpha=${this.globalAlpha}`);
  }
  getImageData(_x: number, _y: number, w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4).fill(200) };
  }
  putImageData(d: { data: Uint8ClampedArray }) {
    this.rec('putImageData', d.data[3], [...d.data.slice(0, 4)]);
  }
}

class FakeOffscreen {
  ctx: Recorder;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.ctx = new Recorder(width, height);
  }
  getContext() {
    return this.ctx;
  }
}

const media = f.media({
  path: 'media/uploads/a-0123456789ab.mp4',
  width: 1920,
  height: 1080,
  durationSec: 10,
});
const frame = { width: 640, height: 360, tag: 'frame' };
const matte = { width: 640, height: 360, tag: 'matte' };

function pool(): MediaPool {
  return {
    get: async (m: { path: string }) => ({
      video: { getCanvas: async () => ({ canvas: m.path.includes('masks') ? matte : frame }) },
    }),
    image: async () => frame,
    lut: async () => parseCube(identityCube(2)),
  } as unknown as MediaPool;
}

function timeline(overlay: Record<string, unknown>): Timeline {
  const t = emptyTimeline({ fps: 24, width: 640, height: 360 });
  t.tracks[0]!.items.push({
    id: 'itm_0000000000p1',
    kind: 'video',
    source: { type: 'media', media },
    start: 0,
    in: 0,
    out: 4,
    speed: 1,
    volume: 1,
  });
  t.tracks.splice(1, 0, {
    id: 'trk_overlay000001',
    kind: 'video',
    name: 'Overlay',
    items: [
      {
        id: 'itm_0000000000o1',
        kind: 'video',
        source: { type: 'media', media },
        start: 1,
        in: 0,
        out: 2,
        speed: 1,
        volume: 1,
        ...overlay,
      },
    ] as never,
  });
  return TimelineSchema.parse(t);
}

describe('compositor (docs/design/editor.md#multitrack-transforms-and-keyframes)', () => {
  beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeOffscreen));
  afterEach(() => vi.unstubAllGlobals());

  it('draws the primary picture letterboxed, then the overlay fitted, scaled, rotated and at its opacity', async () => {
    const t = timeline({
      transform: { keyframes: [{ t: 0, x: 0.75, y: 0.25, scale: 0.5, rotation: 90, opacity: 0.5 }] },
    });
    const ctx = new Recorder(640, 360);
    await new Compositor(pool(), t).render(ctx as never, 1.5, 640, 360, false);
    const draws = ctx.calls.filter((c) => c[0] === 'drawImage');
    expect(draws).toHaveLength(2);
    // the primary: the frame contained in the output
    expect(draws[0]!.slice(1)).toEqual([frame, 0, 0, 640, 360, 'alpha=1']);
    // the overlay: centred on (0.75, 0.25), rotated a quarter turn, half size, half opaque
    const at = ctx.calls.findIndex((c) => c[0] === 'translate');
    expect(ctx.calls[at]).toEqual(['translate', 480, 90]);
    expect(ctx.calls[at + 1]).toEqual(['rotate', Math.PI / 2]);
    const [, img, x, y, w, h, alpha] = draws[1]!;
    expect((img as FakeOffscreen).width).toBe(640);
    expect([x, y, w, h, alpha]).toEqual([-160, -90, 320, 180, 'alpha=0.5']);
  });

  it('fades an overlay to transparent and cuts it out with its matte', async () => {
    const t = timeline({
      fadeIn: 1,
      mask: {
        media: f.media({ path: 'media/masks/m-0123456789ab.mp4', durationSec: 4 }),
        offset: 0,
        subject: 'the person',
        invert: false,
      },
      lut: {
        media: f.media({ path: 'media/luts/l-0123456789ab.cube', mime: 'application/x-cube' }),
        intensity: 1,
      },
    });
    const ctx = new Recorder(640, 360);
    const c = new Compositor(pool(), t);
    await c.render(ctx as never, 1.25, 640, 360, false);
    const overlay = ctx.calls.filter((x) => x[0] === 'drawImage')[1]!;
    expect(overlay.at(-1)).toBe('alpha=0.25');
    // the picture's alpha comes from the matte's luma (200 → 200·200/255)
    const scratch = overlay[1] as FakeOffscreen;
    const put = scratch.ctx.calls.find((x) => x[0] === 'putImageData');
    expect(put?.[1]).toBe(Math.round((200 * 200) / 255));
  });
});

/** Two primary items of the same media (0–4 s, 4–8 s), the second with a transition of 2 s (3–5 s). */
function twoShots(transition: string | null, first: Record<string, unknown> = {}): Timeline {
  const t = emptyTimeline({ fps: 24, width: 640, height: 360 });
  const shot = (id: string, extra: Record<string, unknown>) => ({
    id,
    kind: 'video',
    source: { type: 'media', media },
    start: 0,
    in: 0,
    out: 5,
    speed: 1,
    volume: 1,
    ...extra,
  });
  t.tracks[0]!.items.push(
    shot('itm_0000000000p1', { ...first, out: 5 }) as never,
    shot('itm_0000000000p2', {
      start: 3,
      transitionIn: transition ? { type: transition, duration: 2 } : null,
    }) as never,
  );
  return TimelineSchema.parse(t);
}

describe('compositor: editing tools (docs/design/editing-tools.md)', () => {
  beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeOffscreen));
  afterEach(() => vi.unstubAllGlobals());

  it('mirrors, adjusts and keys pictures per pixel, the vignette over the frame for a letterboxed one', async () => {
    const t = timeline({ key: { color: '#c8c8c8', similarity: 0.1, blend: 0 } });
    (t.tracks[0]!.items[0] as { flip?: unknown; effects?: unknown }).flip = { x: true };
    (t.tracks[0]!.items[0] as { effects?: unknown }).effects = { exposure: 1 };
    const ctx = new Recorder(640, 360);
    await new Compositor(pool(), t).render(ctx as never, 1.5, 640, 360, false);
    const [primary, overlay] = ctx.calls.filter((c) => c[0] === 'drawImage');
    const pic = primary![1] as FakeOffscreen;
    // mirrored inside the picture's box, then ×2 (200 → 255), alpha kept
    const at = pic.ctx.calls.findIndex((c) => c[0] === 'scale');
    expect(pic.ctx.calls[at - 1]).toEqual(['translate', 640, 0]);
    expect(pic.ctx.calls[at]).toEqual(['scale', -1, 1]);
    // the overlay keyed out where it is the key color (gray 200)
    const keyed = (overlay![1] as FakeOffscreen).ctx.calls.filter((c) => c[0] === 'putImageData');
    expect(keyed.at(-1)![2]).toEqual([200, 200, 200, 0]);
    expect(pic.ctx.calls.filter((c) => c[0] === 'putImageData')[0]![2]).toEqual([255, 255, 255, 200]);
  });

  it('wipes leftward: the incoming frame right of the edge', async () => {
    const ctx = new Recorder(640, 360);
    await new Compositor(pool(), twoShots('wipe')).render(ctx as never, 3.5, 640, 360, false);
    const edge = wipeEdge(0.25, 640);
    expect(ctx.calls.filter((c) => c[0] === 'rect')).toEqual([['rect', edge, 0, 640 - edge, 360]]);
  });

  it('dips through white with the weights of xfade, each frame whole', async () => {
    const ctx = new Recorder(640, 360);
    await new Compositor(pool(), twoShots('dip_to_white')).render(ctx as never, 3.2, 640, 360, false);
    expect(ctx.calls.find((c) => c[0] === 'fillRect')).toEqual([
      'fillRect',
      0,
      0,
      640,
      360,
      '#ffffff',
      'source-over',
    ]);
    const w = dipWeights(0.1);
    const draws = ctx.calls.filter((c) => c[0] === 'drawImage');
    expect(draws.map((d) => Number(String(d.at(-1)).slice(6)))).toEqual([
      expect.closeTo(w.in / (1 - w.out), 9),
      expect.closeTo(w.out, 9),
    ]);
    // the whole frame: black, then the picture letterboxed in it
    const whole = draws[0]![1] as FakeOffscreen;
    expect(whole.width).toBe(640);
    expect(whole.ctx.calls.find((c) => c[0] === 'fillRect')).toEqual([
      'fillRect',
      0,
      0,
      640,
      360,
      '#000',
      'source-over',
    ]);
  });

  it('slides whole frames by whole pixels and opens a soft circle', async () => {
    const ctx = new Recorder(640, 360);
    await new Compositor(pool(), twoShots('slide_left')).render(ctx as never, 4, 640, 360, false);
    // q = 0.5: the outgoing frame at −320, the incoming one at 320
    expect(ctx.calls.filter((c) => c[0] === 'drawImage').map((d) => d.slice(2, 4))).toEqual([
      [-320, 0],
      [320, 0],
    ]);
    const circle = new Recorder(640, 360);
    await new Compositor(pool(), twoShots('circle_open')).render(circle as never, 4, 640, 360, false);
    const [out, inc] = circle.calls.filter((c) => c[0] === 'drawImage');
    expect(out!.slice(2, 4)).toEqual([0, 0]);
    const masked = (inc![1] as FakeOffscreen).ctx;
    const gradient = masked.calls.find((c) => c[0] === 'createRadialGradient')!;
    expect(gradient.slice(1, 7)).toEqual([320.5, 180.5, 0, 320.5, 180.5, Math.hypot(320, 180)]);
    expect((gradient[7] as unknown[]).length).toBe(16);
    expect(masked.calls.find((c) => c[0] === 'fillRect')!.at(-1)).toBe('destination-in');
  });

  it('hands dips and circles to the canvas, and gives WebGPU the rest with mirrors and slides', async () => {
    const render = vi.fn((_draws: GpuDraw[]) => ({ close: () => {} }));
    const gpu = { lost: false, render } as unknown as GpuRenderer;
    const dip = new Compositor(pool(), twoShots('dip_to_black'));
    dip.setGpu(gpu);
    await dip.render(new Recorder(640, 360) as never, 3.5, 640, 360, false);
    expect(render).not.toHaveBeenCalled();
    expect(dip.backend).toBe('webgpu');
    const slide = new Compositor(pool(), twoShots('slide_up', { flip: { x: true } }));
    slide.setGpu(gpu);
    await slide.render(new Recorder(640, 360) as never, 4, 640, 360, false);
    const draws = render.mock.calls[0]![0] as Extract<GpuDraw, { kind: 'picture' }>[];
    expect(draws.map((d) => d.clip)).toEqual([
      [0, 0, 640, 180],
      [0, 180, 640, 180],
    ]);
    expect(draws[0]!.uv[2]).toBeLessThan(0);
    expect(draws.map((d) => d.placement.cy)).toEqual([0, 360]);
  });
});

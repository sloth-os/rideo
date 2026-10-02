import { emptyTimeline, identityCube, parseCube, type Timeline, TimelineSchema } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Compositor } from '../src/features/editor/engine/compositor';
import type { MediaPool } from '../src/features/editor/engine/media-pool';

/** A 2D context that records what is drawn (jsdom has no canvas). */
class Recorder {
  calls: [string, ...unknown[]][] = [];
  globalAlpha = 1;
  filter = 'none';
  fillStyle = '#000';
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
  fillRect(...a: number[]) {
    this.rec('fillRect', ...a);
  }
  clearRect() {}
  beginPath() {}
  rect() {}
  clip() {}
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
    this.rec('putImageData', d.data[3]);
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
    expect(put).toEqual(['putImageData', Math.round((200 * 200) / 255)]);
  });
});

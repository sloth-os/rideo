import { type Job, newId, parseCube } from '@rideo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepAlive } from '../src/engine/keep-alive';
import { HEAVY_PIXELS, proxyName, proxyPlan } from '../src/engine/proxy-plan';
import { threadBudget, withThreads } from '../src/engine/threads';
import { startTicker } from '../src/engine/ticker';
import { type EditorApi, EditorWorker } from '../src/engine/worker';
import {
  clipOf,
  compositorChoice,
  containPlacement,
  layerUniforms,
  lutTexels,
  placementToClip,
  toHalf,
  uvOf,
  wipeScissor,
} from '../src/features/editor/engine/gpu-plan';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ffmpeg.wasm threads (docs/design/engine-performance.md)', () => {
  it('gives each decoder and the output threads within the core pool', () => {
    const graph = [
      '-i',
      '/in/a',
      '-i',
      '/in/b',
      '-filter_complex',
      '[0:v][1:v]overlay[v]',
      '-map',
      '[v]',
      '/out/o.mp4',
    ];
    expect(withThreads(graph, 4)).toEqual([
      '-threads',
      '2',
      '-i',
      '/in/a',
      '-threads',
      '2',
      '-i',
      '/in/b',
      '-filter_complex',
      '[0:v][1:v]overlay[v]',
      '-map',
      '[v]',
      '-threads',
      '4',
      '-filter_complex_threads',
      '4',
      '/out/o.mp4',
    ]);
    // a probe has no output; commands with their own threads and without inputs are left alone
    expect(withThreads(['-hide_banner', '-i', '/in/src'], 4)).toEqual([
      '-hide_banner',
      '-threads',
      '2',
      '-i',
      '/in/src',
    ]);
    expect(withThreads(['-threads', '1', '-i', 'x', 'y'], 8)).toEqual(['-threads', '1', '-i', 'x', 'y']);
    expect(withThreads(['-f', 'lavfi', 'anullsrc', 'y'], 8)).toEqual(['-f', 'lavfi', 'anullsrc', 'y']);
    expect(threadBudget(64, 7)).toEqual({ output: 8, decoder: 1 });
    expect(threadBudget(0, 1)).toEqual({ output: 1, decoder: 2 });
  });
});

describe('WebGPU geometry (docs/design/engine-performance.md#webgpu-compositing)', () => {
  const out = { width: 1920, height: 1080 };

  it('maps a full-frame quad to clip space, y up', () => {
    const m = placementToClip({ cx: 960, cy: 540, w: 1920, h: 1080, rotation: 0 }, out);
    expect(clipOf(m, 0, 0)).toEqual([-1, 1]);
    expect(clipOf(m, 1, 1)).toEqual([1, -1]);
  });

  it('places a rotated picture as the canvas does (translate, rotate, draw centred)', () => {
    const p = { cx: 1500, cy: 300, w: 640, h: 360, rotation: 30 };
    const m = placementToClip(p, out);
    const t = (30 * Math.PI) / 180;
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      // the canvas: translate(cx, cy); rotate(t); drawImage(-w/2, -h/2, w, h)
      const lx = (u - 0.5) * p.w;
      const ly = (v - 0.5) * p.h;
      const px = p.cx + lx * Math.cos(t) - ly * Math.sin(t);
      const py = p.cy + lx * Math.sin(t) + ly * Math.cos(t);
      const [x, y] = clipOf(m, u, v);
      expect(x).toBeCloseTo((px / out.width) * 2 - 1, 9);
      expect(y).toBeCloseTo(1 - (py / out.height) * 2, 9);
    }
  });

  it('fits pictures as drawContain, and takes their windows as UV rectangles', () => {
    expect(containPlacement({ width: 1080, height: 1920 }, 1920, 1080)).toEqual({
      cx: 960,
      cy: 540,
      w: 607.5,
      h: 1080,
      rotation: 0,
    });
    expect(uvOf({ x: 240, y: 0, width: 1440, height: 1080 }, out)).toEqual([0.125, 0, 0.75, 1]);
    expect(wipeScissor(0.25, 1920, 1080)).toEqual([0, 0, 480, 1080]);
    expect(wipeScissor(undefined, 1920, 1080)).toEqual([0, 0, 1920, 1080]);
  });

  it('lays out a draw for the shader: placement, UVs, effects, LUT, matte', () => {
    const cube = parseCube(
      'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n',
    );
    const source = { width: 1920, height: 1080 } as unknown as HTMLCanvasElement;
    const u = layerUniforms(
      {
        kind: 'picture',
        source,
        uv: [0, 0, 1, 1],
        placement: { cx: 960, cy: 540, w: 1920, h: 1080, rotation: 0 },
        effects: { brightness: 0.2, contrast: 1.1, saturation: 0.5 },
        opacity: 0.8,
        lut: { cube, intensity: 0.6 },
        matte: { source, uv: [0.1, 0, 0.8, 1], invert: true },
      },
      out,
    );
    expect([...u.slice(8, 16)]).toEqual([0, 0, 1, 1, expect.closeTo(0.1, 6), 0, expect.closeTo(0.8, 6), 1]);
    expect([...u.slice(16, 20)].map((x) => Math.round(x * 1000) / 1000)).toEqual([1.2, 1.1, 0.5, 0.8]);
    expect([...u.slice(20, 24)].map((x) => Math.round(x * 1000) / 1000)).toEqual([0.6, 2, 2, 0]);
    const fill = layerUniforms({ kind: 'fill', opacity: 0.4 }, out);
    expect([...fill.slice(16, 24)].map((x) => Math.round(x * 1000) / 1000)).toEqual([
      1, 1, 1, 0.4, 0, 2, 0, 1,
    ]);
  });

  it('writes LUTs as half floats, red fastest', () => {
    expect([1, 0.5, 0, 65504, -2, 6e-8].map(toHalf)).toEqual([0x3c00, 0x3800, 0, 0x7bff, 0xc000, 1]);
    const cube = parseCube('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
    const texels = lutTexels(cube);
    // texel 1 (x = 1): red; texel 2 (y = 1): green; texel 4 (z = 1): blue; alpha 1
    expect([...texels.slice(4, 8)]).toEqual([0x3c00, 0, 0, 0x3c00]);
    expect([...texels.slice(8, 12)]).toEqual([0, 0x3c00, 0, 0x3c00]);
    expect([...texels.slice(16, 20)]).toEqual([0, 0, 0x3c00, 0x3c00]);
  });

  it('chooses WebGPU when there is an adapter, unless the canvas is forced', () => {
    expect(compositorChoice(null, true)).toBe('webgpu');
    expect(compositorChoice('auto', false)).toBe('canvas');
    expect(compositorChoice('canvas', true)).toBe('canvas');
  });
});

describe('local proxies (docs/design/engine-performance.md#local-proxies-made-with-webcodecs)', () => {
  it('makes them with WebCodecs whenever it decodes the original', () => {
    expect(proxyPlan({ decodes: true, plays: true, purpose: 'playback' })).toBeNull();
    expect(proxyPlan({ decodes: true, plays: false, height: 1080, purpose: 'playback' })).toEqual({
      method: 'webcodecs',
      height: 480,
    });
    expect(proxyPlan({ decodes: true, plays: false, height: 360, purpose: 'playback' })).toEqual({
      method: 'webcodecs',
      height: 360,
    });
    expect(proxyPlan({ decodes: false, plays: false, height: 2160, purpose: 'playback' })).toEqual({
      method: 'ffmpeg',
      height: 480,
    });
    // editing proxies: heavy originals only, and only when WebCodecs reads them
    expect(proxyPlan({ decodes: true, plays: true, width: 3840, height: 2160, purpose: 'editing' })).toEqual({
      method: 'webcodecs',
      height: 720,
    });
    expect(
      proxyPlan({ decodes: true, plays: true, width: 1920, height: 1080, purpose: 'editing' }),
    ).toBeNull();
    expect(
      proxyPlan({ decodes: false, plays: false, width: 3840, height: 2160, purpose: 'editing' }),
    ).toBeNull();
    expect(2560 * 1440).toBe(HEAVY_PIXELS);
    expect(proxyName('ab'.repeat(32), { method: 'webcodecs', height: 480 })).toBe(
      `${'ab'.repeat(32)}-webcodecs-480-v2.webm`,
    );
  });
});

describe('rendering in a background tab (docs/design/engine-performance.md#rendering-in-a-background-tab)', () => {
  it('ticks from a worker, and from the page where workers are missing', () => {
    vi.useFakeTimers();
    const page: number[] = [];
    const t1 = startTicker(1000, () => page.push(1));
    expect(t1.source).toBe('page');
    vi.advanceTimersByTime(3000);
    expect(page).toHaveLength(3);
    t1.stop();

    const posted: unknown[] = [];
    class FakeWorker {
      onmessage: (() => void) | null = null;
      postMessage(m: unknown) {
        posted.push(m);
      }
      terminate() {
        posted.push('terminated');
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }),
    );
    const ticks: number[] = [];
    const t2 = startTicker(500, () => ticks.push(1));
    expect(t2.source).toBe('worker');
    expect(posted).toEqual([500]);
    t2.stop();
    expect(posted).toEqual([500, 0, 'terminated']);
  });

  it('holds a lock named after the job, and a wake lock while visible', async () => {
    const events: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, fn: () => Promise<unknown>) => {
          events.push(`lock ${name}`);
          const r = await fn();
          events.push('unlock');
          return r;
        },
      },
      wakeLock: {
        request: async () => {
          events.push('wake');
          return { released: false, release: async () => void events.push('sleep') };
        },
      },
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    expect(await keepAlive('job_1', async () => events.push('run') && 'done')).toBe('done');
    expect(events).toEqual(['lock rideo-editor-job:job_1', 'wake', 'run', 'sleep', 'unlock']);
  });

  it('heartbeats on its ticker and runs jobs kept alive', async () => {
    const job = {
      id: newId('job'),
      projectId: 'prj_01m3s0000000000000',
      kind: 'export.render',
      lane: 'client',
      status: 'running',
      params: {},
      progress: { done: 0, total: 1 },
      attempts: 1,
      maxAttempts: 5,
      branch: 'main',
      actor: { kind: 'user', id: 'local' },
      priority: 0,
      gatewayTasks: [],
      lease: { sessionId: 's1', claimedAt: 'x', expiresAt: 'y' },
      staged: [],
      createdAt: '2026-10-02T00:00:00.000Z',
    } as Job;
    const queue = [job];
    const api: EditorApi = {
      editorClaim: vi.fn(async () => ({ job: queue.shift() ?? null })),
      editorHeartbeat: vi.fn(async () => ({ cancelled: false, leaseExpiresAt: 'later' })),
      editorUpload: vi.fn(async () => undefined),
      editorComplete: vi.fn(async () => undefined),
      editorFail: vi.fn(async () => undefined),
    };
    let tick: (() => void) | null = null;
    const kept: string[] = [];
    let release: () => void = () => undefined;
    const worker = new EditorWorker({
      api,
      pollMs: 60_000,
      ticker: (ms, onTick) => {
        expect(ms).toBe(10_000);
        tick = onTick;
        return { source: 'worker', stop: () => kept.push('stopped') };
      },
      keepAlive: async (jobId, run) => {
        kept.push(`kept ${jobId}`);
        return run();
      },
      handlers: {
        'export.render': () => new Promise((r) => (release = () => r({ parts: 1 }))),
        'media.process': async () => ({}),
        'analysis.signals': async () => ({}),
      },
    });
    worker.setSession(() => 's1');
    worker.setProject(job.projectId);
    await new Promise((r) => setTimeout(r, 10));
    expect(kept).toEqual([`kept ${job.id}`]);
    (tick as unknown as () => void)();
    expect(api.editorHeartbeat).toHaveBeenCalledWith(job.id, 's1', { done: 0, total: 1 });
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(api.editorComplete).toHaveBeenCalledWith(job.id, 's1', { parts: 1 });
    expect(kept).toEqual([`kept ${job.id}`, 'stopped']);
    worker.setProject(null);
  });
});

import { type Job, newId, parseCube } from '@rideo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHeartbeat } from '../src/engine/heartbeat';
import { keepAlive } from '../src/engine/keep-alive';
import { HEAVY_PIXELS, proxyName, proxyPlan } from '../src/engine/proxy-plan';
import { scalerCount, THREAD_POOL, threadBudget, withThreads } from '../src/engine/threads';
import { startTicker } from '../src/engine/ticker';
import { type EditorApi, EditorWorker } from '../src/engine/worker';
import {
  clipOf,
  compositorChoice,
  containPlacement,
  flipUv,
  LAYER_FLOATS,
  layerUniforms,
  lutTexels,
  placementToClip,
  scissorOf,
  slideClip,
  toHalf,
  uvOf,
  vignetteOf,
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
    expect(threadBudget(64, 7)).toEqual({ output: 8, decoder: 1, filters: 8, inputThreads: true });
    expect(threadBudget(0, 1)).toEqual({ output: 1, decoder: 2, filters: 1, inputThreads: false });
  });

  it('counts the scalers, each with a pool of the graph’s threads, and keeps the whole command in the pool', () => {
    // a cut with a freeze frame, a keyed and adjusted item and a slide: four inputs, scalers and conversions
    const graph = [
      '[0:v]trim=start=0:end=3,scale=320:180,format=yuv420p[s0]',
      '[1:v]select=1,reverse,scale=320:180,format=yuv420p[s1]',
      '[2:v]trim=start=0:end=3,scale=320:180,format=yuv420p[s2]',
      '[3:v]scale=320:180,hflip,format=yuv420p[s3]',
      '[s3]format=rgb24,lutrgb=r=val,format=rgba,colorkey=0x00FF00:0.3:0.1[c4]',
      '[c4]format=rgba[t5]',
      'color=c=black:s=320x180,format=yuv420p[bg6]',
      '[bg6][t5]overlay=x=0:y=0:format=auto,format=yuv420p[v3]',
      '[s0][s1]concat=n=2:v=1:a=0[x1]',
      '[x1][s2]concat=n=2:v=1:a=0[x2]',
      '[x2][v3]xfade=transition=slideleft:duration=0.5:offset=7.5[x3]',
      '[x3]format=yuv420p[vout]',
    ].join(';');
    expect(scalerCount(graph)).toBe(4 + 11 + 2 + 1 + 1);
    // audio filters are not scalers
    expect(scalerCount('[0:a]aformat=sample_rates=48000[a]')).toBe(1);
    const args = [
      '-i',
      'a',
      '-i',
      'b',
      '-i',
      'c',
      '-i',
      'd',
      '-filter_complex',
      graph,
      '-map',
      '[vout]',
      'o.mp4',
    ];
    const threads = withThreads(args, 4);
    expect(threads.slice(-5)).toEqual(['-threads', '4', '-filter_complex_threads', '1', 'o.mp4']);
    // every plan fits 30 of the 32 threads, giving up filter threads, then input threads, decoders', the encoder's
    for (const [cores, inputs, scalers] of [
      [4, 4, 19],
      [8, 2, 4],
      [8, 6, 12],
      [8, 14, 30],
      [2, 1, 0],
    ] as const) {
      const plan = threadBudget(cores, inputs, scalers);
      expect(threadsOf(plan, inputs, scalers)).toBeLessThanOrEqual(THREAD_POOL - 2);
    }
    expect(threadBudget(8, 2, 4)).toEqual({ output: 8, decoder: 2, filters: 4, inputThreads: true });
    // decoders at one thread decode on the main thread: the encoder keeps its threads
    expect(threadBudget(8, 14, 30)).toEqual({ output: 8, decoder: 1, filters: 1, inputThreads: true });
  });

  it('reads the inputs on the main thread when a thread each would not fit, as for a long cut’s soundtrack', () => {
    // a ten-minute film of five-second shots: the soundtrack opens each of its 118 audio segments as an input
    const segments = Array.from({ length: 118 }, (_, k) => [
      '-ss',
      '0',
      '-t',
      '5.1',
      '-i',
      `/in/take${k}.mp4`,
    ]);
    const mix = `${segments.map((_, k) => `[a${k}]`).join('')}amix=inputs=118:normalize=0[aout]`;
    const args = [
      ...segments.flat(),
      '-filter_complex',
      mix,
      '-map',
      '[aout]',
      '-c:a',
      'flac',
      '/out/s.flac',
    ];
    const threads = withThreads(args, 8);
    // every input is read and decoded on the main thread; the output keeps its threads
    expect(threads.slice(0, 10)).toEqual([
      '-ss',
      '0',
      '-t',
      '5.1',
      '-thread_queue_size',
      '0',
      '-threads',
      '1',
      '-i',
      '/in/take0.mp4',
    ]);
    expect(threads.filter((a) => a === '-thread_queue_size')).toHaveLength(118);
    expect(threads.slice(-5)).toEqual(['-threads', '8', '-filter_complex_threads', '1', '/out/s.flac']);
    expect(threadBudget(8, 118, 1)).toEqual({ output: 8, decoder: 1, filters: 1, inputThreads: false });
    // at eight cores up to 21 inputs keep a thread each, as FFmpeg reads them by default
    expect(threadBudget(8, 21, 1).inputThreads).toBe(true);
    expect(threadBudget(8, 22, 1).inputThreads).toBe(false);
    expect(withThreads(['-i', 'a', '-i', 'b', 'o.mp4'], 8)).not.toContain('-thread_queue_size');
    // any number of inputs and scalers fits the pool
    for (const cores of [1, 2, 4, 8, 16])
      for (const inputs of [1, 2, 6, 7, 20, 26, 40, 118, 500])
        for (const scalers of [0, 4, 30, 200]) {
          const plan = threadBudget(cores, inputs, scalers);
          expect(threadsOf(plan, inputs, scalers)).toBeLessThanOrEqual(THREAD_POOL - 2);
        }
  });
});

/** The threads a command planned so asks of the pool (docs/design/engine-performance.md). */
function threadsOf(plan: ReturnType<typeof threadBudget>, inputs: number, scalers: number): number {
  return (
    (plan.inputThreads ? inputs : 0) +
    (plan.decoder > 1 ? inputs * plan.decoder : 0) +
    (plan.filters - 1) * (1 + scalers) +
    plan.output +
    1
  );
}

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
    // a wipe shows the incoming frame right of its edge (xfade's wipeleft); a slide clips to its frame
    expect(scissorOf({ wipe: 0.25 }, 1920, 1080)).toEqual([1441, 0, 479, 1080]);
    expect(scissorOf({}, 1920, 1080)).toEqual([0, 0, 1920, 1080]);
    expect(slideClip([-480, 0], 1920, 1080)).toEqual([0, 0, 1440, 1080]);
    expect(slideClip([1440, 0], 1920, 1080)).toEqual([1440, 0, 480, 1080]);
    expect(slideClip([0, 540], 1920, 1080)).toEqual([0, 540, 1920, 540]);
    expect(scissorOf({ wipe: 0.5, clip: [0, 0, 1000, 1080] }, 1920, 1080)).toEqual([961, 0, 39, 1080]);
    // mirrors reverse the texture coordinates
    expect(flipUv([0.125, 0, 0.75, 1], { x: true })).toEqual([0.875, 0, -0.75, 1]);
    expect(flipUv([0, 0.1, 1, 0.8], { y: true })).toEqual([0, expect.closeTo(0.9, 9), 1, -0.8]);
    expect(flipUv([0, 0, 1, 1], undefined)).toEqual([0, 0, 1, 1]);
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
    // no adjustment, no key: the integer steps are off
    expect(u.length).toBe(LAYER_FLOATS);
    expect(u[35]).toBe(0);
    expect(u[43]).toBe(0);
  });

  it('lays out the adjustments, the key and the vignette (docs/design/editing-tools.md)', () => {
    const source = { width: 1920, height: 1080 } as unknown as HTMLCanvasElement;
    const effects = {
      exposure: 1,
      temperature: 0.5,
      shadows: 0.25,
      highlights: -0.5,
      hue: 90,
      vignette: 0.5,
    };
    const u = layerUniforms(
      {
        kind: 'picture',
        source,
        uv: [0, 0, 1, 1],
        placement: { cx: 960, cy: 540, w: 1920, h: 1080, rotation: 0 },
        effects,
        opacity: 1,
        key: { color: '#00ff00', similarity: 0.3, blend: 0.1 },
        vignette: vignetteOf(effects, { frame: [1920, 1080], origin: [-480, 0] }),
      },
      out,
    );
    const r = (a: Float32Array) => [...a].map((x) => Math.round(x * 1000) / 1000);
    // gains ×2 (warmer: red up, blue down), on
    expect(r(u.slice(32, 36))).toEqual([2.3, 2, 1.7, 1]);
    // tone, the vignette's angle (π/4) and its space (the frame)
    expect(r(u.slice(36, 40))).toEqual([0.25, -0.5, 0.785, 0]);
    // the hue matrix's rows, the key on with its similarity and blend
    expect(r(u.slice(40, 52)).filter((_, i) => i % 4 === 3)).toEqual([1, 0.3, 0.1]);
    expect(r(u.slice(52, 56))).toEqual([0, 1, 0, 0]);
    expect(r(u.slice(56, 60))).toEqual([1920, 1080, -480, 0]);
    expect(vignetteOf({}, { picture: [640, 360] })).toBeNull();
    expect(vignetteOf({ vignette: 1 }, { picture: [640, 360] })).toMatchObject({
      space: 'picture',
      width: 640,
    });
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

  it('sends heartbeats from a worker with the latest progress, and stops a job whose lease is lost', async () => {
    // the pump: a worker that posts the heartbeat itself
    const posted: unknown[] = [];
    let onmessage: ((e: { data: unknown }) => void) | null = null;
    class FakeWorker {
      set onmessage(fn: (e: { data: unknown }) => void) {
        onmessage = fn;
      }
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
    const replies: unknown[] = [];
    const pump = startHeartbeat(
      {
        url: '/api/editor/jobs/j1/heartbeat',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
        ms: 10_000,
      },
      (r) => replies.push(r),
    );
    expect(pump.source).toBe('worker');
    pump.update('{"a":2}');
    (onmessage as unknown as (e: { data: unknown }) => void)({
      data: { status: 200, json: { cancelled: false } },
    });
    pump.stop();
    expect(posted).toEqual([
      {
        type: 'start',
        url: new URL('/api/editor/jobs/j1/heartbeat', location.href).href,
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
        ms: 10_000,
      },
      { type: 'body', body: '{"a":2}' },
      { type: 'stop' },
      'terminated',
    ]);
    expect(replies).toEqual([{ status: 200, json: { cancelled: false } }]);

    // the editor worker uses it when the API can hand the heartbeat over
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
      editorHeartbeatRequest: (jobId) => ({ url: `/api/editor/jobs/${jobId}/heartbeat`, headers: {} }),
    };
    let reply: ((r: { status: number; json: unknown }) => void) | null = null;
    const bodies: string[] = [];
    const worker = new EditorWorker({
      api,
      pollMs: 60_000,
      progressMs: 60_000,
      heartbeat: (req, onReply) => {
        expect(req.url).toBe(`/api/editor/jobs/${job.id}/heartbeat`);
        bodies.push(req.body);
        reply = onReply;
        return { source: 'worker', update: (b) => bodies.push(b), stop: () => bodies.push('stopped') };
      },
      keepAlive: (_id, run) => run(),
      handlers: {
        'export.render': (ctx) =>
          new Promise((_, reject) => {
            ctx.progress(1, 4, 'chunk 1/4');
            ctx.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
        'media.process': async () => ({}),
        'analysis.signals': async () => ({}),
      },
    });
    worker.setSession(() => 's1');
    worker.setProject(job.projectId);
    await new Promise((r) => setTimeout(r, 10));
    expect(JSON.parse(bodies[0]!)).toEqual({ sessionId: 's1', progress: { done: 0, total: 1 } });
    expect(JSON.parse(bodies[1]!)).toEqual({
      sessionId: 's1',
      progress: { done: 1, total: 4, message: 'chunk 1/4' },
    });
    // the lease is lost: the run stops, unreported
    (reply as unknown as (r: { status: number; json: unknown }) => void)({
      status: 409,
      json: { code: 'lease_lost' },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(bodies.at(-1)).toBe('stopped');
    expect(api.editorComplete).not.toHaveBeenCalled();
    expect(api.editorFail).not.toHaveBeenCalled();
    worker.setProject(null);
  });

  it('keeps one heartbeat in flight when the page sends them (a stuck one is not joined by more)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', undefined);
    let answer: ((r: Response) => void) | null = null;
    const fetches = vi.fn(
      () =>
        new Promise<Response>((r) => {
          answer = r;
        }),
    );
    vi.stubGlobal('fetch', fetches);
    const replies: unknown[] = [];
    const pump = startHeartbeat(
      { url: '/api/editor/jobs/j1/heartbeat', headers: {}, body: '{}', ms: 1000 },
      (r) => replies.push(r),
    );
    expect(pump.source).toBe('page');
    await vi.advanceTimersByTimeAsync(3500);
    expect(fetches).toHaveBeenCalledTimes(1);
    (answer as unknown as (r: Response) => void)(new Response('{"cancelled":false}', { status: 200 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(replies).toEqual([{ status: 200, json: { cancelled: false } }]);
    expect(fetches).toHaveBeenCalledTimes(2);
    pump.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

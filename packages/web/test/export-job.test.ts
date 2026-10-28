import {
  applyOps,
  DEFAULT_TRACK_IDS,
  type ExportRenderResultSchema,
  emptyTimeline,
  type Job,
  type MediaRef,
  newId,
  primaryTrack,
  type Timeline,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

/** The browser's `export.render` (docs/design/editor.md#memory): no graph holds the whole film's media. */

const run = vi.fn();
vi.mock('../src/engine/ffmpeg', () => ({ FONT_PATH: '/fonts/DejaVuSans.ttf', ffmpeg: { run } }));
const mediaBlob = vi.fn(async (_p: string, m: MediaRef) => new Blob([m.hash]));
vi.mock('../src/engine/media-files', async (original) => ({
  ...(await original<typeof import('../src/engine/media-files')>()),
  mediaBlob,
}));
let timeline: Timeline;
vi.mock('../src/lib/api', () => ({ api: { timeline: async () => timeline, doc: async () => timeline } }));
vi.mock('../src/features/editor/engine/capabilities', () => ({
  detectCaps: async () => ({ webcodecs: false, video: null, audio: null, container: null }),
}));
vi.mock('../src/features/editor/engine/gpu-choice', () => ({ gpuRenderer: async () => null }));
vi.mock('../src/features/editor/engine/media-pool', () => ({ MediaPool: class {} }));
vi.mock('../src/engine/fonts', () => ({ ensureVideoFont: async () => undefined }));
vi.mock('../src/lib/telemetry', () => ({ recordTiming: () => undefined }));
vi.mock('../src/engine/render/webcodecs-engine', () => ({ renderChunkWebCodecs: vi.fn() }));
vi.mock('../src/engine/codecs', () => ({ webCodecsCanDecode: async () => true }));

const { exportRenderJob } = await import('../src/engine/render/export-job');

/** 30 five-second takes with their sound (150 s) under a music bed. */
function film(): { t: Timeline; takes: MediaRef[]; bed: MediaRef } {
  const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
  const takes = Array.from({ length: 30 }, () => f.media({ durationSec: 5 }));
  const bed = f.media({ durationSec: 200, mime: 'audio/mpeg', width: undefined, height: undefined });
  const t = applyOps(base, [
    ...takes.map((media) => ({
      op: 'insert' as const,
      trackId: primaryTrack(base).id,
      item: { kind: 'video' as const, source: { type: 'media' as const, media }, in: 0, out: 5 },
    })),
    {
      op: 'insert',
      trackId: DEFAULT_TRACK_IDS.audio,
      item: { kind: 'audio', source: { type: 'media', media: bed }, start: 0, in: 0, out: 150 },
    },
  ]);
  return { t, takes, bed };
}

function job(staged: string[] = [], stems = false): Job {
  return {
    id: newId('job'),
    projectId: 'prj_01m3s0000000000000',
    kind: 'export.render',
    lane: 'client',
    status: 'running',
    params: { exportId: newId('export'), quality: 'draft', engine: 'ffmpeg', chunkSec: 30, stems },
    progress: { done: 0, total: 1 },
    attempts: 1,
    maxAttempts: 5,
    branch: 'main',
    actor: { kind: 'user', id: 'local' },
    priority: 0,
    gatewayTasks: [],
    lease: { sessionId: 's1', claimedAt: 'x', expiresAt: 'y' },
    staged,
    createdAt: '2026-10-28T00:00:00.000Z',
  } as unknown as Job;
}

function context(j: Job) {
  const uploads: { name: string; data: Blob }[] = [];
  return {
    uploads,
    ctx: {
      job: j,
      projectId: j.projectId,
      signal: new AbortController().signal,
      progress: vi.fn(),
      upload: vi.fn(async (name: string, data: Blob) => {
        uploads.push({ name, data });
      }),
    },
  };
}

beforeEach(() => {
  run.mockReset();
  run.mockImplementation(async (_args: string[], opts: { outputs?: string[] }) => ({
    code: 0,
    log: [],
    outputs: Object.fromEntries((opts.outputs ?? []).map((p) => [p, new Uint8Array([1, 2, 3])])),
  }));
  mediaBlob.mockClear();
});

describe('export.render in the tab (docs/design/editor.md#memory)', () => {
  it('loads each chunk’s and each soundtrack window’s own media, and uploads each output as a Blob', async () => {
    const { t, takes, bed } = film();
    timeline = t;
    const { ctx, uploads } = context(job([], true));
    const result = (await exportRenderJob(ctx)) as z.infer<typeof ExportRenderResultSchema>;
    // 150 s: five 30 s chunks, two soundtrack windows (60 s, then 90 s)
    expect(result.parts).toHaveLength(5);
    expect(result.soundtrack).toEqual(['soundtrack-0001.flac', 'soundtrack-0002.flac']);
    expect(result.stems).toEqual({
      dialogue: ['stem-dialogue-0001.flac', 'stem-dialogue-0002.flac'],
      music: ['stem-music-0001.flac', 'stem-music-0002.flac'],
      effects: ['stem-effects-0001.flac', 'stem-effects-0002.flac'],
    });
    expect(uploads.map((u) => u.name)).toEqual([
      ...result.parts,
      'soundtrack-0001.flac',
      'stem-dialogue-0001.flac',
      'stem-music-0001.flac',
      'stem-effects-0001.flac',
      'soundtrack-0002.flac',
      'stem-dialogue-0002.flac',
      'stem-music-0002.flac',
      'stem-effects-0002.flac',
    ]);
    // Blobs, never bytes: Chrome copies a body of bytes whole into the DevTools protocol (docs/design/editor.md#memory)
    expect(uploads.every((u) => u.data instanceof Blob)).toBe(true);
    // Every ffmpeg command mounts only what its graph reads: a chunk six takes, a window its takes and the bed
    const mounted = run.mock.calls.map(([, opts]) => Object.keys((opts as { inputs: object }).inputs).length);
    expect(mounted.slice(0, 5)).toEqual([6, 6, 6, 6, 6]);
    expect(mounted.slice(5)).toEqual([13, 19]);
    expect(Math.max(...mounted)).toBeLessThan(takes.length);
    const soundtrack = run.mock.calls
      .slice(5)
      .map(([, opts]) => Object.keys((opts as { inputs: object }).inputs));
    for (const names of soundtrack) expect(names.some((n) => n.startsWith(bed.hash.slice(0, 24)))).toBe(true);
  });

  it('resumes at the first window not staged', async () => {
    const { t } = film();
    timeline = t;
    const parts = Array.from({ length: 5 }, (_, i) => `part-${String(i + 1).padStart(4, '0')}.ffmpeg.mp4`);
    const { ctx, uploads } = context(job([...parts, 'soundtrack-0001.flac']));
    const result = (await exportRenderJob(ctx)) as z.infer<typeof ExportRenderResultSchema>;
    expect(uploads.map((u) => u.name)).toEqual(['soundtrack-0002.flac']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.soundtrack).toEqual(['soundtrack-0001.flac', 'soundtrack-0002.flac']);
  });
});

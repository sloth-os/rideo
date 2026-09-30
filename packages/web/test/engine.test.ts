import { type Job, newId } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorJobError } from '../src/engine/context';
import { chooseEngine, partName } from '../src/engine/render/engine-choice';
import { type EditorApi, EditorWorker } from '../src/engine/worker';
import type { EngineCaps } from '../src/features/editor/engine/capabilities';
import { ApiError } from '../src/lib/api';

const caps = (video: EngineCaps['video']): EngineCaps => ({
  webcodecs: true,
  video,
  audio: 'opus',
  container: video ? 'webm' : null,
});

describe('render engine choice', () => {
  const h264 = f.media({ durationSec: 5 });
  const decodes = async () => true;
  const nothing = async () => false;

  it('auto takes WebCodecs only when every source decodes and video encodes', async () => {
    expect(await chooseEngine('auto', caps('vp9'), [h264], decodes)).toBe('webcodecs');
    expect(await chooseEngine('auto', caps('vp9'), [h264], nothing)).toBe('ffmpeg');
    expect(await chooseEngine('auto', caps(null), [h264], decodes)).toBe('ffmpeg');
    expect(await chooseEngine('auto', caps('vp9'), [f.media({ mime: 'audio/mpeg' })], nothing)).toBe(
      'webcodecs',
    );
  });

  it('honours explicit choices and refuses WebCodecs without an encoder', async () => {
    expect(await chooseEngine('ffmpeg', caps('vp9'), [h264], decodes)).toBe('ffmpeg');
    expect(await chooseEngine('webcodecs', caps('vp9'), [h264], nothing)).toBe('webcodecs');
    await expect(chooseEngine('webcodecs', caps(null), [h264], decodes)).rejects.toBeInstanceOf(
      EditorJobError,
    );
    expect(partName(0, 'ffmpeg', 'mp4')).toBe('part-0001.ffmpeg.mp4');
  });
});

function job(extra: Partial<Job> = {}): Job {
  return {
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
    createdAt: '2026-09-30T00:00:00.000Z',
    ...extra,
  } as Job;
}

function fakeApi(queue: Job[]) {
  const calls: string[] = [];
  const api: EditorApi = {
    editorClaim: vi.fn(async () => ({ job: queue.shift() ?? null })),
    editorHeartbeat: vi.fn(async () => ({ cancelled: false, leaseExpiresAt: 'later' })),
    editorUpload: vi.fn(async (_j: string, _s: string, name: string) => calls.push(`upload:${name}`)),
    editorComplete: vi.fn(async (_j: string, _s: string, result: unknown) =>
      calls.push(`complete:${JSON.stringify(result)}`),
    ),
    editorFail: vi.fn(async (_j: string, _s: string, e: { code: string }) => calls.push(`fail:${e.code}`)),
  };
  return { api, calls };
}

const idle = () => new Promise((r) => setTimeout(r, 20));

describe('editor-job worker', () => {
  afterEach(() => vi.useRealTimers());

  it('claims only with a project and a session, runs one job at a time and completes it', async () => {
    const { api, calls } = fakeApi([job(), job({ kind: 'media.process' })]);
    const busy: (string | null)[] = [];
    const worker = new EditorWorker({
      api,
      pollMs: 60_000,
      handlers: {
        'export.render': async (ctx) => {
          ctx.progress(1, 2, 'chunk 1/1');
          await ctx.upload('part-0001.ffmpeg.mp4', new Blob(['x']));
          return { parts: 1 };
        },
        'media.process': async () => ({ probe: 'ok' }),
        'analysis.signals': async () => ({}),
      },
      onChange: (b) => busy.push(b?.kind ?? null),
    });
    await worker.poke();
    expect(api.editorClaim).not.toHaveBeenCalled();
    worker.setSession(() => 's1');
    worker.setProject('prj_01m3s0000000000000');
    await idle();
    expect(calls).toEqual(['upload:part-0001.ffmpeg.mp4', 'complete:{"parts":1}', 'complete:{"probe":"ok"}']);
    expect(busy).toContain('export.render');
    expect(busy.at(-1)).toBeNull();
    expect(api.editorHeartbeat).toHaveBeenCalledWith(expect.any(String), 's1', {
      done: 1,
      total: 2,
      message: 'chunk 1/1',
    });
    worker.setProject(null);
  });

  it('reports failures with their code, but not cancellations or lost leases', async () => {
    const failing = fakeApi([job()]);
    const w1 = new EditorWorker({
      api: failing.api,
      pollMs: 60_000,
      handlers: {
        'export.render': async () => {
          throw new EditorJobError('webcodecs_unavailable', 'no encoder');
        },
        'media.process': async () => ({}),
        'analysis.signals': async () => ({}),
      },
    });
    w1.setSession(() => 's1');
    w1.setProject('prj_01m3s0000000000000');
    await idle();
    expect(failing.calls).toEqual(['fail:webcodecs_unavailable']);
    w1.setProject(null);

    const cancelled = fakeApi([job()]);
    cancelled.api.editorHeartbeat = vi.fn(async () => ({ cancelled: true, leaseExpiresAt: null }));
    const w2 = new EditorWorker({
      api: cancelled.api,
      pollMs: 60_000,
      progressMs: 0,
      handlers: {
        'export.render': async (ctx) => {
          ctx.progress(1, 10);
          await new Promise((r) => setTimeout(r, 10));
          if (ctx.signal.aborted) throw new DOMException('cancelled', 'AbortError');
          return {};
        },
        'media.process': async () => ({}),
        'analysis.signals': async () => ({}),
      },
    });
    w2.setSession(() => 's1');
    w2.setProject('prj_01m3s0000000000000');
    await idle();
    expect(cancelled.calls).toEqual([]);
    w2.setProject(null);

    const lost = fakeApi([job()]);
    lost.api.editorHeartbeat = vi.fn(async () => {
      throw new ApiError(409, { type: '', title: '', status: 409, detail: 'gone', code: 'lease_lost' });
    });
    const w3 = new EditorWorker({
      api: lost.api,
      pollMs: 60_000,
      progressMs: 0,
      handlers: {
        'export.render': async (ctx) => {
          ctx.progress(1, 10);
          await new Promise((r) => setTimeout(r, 10));
          await ctx.upload('late.mp4', new Blob(['x']));
          return {};
        },
        'media.process': async () => ({}),
        'analysis.signals': async () => ({}),
      },
    });
    w3.setSession(() => 's1');
    w3.setProject('prj_01m3s0000000000000');
    await idle();
    expect(lost.calls).toEqual([]);
    w3.setProject(null);
  });

  it('retries a claim that overtook the live subscription', async () => {
    const { api } = fakeApi([]);
    let calls = 0;
    api.editorClaim = vi.fn(async () => {
      calls++;
      if (calls === 1)
        throw new ApiError(409, {
          type: '',
          title: '',
          status: 409,
          detail: 'subscribe first',
          code: 'conflict',
        });
      return { job: null };
    });
    const worker = new EditorWorker({
      api,
      pollMs: 60_000,
      handlers: {
        'export.render': async () => ({}),
        'media.process': async () => ({}),
        'analysis.signals': async () => ({}),
      },
    });
    worker.setSession(() => 's1');
    worker.setProject('prj_01m3s0000000000000');
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(2);
    worker.setProject(null);
  });
});

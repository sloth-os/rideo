import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Job, parseProbe, posterCommand, probeCommand, type Resource } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEditorWorker } from '../helpers/editor-worker';
import { makeFootage } from '../helpers/media';
import { ApiError, type Stack, startStack } from '../helpers/stack';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ env: { RIDEO_EDITOR_LEASE_SEC: '2' } });
});
afterAll(async () => {
  await stack?.stop();
});

async function liveSession(projectId: string) {
  const ws = new WebSocket(`${stack.url.replace(/^http/, 'ws')}/api/live`);
  const sessionId = await new Promise<string>((ok) =>
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.type === 'hello') ok(msg.sessionId);
    }),
  );
  ws.send(JSON.stringify({ type: 'subscribe', projectId }));
  await new Promise((r) => setTimeout(r, 50));
  return { sessionId, close: () => ws.close() };
}

async function expectProblem(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status, body: { code } });
}

const ffmpeg = (args: string[]) =>
  spawnSync(process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg', ['-y', ...args], { encoding: 'utf8' });

async function project(title: string) {
  return stack.api<{ id: string }>('POST', '/projects', {
    kind: 'edit',
    title,
    settings: { resolution: { width: 320, height: 180 } },
  });
}

/** A browser-probed 9 s source and a timeline of `copies` of it. */
async function timelineOf(projectId: string, copies: number): Promise<Resource> {
  const file = await makeFootage(stack.dataDir);
  const form = new FormData();
  form.set('meta', JSON.stringify({ probe: parseProbe(ffmpeg(probeCommand(file)).stderr) }));
  form.set('file', new Blob([await readFile(file)], { type: 'video/mp4' }), 'src.mp4');
  const res = await stack.api<Resource>('POST', `/projects/${projectId}/uploads`, form);
  const track = (await stack.api<any>('GET', `/projects/${projectId}/timeline`)).tracks[0].id;
  await stack.api('POST', `/projects/${projectId}/timeline/ops`, {
    ops: Array.from({ length: copies }, () => ({
      op: 'insert',
      trackId: track,
      item: { kind: 'video', source: { type: 'media', media: res.media }, in: 0, out: 9 },
    })),
  });
  return res;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('editor jobs over REST', () => {
  it('leases jobs only to live sessions of the project and validates every step', async () => {
    const p = await project('Protocol');
    await expectProblem(
      stack.api('POST', '/editor/claim', { sessionId: 'session_nope', projectId: p.id }),
      409,
      'conflict',
    );
    const s1 = await liveSession(p.id);
    const s2 = await liveSession(p.id);
    try {
      expect(await stack.api('POST', '/editor/claim', { sessionId: s1.sessionId, projectId: p.id })).toEqual({
        job: null,
      });
      const file = await makeFootage(stack.dataDir);
      const form = new FormData();
      form.set('file', new Blob([await readFile(file)], { type: 'video/mp4' }), 'a.mp4');
      const res = await stack.api<Resource>('POST', `/projects/${p.id}/uploads`, form);
      const { job } = await stack.api<{ job: Job }>('POST', '/editor/claim', {
        sessionId: s1.sessionId,
        projectId: p.id,
      });
      expect(job).toMatchObject({
        kind: 'media.process',
        status: 'running',
        lease: { sessionId: s1.sessionId },
        params: { resourceId: res.id },
      });
      await expectProblem(
        stack.api('POST', `/editor/jobs/${job.id}/heartbeat`, { sessionId: s2.sessionId }),
        409,
        'lease_lost',
      );
      const beat = await stack.api<any>('POST', `/editor/jobs/${job.id}/heartbeat`, {
        sessionId: s1.sessionId,
        progress: { done: 1, total: 2, message: 'probing' },
      });
      expect(beat.cancelled).toBe(false);
      const put = (name: string, sessionId: string, body: Uint8Array | string) =>
        fetch(`${stack.url}/api/editor/jobs/${job.id}/files/${name}?sessionId=${sessionId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body,
        });
      expect((await put('Bad%20Name.jpg', s1.sessionId, 'x')).status).toBe(422);
      expect((await put('poster.jpg', s2.sessionId, 'x')).status).toBe(409);
      const probe = parseProbe(ffmpeg(probeCommand(file)).stderr)!;
      await expectProblem(
        stack.api('POST', `/editor/jobs/${job.id}/complete`, {
          sessionId: s1.sessionId,
          result: { probe: { nope: 1 } },
        }),
        422,
        'validation_error',
      );
      await expectProblem(
        stack.api('POST', `/editor/jobs/${job.id}/complete`, {
          sessionId: s1.sessionId,
          result: { probe, poster: 'poster.jpg' },
        }),
        422,
        'validation_error',
      );
      const poster = join(stack.dataDir, 'protocol-poster.jpg');
      ffmpeg(posterCommand(file, poster, probe));
      expect((await put('poster.jpg', s1.sessionId, await readFile(poster))).status).toBe(200);
      const done = await stack.api<Job>('POST', `/editor/jobs/${job.id}/complete`, {
        sessionId: s1.sessionId,
        result: { probe, poster: 'poster.jpg' },
      });
      expect(done).toMatchObject({ status: 'succeeded', lease: null, staged: ['poster.jpg'] });
      const state = await stack.api<any>('GET', `/projects/${p.id}/state`);
      expect(state.docs.resources[res.id]).toMatchObject({
        status: 'ready',
        media: { videoCodec: 'h264', durationSec: 9 },
      });
      expect(state.docs.resources[res.id].media.poster.path).toMatch(/^media\/posters\//);
    } finally {
      s1.close();
      s2.close();
    }
  }, 120_000);

  it('resumes an interrupted render at the first missing part after the tab closed', async () => {
    const p = await project('Resume');
    await timelineOf(p.id, 6); // 54 s → two 30 s-plan chunks
    const dying = await startEditorWorker(stack, p.id, { dieAfterParts: 1 });
    const out = await stack.api<any>('POST', `/projects/${p.id}/exports`, { quality: 'draft' });
    await dying.stopped;
    const released = await until(
      () => stack.api<Job>('GET', `/projects/${p.id}/jobs/${out.job.id}`),
      (j) => j.status === 'queued',
    );
    expect(released).toMatchObject({
      staged: ['part-0001.mp4'],
      lease: null,
      error: { code: 'lease_released' },
    });
    const next = await startEditorWorker(stack, p.id);
    const done = await stack.waitExport(p.id, out.export.id);
    await next.stop();
    await dying.stop();
    expect(done, JSON.stringify(done)).toMatchObject({ status: 'succeeded', engine: 'ffmpeg' });
    expect(done.durationSec).toBeCloseTo(54, 0);
    const render = await stack.api<Job>('GET', `/projects/${p.id}/jobs/${out.job.id}`);
    expect(render, JSON.stringify({ ...render, params: undefined })).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    });
    expect(render.staged).toEqual(['part-0001.mp4', 'part-0002.mp4', 'soundtrack.m4a']);
  }, 180_000);

  it('reports cancellation through the heartbeat, fails the export, and requeues expired leases', async () => {
    const p = await project('Cancel');
    await timelineOf(p.id, 1);
    const s1 = await liveSession(p.id);
    try {
      const first = await stack.api<any>('POST', `/projects/${p.id}/exports`, {});
      const { job } = await stack.api<{ job: Job }>('POST', '/editor/claim', {
        sessionId: s1.sessionId,
        projectId: p.id,
      });
      expect(job.id).toBe(first.job.id);
      await until(
        () => stack.api<any[]>('GET', `/projects/${p.id}/exports`),
        (e) => e[0].status === 'rendering',
      );
      await stack.api('POST', `/projects/${p.id}/jobs/${job.id}/cancel`);
      expect(
        await stack.api('POST', `/editor/jobs/${job.id}/heartbeat`, { sessionId: s1.sessionId }),
      ).toEqual({
        cancelled: true,
        leaseExpiresAt: null,
      });
      const failed = await until(
        () => stack.api<any[]>('GET', `/projects/${p.id}/exports`),
        (e) => e.find((x) => x.id === first.export.id)?.status === 'failed',
      );
      expect(failed.find((x) => x.id === first.export.id).error).toMatch(/cancel/);

      const second = await stack.api<any>('POST', `/projects/${p.id}/exports`, {});
      await stack.api('POST', '/editor/claim', { sessionId: s1.sessionId, projectId: p.id });
      const expired = await until(
        () => stack.api<Job>('GET', `/projects/${p.id}/jobs/${second.job.id}`),
        (j) => j.status === 'queued' && j.error?.code === 'lease_expired',
        10_000,
      );
      expect(expired.lease).toBeNull();
    } finally {
      s1.close();
    }
  }, 120_000);
});

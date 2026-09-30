import { newId } from '@rideo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors';
import { type JobHandler, JobQueue } from '../../src/jobs/queue';
import { LiveHub } from '../../src/live/hub';
import { Metrics } from '../../src/metrics';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';

const silent = { info() {}, warn() {}, error() {} };
const actor = { kind: 'user' as const, id: 'local' };
const projectId = newId('project');
const queues: JobQueue[] = [];

function makeQueue(
  lanes: Record<string, number> = {},
  storage = new MemoryBackend(),
  editorLeaseMs = 60_000,
) {
  const hub = new LiveHub();
  const q = new JobQueue({
    storage,
    layout: new Layout('/rideo'),
    hub,
    metrics: new Metrics(),
    log: silent,
    lanes: { control: 1, llm: 1, image: 1, video: 1, music: 1, media: 1, ...lanes },
    editorLeaseMs,
  });
  queues.push(q);
  return { q, hub, storage };
}

afterEach(async () => {
  for (const q of queues.splice(0)) await q.shutdown();
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('job queue', () => {
  it('limits lane concurrency and honours priority', async () => {
    const { q } = makeQueue({ video: 1 });
    const gate = deferred();
    const order: string[] = [];
    const handler: JobHandler = async (ctx) => {
      order.push(String(ctx.job.params.name));
      if (ctx.job.params.name === 'first') await gate.promise;
      return ctx.job.params.name;
    };
    q.register('shot.generate', handler);
    const first = await q.enqueue({
      projectId,
      kind: 'shot.generate',
      params: { name: 'first' },
      actor,
      branch: 'main',
    });
    const low = await q.enqueue({
      projectId,
      kind: 'shot.generate',
      params: { name: 'low' },
      actor,
      branch: 'main',
      priority: 1,
    });
    const high = await q.enqueue({
      projectId,
      kind: 'shot.generate',
      params: { name: 'high' },
      actor,
      branch: 'main',
      priority: 10,
    });
    expect(q.find(low.id)!.status).toBe('queued');
    gate.resolve();
    await Promise.all([q.wait(first.id), q.wait(low.id), q.wait(high.id)]);
    expect(order).toEqual(['first', 'high', 'low']);
    expect(q.find(high.id)!.result).toBe('high');
  });

  it('dedupes active jobs by key', async () => {
    const { q } = makeQueue();
    const gate = deferred();
    q.register('batch.generate', async () => gate.promise);
    const a = await q.enqueue({
      projectId,
      kind: 'batch.generate',
      actor,
      branch: 'main',
      dedupeKey: 'batch',
    });
    const b = await q.enqueue({
      projectId,
      kind: 'batch.generate',
      actor,
      branch: 'main',
      dedupeKey: 'batch',
    });
    expect(b.id).toBe(a.id);
    gate.resolve();
    await q.wait(a.id);
    const c = await q.enqueue({
      projectId,
      kind: 'batch.generate',
      actor,
      branch: 'main',
      dedupeKey: 'batch',
    });
    expect(c.id).not.toBe(a.id);
  });

  it('retries retryable errors and fails others with their code', async () => {
    const { q } = makeQueue();
    let calls = 0;
    q.register('clip.plan', async () => {
      calls++;
      if (calls === 1) throw new AppError('llm_invalid_output', 'bad json', [], true);
      return 'ok';
    });
    q.register('clip.generate', async () => {
      throw new AppError('character_not_locked', 'Mira is not locked');
    });
    const retried = await q.wait(
      (await q.enqueue({ projectId, kind: 'clip.plan', actor, branch: 'main' })).id,
    );
    expect(retried.status).toBe('succeeded');
    expect(retried.attempts).toBe(2);
    const failed = await q.wait(
      (await q.enqueue({ projectId, kind: 'clip.generate', actor, branch: 'main' })).id,
    );
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'character_not_locked', retryable: false });
  }, 10_000);

  it('cancels running jobs and their children', async () => {
    const { q } = makeQueue({ control: 2, video: 1 });
    q.register(
      'shot.generate',
      (ctx) =>
        new Promise((_, reject) =>
          ctx.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('x'), { name: 'AbortError' })),
          ),
        ),
    );
    q.register('clip.generate', async (ctx) => {
      const child = await ctx.spawn('shot.generate', {});
      await ctx.waitFor([child.id]);
      ctx.signal.throwIfAborted();
    });
    const parent = await q.enqueue({ projectId, kind: 'clip.generate', actor, branch: 'main' });
    await new Promise((r) => setTimeout(r, 30));
    const child = q.list(projectId, { kind: 'shot.generate' })[0]!;
    await q.cancel(projectId, parent.id);
    expect((await q.wait(parent.id)).status).toBe('cancelled');
    expect((await q.wait(child.id)).status).toBe('cancelled');
  });

  it('releases the lane slot while waiting for children (no deadlock with one control slot)', async () => {
    const { q } = makeQueue({ control: 1 });
    q.register('batch.generate', async (ctx) => {
      const child = await ctx.spawn('clip.generate', {});
      const [done] = await ctx.waitFor([child.id]);
      return done!.result;
    });
    q.register('clip.generate', async () => 'child-done');
    const parent = await q.enqueue({ projectId, kind: 'batch.generate', actor, branch: 'main' });
    const finished = await q.wait(parent.id, 5000);
    expect(finished.status).toBe('succeeded');
    expect(finished.result).toBe('child-done');
  });

  it('publishes progress and recovers interrupted jobs after a restart', async () => {
    const storage = new MemoryBackend();
    const first = makeQueue({}, storage);
    const events: string[] = [];
    first.hub.on((_p, _s, e) => {
      if (e.kind === 'job') events.push(`${e.job.status}:${e.job.progress.done}`);
    });
    const hang = deferred();
    first.q.register('export.finish', async (ctx) => {
      ctx.progress(1, 4, 'rendering');
      await hang.promise;
    });
    const job = await first.q.enqueue({ projectId, kind: 'export.finish', actor, branch: 'main' });
    await new Promise((r) => setTimeout(r, 320));
    await first.q.shutdown();
    hang.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toContain('running:1');

    const second = makeQueue({}, storage);
    second.q.register('export.finish', async () => 'rendered');
    expect(await second.q.loadProject(projectId, true)).toBe(1);
    const done = await second.q.wait(job.id, 5000);
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(2);
  });
});

describe('editor jobs (client lane)', () => {
  const enqueue = (
    q: JobQueue,
    kind: 'export.render' | 'media.process',
    extra: Record<string, unknown> = {},
  ) => q.enqueue({ projectId, kind, params: {}, actor, branch: 'main', maxAttempts: 3, ...extra });

  it('never runs them on the server; tabs claim by priority, then age, per project and kind', async () => {
    const { q } = makeQueue();
    const first = await enqueue(q, 'export.render');
    await new Promise((r) => setTimeout(r, 5));
    const second = await enqueue(q, 'export.render');
    const urgent = await enqueue(q, 'media.process', { priority: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(q.find(first.id)!.status).toBe('queued');
    expect(await q.claim(newId('project'), 's1')).toBeNull();
    expect((await q.claim(projectId, 's1', ['export.render']))!.id).toBe(first.id);
    const claimed = (await q.claim(projectId, 's2'))!;
    expect(claimed.id).toBe(urgent.id);
    expect(claimed).toMatchObject({ status: 'running', attempts: 1, lease: { sessionId: 's2' } });
    expect(Date.parse(claimed.lease!.expiresAt) - Date.now()).toBeGreaterThan(59_000);
    expect((await q.claim(projectId, 's3'))!.id).toBe(second.id);
    expect(await q.claim(projectId, 's3')).toBeNull();
  });

  it('extends leases on heartbeat, rejects other sessions and keeps staged files across a released lease', async () => {
    const { q } = makeQueue();
    const job = await enqueue(q, 'export.render');
    await q.claim(projectId, 's1');
    const before = q.find(job.id)!.lease!.expiresAt;
    await new Promise((r) => setTimeout(r, 5));
    const beat = q.heartbeat(job.id, 's1', { done: 1, total: 4, message: 'chunk 1/3' });
    expect(beat.cancelled).toBe(false);
    expect(beat.leaseExpiresAt! > before).toBe(true);
    expect(q.find(job.id)!.progress).toEqual({ done: 1, total: 4, message: 'chunk 1/3' });
    expect(() => q.heartbeat(job.id, 's2')).toThrowError(expect.objectContaining({ code: 'lease_lost' }));
    await q.staged(job.id, 's1', 'part-0001.mp4');
    await q.releaseSession('s1');
    const released = q.find(job.id)!;
    expect(released).toMatchObject({
      status: 'queued',
      lease: null,
      staged: ['part-0001.mp4'],
      error: { code: 'lease_released' },
    });
    expect(await q.claim(projectId, 's2')).toBeNull(); // backoff
    await new Promise((r) => setTimeout(r, 1050));
    expect(await q.claim(projectId, 's2')).toMatchObject({
      id: job.id,
      attempts: 2,
      staged: ['part-0001.mp4'],
    });
  });

  it('expires silent tabs and gives up after maxAttempts, running the end hook once', async () => {
    const { q } = makeQueue({}, new MemoryBackend(), 50);
    const ended: string[] = [];
    q.onEditorJobEnded = async (j) => {
      ended.push(`${j.id}:${j.status}`);
    };
    const job = await enqueue(q, 'media.process', { maxAttempts: 2 });
    await q.claim(projectId, 's1');
    expect(await q.expireLeases(Date.now() + 100)).toBe(1);
    expect(q.find(job.id)).toMatchObject({ status: 'queued', error: { code: 'lease_expired' } });
    await new Promise((r) => setTimeout(r, 1050));
    await q.claim(projectId, 's1');
    const waited = q.wait(job.id);
    await q.expireLeases(Date.now() + 100);
    expect((await waited).status).toBe('failed');
    expect(ended).toEqual([`${job.id}:failed`]);
  });

  it('reports cancellation to the tab and completes with waiters resolved', async () => {
    const { q } = makeQueue();
    const ended: string[] = [];
    q.onEditorJobEnded = async (j) => {
      ended.push(j.status);
    };
    const doomed = await enqueue(q, 'export.render');
    await q.claim(projectId, 's1');
    await q.cancel(projectId, doomed.id);
    expect(q.heartbeat(doomed.id, 's1')).toEqual({ cancelled: true, leaseExpiresAt: null });
    expect(ended).toEqual(['cancelled']);
    const job = await enqueue(q, 'media.process');
    await q.claim(projectId, 's1');
    const waited = q.wait(job.id);
    await q.completeEditor(job.id, 's1', { ok: true });
    expect(await waited).toMatchObject({ status: 'succeeded', lease: null, result: { ok: true } });
    await expect(q.completeEditor(job.id, 's1', {})).rejects.toBeInstanceOf(AppError);
    const failing = await enqueue(q, 'media.process');
    await q.claim(projectId, 's1');
    expect(
      await q.failEditor(failing.id, 's1', { code: 'wasm_oom', message: 'out of memory' }),
    ).toMatchObject({
      status: 'queued',
      error: { code: 'wasm_oom', retryable: true },
    });
  });

  it('recovers editor jobs after a restart without their lease', async () => {
    const storage = new MemoryBackend();
    const { q } = makeQueue({}, storage);
    const job = await enqueue(q, 'export.render');
    await q.claim(projectId, 's1');
    await q.staged(job.id, 's1', 'soundtrack.m4a');
    await q.shutdown();
    const { q: next } = makeQueue({}, storage);
    expect(await next.loadProject(projectId, true)).toBe(1);
    expect(next.find(job.id)).toMatchObject({ status: 'queued', lease: null, staged: ['soundtrack.m4a'] });
    expect((await next.claim(projectId, 's9'))!.lease!.sessionId).toBe('s9');
  });
});

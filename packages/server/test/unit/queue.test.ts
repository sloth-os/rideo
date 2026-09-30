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

function makeQueue(lanes: Record<string, number> = {}, storage = new MemoryBackend()) {
  const hub = new LiveHub();
  const q = new JobQueue({
    storage,
    layout: new Layout('/rideo'),
    hub,
    metrics: new Metrics(),
    log: silent,
    lanes: { control: 1, llm: 1, image: 1, video: 1, music: 1, media: 1, ...lanes },
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
    first.q.register('export.render', async (ctx) => {
      ctx.progress(1, 4, 'rendering');
      await hang.promise;
    });
    const job = await first.q.enqueue({ projectId, kind: 'export.render', actor, branch: 'main' });
    await new Promise((r) => setTimeout(r, 320));
    await first.q.shutdown();
    hang.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toContain('running:1');

    const second = makeQueue({}, storage);
    second.q.register('export.render', async () => 'rendered');
    expect(await second.q.loadProject(projectId, true)).toBe(1);
    const done = await second.q.wait(job.id, 5000);
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(2);
  });
});

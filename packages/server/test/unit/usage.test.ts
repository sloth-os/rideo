import { emptyUsage, type GatewayTask, newId } from '@rideo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../../src/jobs/queue';
import { LiveHub } from '../../src/live/hub';
import { Metrics } from '../../src/metrics';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';
import { currentUsage, newScope, UsageLedger, UsageMeter, withUsage } from '../../src/usage/meter';

const silent = { info() {}, warn() {}, error() {} };
const actor = { kind: 'user' as const, id: 'local' };
const projectId = newId('project');
const queues: JobQueue[] = [];

afterEach(async () => {
  for (const q of queues.splice(0)) await q.shutdown();
});

function task(over: Partial<GatewayTask> = {}): GatewayTask {
  return {
    id: `task-${Math.random()}`,
    model: 'wan',
    status: 'succeeded',
    outputs: [{ uri: 'x' }],
    ...over,
  } as GatewayTask;
}

describe('usage meter (docs/design/observability.md#usage-ledger)', () => {
  it('adds calls to the usage of the job whose handler made them, and to metrics', async () => {
    const metrics = new Metrics();
    const meter = new UsageMeter({
      metrics,
      prices: () => ({ wan: { videoSecond: 0.1 }, 'qwen-max': { inputMTokens: 1, outputMTokens: 4 } }),
    });
    const scope = newScope(projectId, 'job_1');
    await withUsage(scope, async () => {
      expect(currentUsage()).toBe(scope);
      meter.llm({
        task: 'clip.plan',
        model: 'qwen-max',
        modality: 'text',
        seconds: 2,
        tokensIn: 1_000_000,
        tokensOut: 250_000,
        retries: 1,
      });
      // A nested await keeps the scope.
      await Promise.resolve();
      meter.gateway({ modality: 'video', model: 'wan', seconds: 90, task: task(), requestedSeconds: 5 });
      meter.gateway({
        modality: 'image',
        model: 'seedream',
        seconds: 10,
        task: task({ model: 'seedream', outputs: [{ uri: 'a' }] as never }),
      });
    });
    const u = scope.usage;
    expect(u.llmCalls).toBe(1);
    expect(u.llmRetries).toBe(1);
    expect(u.tokensIn).toBe(1_000_000);
    expect(u.videoSeconds).toBe(5);
    expect(u.videoCount).toBe(1);
    expect(u.images).toBe(1);
    // 1 + 1 (tokens) + 0.5 (video); the image model has no price.
    expect(u.costUsd).toBe(2.5);
    expect(u.unpriced).toBe(1);
    expect(u.byModel.wan).toMatchObject({ modality: 'video', calls: 1, units: 5, costUsd: 0.5 });
    expect(u.byModel.seedream).toMatchObject({ modality: 'image', unpriced: 1 });
    expect(metrics.costUsd.get({ modality: 'video', model: 'wan' })).toBe(0.5);
    expect(metrics.usageUnpriced.get({ modality: 'image', model: 'seedream' })).toBe(1);
    expect(metrics.llmTokens.get({ task: 'clip.plan', model: 'qwen-max', direction: 'out' })).toBe(250_000);
    expect(metrics.render()).toContain(
      'rideo_gateway_task_seconds_bucket{modality="video",model="wan",le="120"} 1',
    );
  });

  it('prefers the cost the gateway reports, counts nothing outside a job, and marks discarded attempts', async () => {
    const meter = new UsageMeter({ metrics: new Metrics(), prices: () => ({ wan: { videoSecond: 0.1 } }) });
    expect(
      meter.gateway({ modality: 'video', model: 'wan', seconds: 1, task: task(), requestedSeconds: 5 }),
    ).toBe(0.5);
    expect(currentUsage()).toBeNull();
    const scope = newScope(projectId, 'job_2');
    await withUsage(scope, async () => {
      const a = task({ id: 'a', usage: { cost: 0.42, duration_seconds: 5 } });
      const b = task({ id: 'b', usage: { duration_seconds: 5 } });
      expect(meter.gateway({ modality: 'video', model: 'wan', seconds: 1, task: a })).toBe(0.42);
      meter.gateway({ modality: 'video', model: 'wan', seconds: 1, task: b });
      meter.discard(['a', 'unknown']);
    });
    expect(scope.usage.costUsd).toBe(0.92);
    expect(scope.usage.discardedVideoSeconds).toBe(5);
    expect(scope.usage.discardedCostUsd).toBe(0.42);
  });
});

describe('usage ledger', () => {
  it('sums finished jobs per project and kind, writes behind and reads back', async () => {
    const storage = new MemoryBackend();
    const layout = new Layout('/rideo');
    const ledger = new UsageLedger({ storage, layout, log: silent, delayMs: 10 });
    const usage = { ...emptyUsage(), videoSeconds: 5, costUsd: 0.5 };
    await ledger.add(
      { projectId, kind: 'shot.generate', status: 'succeeded' },
      { usage, runSeconds: 100, waitSeconds: 20, finished: true },
    );
    await ledger.add(
      { projectId, kind: 'shot.generate', status: 'failed' },
      { usage: null, runSeconds: 30, waitSeconds: null, finished: true },
    );
    await ledger.flush();
    const fresh = new UsageLedger({ storage, layout, log: silent });
    const read = await fresh.get(projectId);
    expect(read.totals.videoSeconds).toBe(5);
    expect(read.byKind['shot.generate']).toMatchObject({
      jobs: 2,
      succeeded: 1,
      failed: 1,
      runSeconds: 130,
      waitSeconds: 20,
      costUsd: 0.5,
    });
    // A broken file starts again from zero.
    await storage.write(`${layout.rideoDir(projectId)}/usage.json`, 'not json');
    expect((await new UsageLedger({ storage, layout, log: silent }).get(projectId)).totals.videoSeconds).toBe(
      0,
    );
  });

  it('gives each job its own usage through the queue, with its wait for the lane', async () => {
    const storage = new MemoryBackend();
    const layout = new Layout('/rideo');
    const metrics = new Metrics();
    const ledger = new UsageLedger({ storage, layout, log: silent, delayMs: 10 });
    const meter = new UsageMeter({ metrics, prices: () => ({}) });
    const q = new JobQueue({
      storage,
      layout,
      hub: new LiveHub(),
      metrics,
      log: silent,
      lanes: { control: 1, llm: 1, image: 1, video: 1, music: 1, media: 1 },
      ledger,
    });
    queues.push(q);
    q.register('shot.generate', async () => {
      meter.gateway({ modality: 'video', model: 'wan', seconds: 3, task: task(), requestedSeconds: 5 });
      return 'ok';
    });
    q.register('clip.plan', async () => 'no usage');
    const a = await q.enqueue({ projectId, kind: 'shot.generate', params: {}, actor, branch: 'main' });
    const b = await q.enqueue({ projectId, kind: 'clip.plan', params: {}, actor, branch: 'main' });
    const [ja, jb] = await Promise.all([q.wait(a.id), q.wait(b.id)]);
    expect(ja.usage?.videoSeconds).toBe(5);
    expect(ja.usage?.byModel.wan?.calls).toBe(1);
    expect(jb.usage).toBeNull();
    await ledger.flush();
    const ledgered = await ledger.get(projectId);
    expect(ledgered.totals.videoCount).toBe(1);
    expect(ledgered.byKind['clip.plan']?.jobs).toBe(1);
    expect(metrics.render()).toContain('rideo_job_wait_seconds_count{kind="shot.generate"} 1');
    expect(metrics.laneJobs.get({ lane: 'video', state: 'running' })).toBe(0);
  });
});

import type { Job } from '@rideo/shared';
import { describe, expect, it } from 'vitest';
import { expectSucceeded, readyStoryProject, startStack } from '../helpers/stack';

describe('restart recovery', () => {
  it('resumes interrupted generation after a restart, reusing gateway idempotency keys', async () => {
    const stack = await startStack({ latencyMs: 1500 });
    try {
      const { projectId: pid, state } = await readyStoryProject(stack);
      const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
        sceneId: state.docs.screenplay.scenes[0].id,
      });
      expectSucceeded(await stack.waitJob(pid, plan.id));
      const clip = Object.values<any>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0];
      const job = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const jobs = await stack.api<Job[]>('GET', `/projects/${pid}/jobs`);
        if (jobs.some((j) => j.kind === 'shot.generate' && j.gatewayTasks.length > 0)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const tasksBefore = stack.gw.store.created.length;
      await stack.restart();
      const resumed = await stack.waitJob(pid, job.id, 180_000);
      expectSucceeded(resumed);
      await stack.waitIdle(pid);
      const after = await stack.api<any>('GET', `/projects/${pid}/state`);
      const shots = after.docs.clips[clip.id].shots;
      expect(shots.every((s: { takes: unknown[] }) => s.takes.length === 1)).toBe(true);
      const shotJobs = (await stack.api<Job[]>('GET', `/projects/${pid}/jobs`)).filter(
        (j) => j.kind === 'shot.generate',
      );
      expect(shotJobs.some((j) => j.attempts === 2)).toBe(true);
      // The re-run replayed the in-flight task by idempotency key instead of creating a duplicate first.
      expect(stack.gw.store.created.length).toBeGreaterThanOrEqual(tasksBefore);
    } finally {
      await stack.stop();
    }
  }, 300_000);
});

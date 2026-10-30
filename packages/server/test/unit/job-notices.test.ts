import { JobSchema } from '@rideo/shared';
import { describe, expect, it } from 'vitest';
import { jobNotice } from '../../src/domain/job-notices';

/** What finished work tells its person (docs/design/pwa.md#notifications-on-the-phone-web-push). */
const job = (over: Record<string, unknown>) =>
  JobSchema.parse({
    id: 'job_0000000000aaaaaa',
    projectId: 'prj_0000000000aaaaaa',
    lane: 'control',
    status: 'succeeded',
    params: {},
    progress: { done: 1, total: 1 },
    attempts: 1,
    maxAttempts: 3,
    branch: 'main',
    actor: { kind: 'user', id: 'u', name: 'U' },
    priority: 0,
    gatewayTasks: [],
    createdAt: '2026-10-29T00:00:00.000Z',
    ...over,
  });

describe('job notices of the reviews of every step', () => {
  it("says a cast or cut review's verdict", () => {
    expect(
      jobNotice(job({ kind: 'cast.review', result: { passed: false, score: 5.5, threshold: 7 } })),
    ).toMatchObject({
      title: 'Cast review did not pass (5.5 of 7)',
      link: '/p/prj_0000000000aaaaaa/cast',
    });
    expect(jobNotice(job({ kind: 'cut.review', result: { passed: true, score: 8 } }))?.title).toBe(
      'Cut review passed (8)',
    );
  });

  it('says nothing for a review queued behind one that turned out current (it reviewed nothing)', () => {
    expect(
      jobNotice(
        job({
          kind: 'cast.review',
          params: { after: 'job_0000000000bbbbbb' },
          result: { skipped: 'passed' },
        }),
      ),
    ).toBeNull();
    expect(jobNotice(job({ kind: 'cast.review', result: { passed: true, score: 8 } }))?.title).toBe(
      'Cast review passed (8)',
    );
  });

  it('says why a batch stopped for a person, and nothing when it reached its end', () => {
    const stopped = jobNotice(
      job({
        kind: 'batch.generate',
        result: { stopReason: 'the storyboard of scene 3 did not pass its review' },
      }),
    );
    expect(stopped).toMatchObject({
      title: 'Batch finished',
      detail: 'Stopped: the storyboard of scene 3 did not pass its review',
    });
    expect(jobNotice(job({ kind: 'batch.generate', result: { stopReason: 'target reached' } }))?.detail).toBe(
      '',
    );
  });
});

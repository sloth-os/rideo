import type { StageReviewOutput } from '@rideo/shared';
import { describe, expect, it } from 'vitest';
import { sampledReview, subjectsAtOnce } from '../../src/jobs/handlers/common';

const answer = (story: number): StageReviewOutput => ({
  scores: { story },
  summary: `story ${story}`,
  strengths: [],
  issues: [],
  recommendations: [],
});

describe('judge samples (docs/design/ai-review.md#the-verdict)', () => {
  it('asks the judge as many times as the samples, at once, and scores the mean', async () => {
    let calls = 0;
    let inFlight = 0;
    let most = 0;
    const scores = [7, 8, 9];
    const out = await sampledReview(3, async () => {
      const k = calls++;
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return answer(scores[k]!);
    });
    expect(calls).toBe(3);
    expect(most).toBe(3);
    expect(out.scores).toEqual({ story: 8 });
    // One sample is the answer as it is
    expect(await sampledReview(undefined, async () => answer(6))).toEqual(answer(6));
  });

  it('reviews fewer subjects at once as samples grow, so the calls in flight stay the same', () => {
    expect(subjectsAtOnce(3, 1)).toBe(3);
    expect(subjectsAtOnce(3, undefined)).toBe(3);
    expect(subjectsAtOnce(3, 3)).toBe(1);
    expect(subjectsAtOnce(3, 2)).toBe(1);
    expect(subjectsAtOnce(6, 3)).toBe(2);
    // Never none
    expect(subjectsAtOnce(1, 5)).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ClipReviewSchema,
  ClipSchema,
  clipReviewState,
  clipReviewSubject,
  DEFAULT_REVIEW_SETTINGS,
  type FeedbackRecommendation,
  madeFixes,
  ProjectSettingsPatchSchema,
  sceneFixes,
  shotsWithoutTakes,
  takeSpans,
} from '../src';
import * as f from '../src/testing/fixtures';

/** A scene's takes watched before the edit (docs/design/ai-review.md#scenes-before-the-edit). */

function twoShots() {
  const a = f.readyShot([], { index: 0 });
  const b = f.readyShot([], { index: 1 });
  b.takes[0]!.video = f.media({ durationSec: 3.5 });
  b.takes[0]!.durationSec = 3.5;
  return f.clip({ index: 2, shots: [b, a] });
}

function rec(over: Partial<FeedbackRecommendation> & { shotId?: string }): FeedbackRecommendation {
  const { shotId, ...rest } = over;
  return {
    id: 'r1',
    priority: 1,
    dimension: 'continuity',
    title: 'Fix it',
    detail: '',
    issueIds: [],
    action: shotId ? { kind: 'regenerate_shot', clipId: 'clp_0000000000aaaa', shotId } : { kind: 'note' },
    status: 'open',
    ...rest,
  };
}

describe('scene reviews before the edit', () => {
  it('watches the scene on by default and fixes at most three shots', () => {
    expect(DEFAULT_REVIEW_SETTINGS).toMatchObject({ scenes: true, sceneFixes: 3 });
    expect(ProjectSettingsPatchSchema.parse({ review: { scenes: false, sceneFixes: 0 } })).toMatchObject({
      review: { scenes: false, sceneFixes: 0 },
    });
    expect(() => ProjectSettingsPatchSchema.parse({ review: { sceneFixes: 7 } })).toThrow();
  });

  it('reads clips written before scene reviews, and the record with its defaults', () => {
    const { review: _, ...old } = f.clip();
    expect(ClipSchema.parse(old).review).toBeNull();
    const r = ClipReviewSchema.parse({ status: 'succeeded', checkedAt: '2026-10-28T00:00:00.000Z' });
    expect(r).toMatchObject({ round: 1, overall: null, scores: {}, issues: [], fixes: [], before: null });
  });

  it('lays the selected takes one after another, each whole take its own clean part', () => {
    const clip = twoShots();
    const spans = takeSpans(clip);
    expect(spans.map((s) => [s.label, s.start, s.end])).toEqual([
      ['C3·S1', 0, 5],
      ['C3·S2', 5, 8.5],
    ]);
    expect(spans[1]!.clean).toEqual({ start: 5, end: 8.5 });
    // A shot without a selected take with a video is left out, and named
    const open = f.shot({ index: 2 });
    clip.shots.push(open);
    expect(takeSpans(clip)).toHaveLength(2);
    expect(shotsWithoutTakes(clip).map((s) => s.id)).toEqual([open.id]);
  });

  it('is current while the clip keeps the takes it watched', () => {
    const clip = twoShots();
    expect(clipReviewState(clip)).toBe('missing');
    const subject = clipReviewSubject(clip);
    expect(subject).toMatch(/^[0-9a-f]+$/);
    clip.review = ClipReviewSchema.parse({
      status: 'running',
      subject,
      checkedAt: '2026-10-28T00:00:00.000Z',
    });
    expect(clipReviewState(clip)).toBe('running');
    clip.review.status = 'failed';
    expect(clipReviewState(clip)).toBe('error');
    clip.review.status = 'succeeded';
    expect(clipReviewState(clip)).toBe('current');
    // Another take selected: outdated
    const other = f.take();
    clip.shots[0]!.takes.push(other);
    clip.shots[0]!.selectedTakeId = other.id;
    expect(clipReviewSubject(clip)).not.toBe(subject);
    expect(clipReviewState(clip)).toBe('outdated');
  });

  it('applies open priority 1 regenerations itself, the first for each shot, at most the setting', () => {
    const recs = [
      rec({ id: 'r1', shotId: 'shot_a' }),
      rec({ id: 'r2', shotId: 'shot_a' }),
      rec({ id: 'r3', priority: 2, shotId: 'shot_b' }),
      rec({ id: 'r4' }),
      rec({ id: 'r5', shotId: 'shot_c', status: 'dismissed' }),
      rec({ id: 'r6', shotId: 'shot_d' }),
      rec({ id: 'r7', shotId: 'shot_e' }),
    ];
    expect(sceneFixes(recs, 3).map((r) => r.id)).toEqual(['r1', 'r6', 'r7']);
    expect(sceneFixes(recs, 2).map((r) => r.id)).toEqual(['r1', 'r6']);
    expect(sceneFixes(recs, 0)).toEqual([]);
  });

  it('lets a retried review find the fixes it made, so it never fixes twice', () => {
    const fixes = [
      rec({ id: 'r1', shotId: 'sht_0000000000aaaa', status: 'applied', jobId: 'job_0000000000bbbb' }),
    ];
    const review = ClipReviewSchema.parse({
      status: 'failed',
      jobId: 'job_0000000000aaaa',
      fixes,
      checkedAt: '2026-10-28T00:00:00.000Z',
    });
    expect(madeFixes(review, 'job_0000000000aaaa')).toEqual(fixes);
    // Another job's review, a finished one, or none: nothing to resume
    expect(madeFixes(review, 'job_0000000000cccc')).toEqual([]);
    expect(madeFixes({ ...review, status: 'succeeded' }, 'job_0000000000aaaa')).toEqual([]);
    expect(madeFixes(null, 'job_0000000000aaaa')).toEqual([]);
  });
});

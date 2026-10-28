import type { Clip, ClipReview, Shot } from '../schemas/clip';
import type { FeedbackRecommendation } from '../schemas/feedback';
import { fnv1a32 } from '../util/hash';

/**
 * A scene's takes watched before the edit (docs/design/ai-review.md#scenes-before-the-edit): what a review watched,
 * whether it is still current, and the fixes it applies itself.
 */

const byIndex = <T extends { index: number }>(a: T, b: T) => a.index - b.index;

/** The selected takes a scene review watched: the review is current while the clip's selected takes are these. */
export function clipReviewSubject(clip: Pick<Clip, 'shots'>): string {
  return fnv1a32(
    JSON.stringify([...clip.shots].sort(byIndex).map((s) => [s.id, s.selectedTakeId ?? null])),
  ).toString(16);
}

export type ClipReviewState = 'missing' | 'running' | 'error' | 'outdated' | 'current';

export function clipReviewState(clip: Pick<Clip, 'shots'> & { review: ClipReview | null }): ClipReviewState {
  const r = clip.review;
  if (!r) return 'missing';
  if (r.status === 'running') return 'running';
  if (r.status === 'failed') return 'error';
  return r.subject === clipReviewSubject(clip) ? 'current' : 'outdated';
}

/** The shots a scene review cannot watch: without a selected take that has a video. */
export function shotsWithoutTakes(clip: Pick<Clip, 'shots'>): Shot[] {
  return [...clip.shots].sort(byIndex).filter((s) => !s.takes.find((t) => t.id === s.selectedTakeId)?.video);
}

/**
 * The fixes a retried scene review already made (its second watch failed): the retry waits for them and watches again
 * instead of fixing twice. Empty unless the review was left unfinished by `jobId` with fixes.
 */
export function madeFixes(review: ClipReview | null, jobId: string): FeedbackRecommendation[] {
  return review && review.jobId === jobId && review.status !== 'succeeded' ? review.fixes : [];
}

/** The fixes a scene review applies itself: open priority 1 regenerations, the first for each shot, at most `max`. */
export function sceneFixes(recs: readonly FeedbackRecommendation[], max: number): FeedbackRecommendation[] {
  const out: FeedbackRecommendation[] = [];
  const shots = new Set<string>();
  for (const r of recs) {
    if (out.length >= max) break;
    if (r.status !== 'open' || r.priority !== 1 || r.action?.kind !== 'regenerate_shot') continue;
    if (shots.has(r.action.shotId)) continue;
    shots.add(r.action.shotId);
    out.push(r);
  }
  return out;
}

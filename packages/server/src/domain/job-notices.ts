import type { Job, JobKind, View } from '@rideo/shared';

/**
 * Notifications for people's and agents' long work (docs/design/pwa.md#notifications-on-the-phone-web-push): what
 * a finished or failed job says, where it leads, and whom it is for.
 */
const NOTICES: Partial<Record<JobKind, { done: string; failed: string; view: View }>> = {
  'export.finish': { done: 'Export ready', failed: 'Export failed', view: 'exports' },
  'export.feedback': { done: 'Feedback ready', failed: 'Feedback failed', view: 'exports' },
  'consistency.recheck': { done: 'Takes re-checked', failed: 'Re-check failed', view: 'clips' },
  'clip.generate': { done: 'Clip generated', failed: 'Clip generation failed', view: 'clips' },
  'batch.generate': { done: 'Batch finished', failed: 'Batch failed', view: 'clips' },
  'recipe.run': { done: 'Recipe finished', failed: 'Recipe failed', view: 'overview' },
  'localize.generate': { done: 'Language version ready', failed: 'Language version failed', view: 'exports' },
  'screenplay.review': { done: 'Screenplay reviewed', failed: 'Screenplay review failed', view: 'story' },
  'screenplay.revise': { done: 'Screenplay revised', failed: 'Screenplay revision failed', view: 'story' },
  'storyboard.review': {
    done: 'Storyboard reviewed',
    failed: 'Storyboard review failed',
    view: 'storyboard',
  },
  'cast.review': { done: 'Cast reviewed', failed: 'Cast review failed', view: 'cast' },
  'cut.review': { done: 'Cut reviewed', failed: 'Cut review failed', view: 'exports' },
  'clip.storyboard': { done: 'Scene storyboarded', failed: 'Scene storyboard failed', view: 'storyboard' },
  'scene.block': { done: 'Scene blocked', failed: 'Blocking failed', view: 'storyboard' },
};

const REVIEWED: Partial<Record<JobKind, string>> = {
  'screenplay.review': 'Screenplay',
  'storyboard.review': 'Storyboard',
  'cast.review': 'Cast',
  'cut.review': 'Cut',
  'clip.storyboard': 'Scene storyboard',
};

/** An AI review's verdict in its notice (docs/design/ai-review.md). */
function reviewTitle(job: Job, base: string): string {
  const r = job.result as { passed?: boolean; score?: number; threshold?: number } | undefined;
  if (typeof r?.passed !== 'boolean' || typeof r.score !== 'number') return base;
  const stage = REVIEWED[job.kind] ?? 'Storyboard';
  return r.passed
    ? `${stage} review passed (${r.score})`
    : `${stage} review did not pass (${r.score} of ${r.threshold})`;
}

/**
 * Why a batch stopped before its end, for a person (docs/design/ai-review.md#autopilot-every-step-reviewed-and-approved):
 * a review that did not pass, a place or a voice to approve; empty when it reached its end.
 */
function stopped(job: Job): string {
  const reason = (job.result as { stopReason?: string } | undefined)?.stopReason;
  if (job.kind !== 'batch.generate' || !reason) return '';
  return reason === 'target reached' || reason === 'the outline is complete'
    ? ''
    : `Stopped: ${reason}`.slice(0, 300);
}

/** A finished top-level job's notice: the kinds above when they succeed, any job when it fails for good. */
export function jobNotice(job: Job): { title: string; detail: string; link: string } | null {
  if (job.parentId) return null;
  const n = NOTICES[job.kind];
  if (job.status === 'succeeded' && n)
    return { title: reviewTitle(job, n.done), detail: stopped(job), link: `/p/${job.projectId}/${n.view}` };
  if (job.status === 'failed')
    return {
      title: n?.failed ?? `${job.kind} failed`,
      detail: (job.error?.message ?? '').slice(0, 300),
      link: `/p/${job.projectId}/${n?.view ?? 'overview'}`,
    };
  return null;
}

/** The person a job was for: who started it, or whom an agent or Rideo worked for. */
export function jobRecipient(job: Job): string | null {
  if (job.actor.kind === 'user') return job.actor.id;
  if (job.actor.onBehalfOf?.kind === 'user') return job.actor.onBehalfOf.id;
  return null;
}

import type { Job, JobKind, View } from '@rideo/shared';

/**
 * Notifications for people's and agents' long work (docs/design/pwa.md#notifications-on-the-phone-web-push): what
 * a finished or failed job says, where it leads, and whom it is for.
 */
const NOTICES: Partial<Record<JobKind, { done: string; failed: string; view: View }>> = {
  'export.finish': { done: 'Export ready', failed: 'Export failed', view: 'exports' },
  'clip.generate': { done: 'Clip generated', failed: 'Clip generation failed', view: 'clips' },
  'batch.generate': { done: 'Batch finished', failed: 'Batch failed', view: 'clips' },
  'recipe.run': { done: 'Recipe finished', failed: 'Recipe failed', view: 'overview' },
  'localize.generate': { done: 'Language version ready', failed: 'Language version failed', view: 'exports' },
};

/** A finished top-level job's notice: the kinds above when they succeed, any job when it fails for good. */
export function jobNotice(job: Job): { title: string; detail: string; link: string } | null {
  if (job.parentId) return null;
  const n = NOTICES[job.kind];
  if (job.status === 'succeeded' && n)
    return { title: n.done, detail: '', link: `/p/${job.projectId}/${n.view}` };
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

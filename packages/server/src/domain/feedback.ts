import {
  type Actor,
  castIdsOf,
  docPath,
  type Export,
  FEEDBACK_SETTINGS,
  type Feedback,
  type FeedbackRecommendation,
  FeedbackSchema,
  type FeedbackSettingsPatch,
  feedbackIdFor,
  type Job,
  type ProjectSettingsPatch,
} from '@rideo/shared';
import { currentPrincipal } from '../auth/context';
import { AppError, invalid, notFound } from '../errors';
import { Service } from './base';
import type { ClipService } from './clips';
import type { Deps } from './deps';
import type { ProjectService } from './projects';

/** The project settings patch of a `settings` action (a fixed table, docs/design/feedback.md#actions). */
export function settingsPatchOf(patch: FeedbackSettingsPatch): ProjectSettingsPatch {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const [group, field] = FEEDBACK_SETTINGS[key as keyof typeof FEEDBACK_SETTINGS].path;
    out[group] = { ...out[group], [field]: value };
  }
  return out as ProjectSettingsPatch;
}

/** Feedback on exports (docs/design/feedback.md): REST and MCP call this service. */
export class FeedbackService extends Service {
  constructor(
    deps: Deps,
    private readonly services: { clips: ClipService; projects: ProjectService },
  ) {
    super(deps);
  }

  async list(projectId: string): Promise<Feedback[]> {
    const docs = await this.deps.projects.docs(projectId);
    return Object.values(docs.feedback).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(projectId: string, exportId?: string): Promise<Feedback | null> {
    const all = await this.list(projectId);
    return exportId ? (all.find((f) => f.exportId === exportId) ?? null) : (all[0] ?? null);
  }

  /** Is this export one feedback follows by itself (docs/design/feedback.md#when-it-runs)? */
  static automatic(exp: Export): boolean {
    return (
      exp.status === 'succeeded' &&
      exp.source === 'timeline' &&
      !exp.language &&
      (exp.delivery?.aspect ?? 'source') === 'source' &&
      !exp.delivery?.maxDurationSec &&
      exp.delivery?.format !== 'frames'
    );
  }

  /** Watches an export: the feedback document (running) and its `export.feedback` job. */
  async request(
    actor: Actor,
    projectId: string,
    exportId: string,
  ): Promise<{ feedback: Feedback; job: Job }> {
    const docs = await this.deps.projects.docs(projectId);
    const exp = docs.exports[exportId];
    if (!exp) throw notFound(`export ${exportId}`);
    if (exp.status !== 'succeeded' || !exp.media) throw invalid('the export has not finished');
    if (exp.delivery?.format === 'frames') throw invalid('an image-sequence master cannot be watched');
    const id = feedbackIdFor(exportId);
    const running = this.deps.jobs
      .list(projectId, { kind: 'export.feedback' })
      .find((j) => (j.params as { exportId?: string }).exportId === exportId && j.status !== 'failed');
    if (running && (running.status === 'queued' || running.status === 'running')) {
      const current = docs.feedback[id];
      if (current) return { feedback: current, job: running };
    }
    const now = new Date().toISOString();
    const previous = docs.feedback[id];
    const feedback: Feedback = FeedbackSchema.parse({
      ...(previous ?? {}),
      id,
      exportId,
      status: 'running',
      error: undefined,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      timelineCommit: exp.timelineCommit,
      durationSec: exp.durationSec ?? 0,
    });
    await this.mutate(actor, projectId, (tx) => tx.set(docPath.feedback(id), feedback), {
      message: `Watch export ${exportId.slice(-6)} for feedback`,
    });
    const job = await this.deps.jobs.enqueue({
      projectId,
      kind: 'export.feedback',
      params: { exportId, feedbackId: id },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `feedback:${exportId}`,
      priority: 3,
      maxAttempts: 2,
    });
    return { feedback: { ...feedback, jobId: job.id }, job };
  }

  private async recommendation(projectId: string, feedbackId: string, recommendationId: string) {
    const docs = await this.deps.projects.docs(projectId);
    const fb = docs.feedback[feedbackId];
    if (!fb) throw notFound(`feedback ${feedbackId}`);
    const rec = fb.recommendations.find((r) => r.id === recommendationId);
    if (!rec) throw notFound(`recommendation ${recommendationId}`);
    if (rec.status !== 'open')
      throw new AppError('feedback_stale', `recommendation ${recommendationId} is ${rec.status}`);
    return { docs, fb, rec };
  }

  private async mark(
    actor: Actor,
    projectId: string,
    feedbackId: string,
    recommendationId: string,
    patch: Partial<FeedbackRecommendation>,
    message: string,
  ): Promise<Feedback> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const fb = structuredClone(
          tx.require<Feedback>(docPath.feedback(feedbackId), `feedback ${feedbackId}`),
        );
        const rec = fb.recommendations.find((r) => r.id === recommendationId);
        if (!rec) throw notFound(`recommendation ${recommendationId}`);
        Object.assign(rec, patch);
        fb.updatedAt = new Date().toISOString();
        tx.set(docPath.feedback(feedbackId), fb);
        return fb;
      },
      { message },
    );
    return result;
  }

  /** Applies a recommendation's action (docs/design/feedback.md#actions) and marks it applied. */
  async apply(
    actor: Actor,
    projectId: string,
    feedbackId: string,
    recommendationId: string,
  ): Promise<{ feedback: Feedback; job: Job | null }> {
    const { docs, rec } = await this.recommendation(projectId, feedbackId, recommendationId);
    const action = rec.action ?? { kind: 'note' as const };
    let job: Job | null = null;
    const stale = (why: string) => {
      this.deps.metrics.feedbackRecommendations.inc({ action: action.kind, outcome: 'stale' });
      return new AppError('feedback_stale', why);
    };
    if (action.kind === 'regenerate_shot') {
      const clip = docs.clips[action.clipId];
      const shot = clip?.shots.find((s) => s.id === action.shotId);
      if (!clip || !shot) throw stale(`shot ${action.shotId} no longer exists`);
      const camera =
        action.framing || action.movement
          ? {
              ...(action.framing ? { framing: action.framing } : {}),
              ...(action.movement ? { movement: action.movement } : {}),
            }
          : undefined;
      // Who is in frame after the change: the gate checks the shot's cast (docs/design/feedback.md#actions)
      const cast = action.characters?.length ? castIdsOf(action.characters, docs.characters) : [];
      if (action.description || action.action || action.negativePrompt || camera || cast.length)
        await this.services.clips.updateShot(actor, projectId, clip.id, shot.id, {
          ...(action.description ? { description: action.description } : {}),
          ...(action.action ? { action: action.action } : {}),
          ...(action.negativePrompt ? { negativePrompt: action.negativePrompt } : {}),
          ...(camera ? { camera } : {}),
          ...(cast.length ? { characterIds: cast } : {}),
        });
      job = await this.services.clips.regenerateShot(actor, projectId, clip.id, shot.id, { swapInCut: true });
    } else if (action.kind === 'replan_scene') {
      const clip = docs.clips[action.clipId];
      if (!clip?.sceneId) throw stale(`the scene of clip ${action.clipId} no longer exists`);
      job = await this.services.clips.planClip(actor, projectId, clip.sceneId, {
        thenGenerate: true,
        ...(action.direction ? { direction: action.direction } : {}),
      });
    } else if (action.kind === 'settings') {
      // Changing settings needs the permission to manage the project (docs/design/accounts.md).
      const principal = currentPrincipal();
      if (principal) await this.deps.accounts.authorize(principal, projectId, 'project.manage');
      await this.services.projects.update(actor, projectId, { settings: settingsPatchOf(action.patch) });
    }
    this.deps.metrics.feedbackRecommendations.inc({ action: action.kind, outcome: 'applied' });
    const feedback = await this.mark(
      actor,
      projectId,
      feedbackId,
      recommendationId,
      {
        status: 'applied',
        appliedAt: new Date().toISOString(),
        appliedBy: actor,
        ...(job ? { jobId: job.id } : {}),
      },
      `Apply feedback: ${rec.title.slice(0, 120)}`,
    );
    return { feedback, job };
  }

  async dismiss(
    actor: Actor,
    projectId: string,
    feedbackId: string,
    recommendationId: string,
  ): Promise<Feedback> {
    const { rec } = await this.recommendation(projectId, feedbackId, recommendationId);
    this.deps.metrics.feedbackRecommendations.inc({
      action: rec.action?.kind ?? 'note',
      outcome: 'dismissed',
    });
    return this.mark(
      actor,
      projectId,
      feedbackId,
      recommendationId,
      { status: 'dismissed', appliedAt: new Date().toISOString(), appliedBy: actor },
      `Dismiss feedback: ${rec.title.slice(0, 120)}`,
    );
  }
}

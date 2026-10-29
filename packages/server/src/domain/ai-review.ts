import {
  type Actor,
  castIdsOf,
  castReadyForReview,
  cutTakeItems,
  docPath,
  type Job,
  type JobKind,
  REVIEW_STAGES,
  type ReviewStage,
  reviewEnabled,
  reviewState,
  reviewSubject,
  type StageRecommendation,
  type StageReview,
  StageReviewSchema,
} from '@rideo/shared';
import { AppError, invalid, notFound } from '../errors';
import { Service } from './base';
import type { ClipService } from './clips';
import type { Deps } from './deps';
import type { ElementService } from './elements';
import type { StoryService } from './story';
import type { StoryboardService } from './storyboard';

const JOB_OF: Record<ReviewStage, JobKind> = {
  screenplay: 'screenplay.review',
  cast: 'cast.review',
  storyboard: 'storyboard.review',
  cut: 'cut.review',
};

/** AI review of every step (docs/design/ai-review.md): REST and MCP call this service. */
export class AiReviewService extends Service {
  constructor(
    deps: Deps,
    private readonly services: {
      clips: ClipService;
      storyboard: StoryboardService;
      story: StoryService;
      elements: ElementService;
    },
  ) {
    super(deps);
  }

  static stage(value: string): ReviewStage {
    if (!(REVIEW_STAGES as readonly string[]).includes(value)) throw invalid(`unknown review stage ${value}`);
    return value as ReviewStage;
  }

  async list(projectId: string): Promise<StageReview[]> {
    const docs = await this.deps.projects.docs(projectId);
    return REVIEW_STAGES.map((s) => docs.aiReviews[s]).filter((r): r is StageReview => !!r);
  }

  async get(projectId: string, stage: ReviewStage): Promise<StageReview | null> {
    return (await this.deps.projects.docs(projectId)).aiReviews[stage] ?? null;
  }

  /** Queues the stage's review (one at a time; a running one is returned). */
  async run(actor: Actor, projectId: string, stage: ReviewStage): Promise<{ job: Job }> {
    const docs = await this.deps.projects.docs(projectId);
    if (stage === 'screenplay' && !docs.screenplay?.scenes.length)
      throw invalid('write or import the screenplay first');
    if (stage === 'cast' && !castReadyForReview(docs))
      throw invalid(
        'generate or upload a reference of every character and of every place and prop in use first',
      );
    if (stage === 'cut' && !cutTakeItems(docs).length) throw invalid('assemble the cut first');
    const kind = JOB_OF[stage];
    const active = this.deps.jobs
      .list(projectId, { kind })
      .find((j) => j.status === 'queued' || j.status === 'running');
    if (active) return { job: active };
    const job = await this.deps.jobs.enqueue({
      projectId,
      kind,
      params: {},
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `ai-review:${stage}`,
      priority: 3,
      maxAttempts: 2,
    });
    return { job };
  }

  /** Queues the stage's review when its setting is on (after the screenplay or the storyboard is generated). */
  async followUp(actor: Actor, projectId: string, stage: ReviewStage): Promise<Job | null> {
    const docs = await this.deps.projects.docs(projectId);
    if (!reviewEnabled(docs, stage)) return null;
    if (stage === 'cast' && !castReadyForReview(docs)) return null;
    // A review of the documents as they are now is not made again
    const state = reviewState(docs, stage);
    if (state === 'passed' || state === 'overridden' || state === 'failed') return null;
    return (await this.run(actor, projectId, stage)).job;
  }

  /**
   * Takes watched whole from their stored videos (`takes.watch`, docs/design/ai-review.md#takes-watched-whole): the
   * given ones, or every take of the cut.
   */
  async watchTakes(
    actor: Actor,
    projectId: string,
    takes?: { clipId: string; shotId: string; takeId: string }[],
  ): Promise<Job> {
    const docs = await this.deps.projects.docs(projectId);
    const list = takes?.length
      ? takes
      : cutTakeItems(docs).map(({ clipId, shotId, takeId }) => ({ clipId, shotId, takeId }));
    if (!list.length) throw invalid('no takes to watch: assemble the cut first or name the takes');
    for (const t of list) {
      const take = docs.clips[t.clipId]?.shots
        .find((s) => s.id === t.shotId)
        ?.takes.find((x) => x.id === t.takeId);
      if (!take?.video) throw notFound(`take ${t.takeId} with a video`);
    }
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'takes.watch',
      params: { takes: list },
      actor,
      branch: await this.branchOf(projectId),
      priority: 3,
    });
  }

  private async recommendation(projectId: string, stage: ReviewStage, recommendationId: string) {
    const docs = await this.deps.projects.docs(projectId);
    const review = docs.aiReviews[stage];
    if (!review) throw notFound(`${stage} review`);
    const rec = review.recommendations.find((r) => r.id === recommendationId);
    if (!rec) throw notFound(`recommendation ${recommendationId}`);
    if (rec.status !== 'open')
      throw new AppError('review_stale', `recommendation ${recommendationId} is ${rec.status}`);
    return { docs, review, rec };
  }

  private async mark(
    actor: Actor,
    projectId: string,
    stage: ReviewStage,
    recommendationId: string,
    patch: Partial<StageRecommendation>,
    message: string,
  ): Promise<StageReview> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const review = structuredClone(tx.require<StageReview>(docPath.aiReview(stage), `${stage} review`));
        const rec = review.recommendations.find((r) => r.id === recommendationId);
        if (!rec) throw notFound(`recommendation ${recommendationId}`);
        Object.assign(rec, patch);
        review.updatedAt = new Date().toISOString();
        tx.set(docPath.aiReview(stage), StageReviewSchema.parse(review));
        return review;
      },
      { message },
    );
    return result;
  }

  /** Applies a recommendation's action (docs/design/ai-review.md#how-a-review-runs) and marks it applied. */
  async apply(
    actor: Actor,
    projectId: string,
    stage: ReviewStage,
    recommendationId: string,
  ): Promise<{ review: StageReview; job: Job | null }> {
    const { docs, rec } = await this.recommendation(projectId, stage, recommendationId);
    const action = rec.action ?? { kind: 'note' as const };
    const stale = (why: string) => {
      this.deps.metrics.aiReviewRecommendations.inc({ stage, action: action.kind, outcome: 'stale' });
      return new AppError('review_stale', why);
    };
    let job: Job | null = null;
    if (action.kind === 'revise_scene' || action.kind === 'revise_outline') {
      if (action.kind === 'revise_scene' && !docs.screenplay?.scenes.some((s) => s.id === action.sceneId))
        throw stale(`scene ${action.sceneId} no longer exists`);
      job = await this.deps.jobs.enqueue({
        projectId,
        kind: 'screenplay.revise',
        params: {
          instructions: [
            action.kind === 'revise_scene'
              ? { sceneId: action.sceneId, instruction: action.instruction }
              : { outline: true, instruction: action.instruction },
          ],
        },
        actor,
        branch: await this.branchOf(projectId),
        priority: 2,
      });
    } else if (action.kind === 'redraw_board') {
      const clip = docs.clips[action.clipId];
      if (!clip?.shots.some((s) => s.id === action.shotId))
        throw stale(`shot ${action.shotId} no longer exists`);
      const cast = action.characters?.length ? castIdsOf(action.characters, docs.characters) : [];
      const camera =
        action.framing || action.movement
          ? {
              ...(action.framing ? { framing: action.framing } : {}),
              ...(action.movement ? { movement: action.movement } : {}),
            }
          : undefined;
      await this.services.clips.updateShot(actor, projectId, action.clipId, action.shotId, {
        ...(action.description ? { description: action.description } : {}),
        ...(action.action ? { action: action.action } : {}),
        ...(camera ? { camera } : {}),
        ...(cast.length ? { characterIds: cast } : {}),
        ...(action.durationSec ? { durationSec: action.durationSec } : {}),
      });
      job = await this.services.storyboard.generateBoard(actor, projectId, action.clipId, action.shotId);
    } else if (action.kind === 'regenerate_refs') {
      job = await this.regenerateRefs(actor, projectId, action, stale);
    } else if (action.kind === 'regenerate_shot') {
      const clip = docs.clips[action.clipId];
      if (!clip?.shots.some((s) => s.id === action.shotId))
        throw stale(`shot ${action.shotId} no longer exists`);
      job = await this.services.clips.regenerateShot(actor, projectId, action.clipId, action.shotId, {
        swapInCut: true,
        selectIfPasses: true,
      });
    } else if (action.kind === 'replan_scene') {
      const sceneId = docs.clips[action.clipId]?.sceneId;
      if (!sceneId) throw stale(`the scene of clip ${action.clipId} no longer exists`);
      job = await this.services.clips.planClip(actor, projectId, sceneId, {
        direction: action.direction,
        thenBoard: true,
      });
    }
    this.deps.metrics.aiReviewRecommendations.inc({ stage, action: action.kind, outcome: 'applied' });
    const review = await this.mark(
      actor,
      projectId,
      stage,
      recommendationId,
      {
        status: 'applied',
        appliedAt: new Date().toISOString(),
        appliedBy: actor,
        ...(job ? { jobId: job.id } : {}),
      },
      `Apply the ${stage} review: ${rec.title.slice(0, 120)}`,
    );
    return { review, job };
  }

  /**
   * A cast review's fix (docs/design/ai-review.md#how-a-review-runs): the subject's generated references that no person
   * approved are removed and drawn again.
   */
  async regenerateRefs(
    actor: Actor,
    projectId: string,
    action: { characterId?: string; elementId?: string },
    stale: (why: string) => AppError = (why) => new AppError('review_stale', why),
  ): Promise<Job> {
    const docs = await this.deps.projects.docs(projectId);
    if (action.characterId) {
      const c = docs.characters[action.characterId];
      if (!c) throw stale(`character ${action.characterId} no longer exists`);
      if (c.lock.locked) throw stale(`${c.name} is locked`);
      for (const r of c.references)
        if (r.source === 'generated' && !r.approved)
          await this.services.story.deleteReference(actor, projectId, c.id, r.id);
      return this.services.story.generateReferences(actor, projectId, c.id);
    }
    const e = action.elementId ? docs.elements[action.elementId] : undefined;
    if (!e) throw stale(`element ${action.elementId} no longer exists`);
    if (e.lock.locked) throw stale(`${e.name} is locked`);
    for (const r of e.references)
      if (r.source === 'generated' && !r.approved)
        await this.services.elements.deleteReference(actor, projectId, e.id, r.id);
    return this.services.elements.generateReferences(actor, projectId, e.id);
  }

  async dismiss(
    actor: Actor,
    projectId: string,
    stage: ReviewStage,
    recommendationId: string,
  ): Promise<StageReview> {
    const { rec } = await this.recommendation(projectId, stage, recommendationId);
    this.deps.metrics.aiReviewRecommendations.inc({
      stage,
      action: rec.action?.kind ?? 'note',
      outcome: 'dismissed',
    });
    return this.mark(
      actor,
      projectId,
      stage,
      recommendationId,
      { status: 'dismissed' },
      `Dismiss from the ${stage} review: ${rec.title.slice(0, 120)}`,
    );
  }

  /** "Continue anyway": the gate accepts the review for what it was made of (docs/design/ai-review.md#the-gates). */
  async override(actor: Actor, projectId: string, stage: ReviewStage, note: string): Promise<StageReview> {
    const docs = await this.deps.projects.docs(projectId);
    this.assertAgentMay(docs.project, actor, 'approve');
    const current = docs.aiReviews[stage];
    if (current?.status !== 'succeeded') throw invalid(`review the ${stage} first`);
    const subject = reviewSubject(docs, stage);
    if (current.subject !== subject)
      throw new AppError('review_stale', `the ${stage} changed since its review`);
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const review = structuredClone(tx.require<StageReview>(docPath.aiReview(stage), `${stage} review`));
        const at = new Date().toISOString();
        review.override = { by: actor, at, note: note.slice(0, 1000), subject };
        review.updatedAt = at;
        tx.set(docPath.aiReview(stage), StageReviewSchema.parse(review));
        return review;
      },
      { message: `Continue without passing the ${stage} review${note ? `: ${note.slice(0, 100)}` : ''}` },
    );
    return result;
  }
}

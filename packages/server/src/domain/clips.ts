import {
  type Actor,
  approvedReferences,
  type Character,
  type Clip,
  clipBlockers,
  docPath,
  isAcceptable,
  type Job,
  type Project,
  type ProjectDocs,
  type Screenplay,
  type Shot,
  type ShotUpdateInput,
  takeState,
} from '@rideo/shared';
import { AppError, invalid, notFound } from '../errors';
import type { Tx } from '../vcs/repo';
import { Service } from './base';

/** R1 precondition: every character in the shots is locked with an approved reference. */
export function assertCastReady(
  shots: Pick<Shot, 'characterIds'>[],
  characters: Record<string, Character>,
): void {
  const problems = new Set<string>();
  for (const s of shots) {
    for (const id of s.characterIds) {
      const c = characters[id];
      if (!c) problems.add(`unknown character ${id}`);
      else if (!c.lock.locked) problems.add(`${c.name} is not locked`);
      else if (approvedReferences(c).length === 0) problems.add(`${c.name} has no approved reference`);
    }
  }
  if (problems.size) {
    throw new AppError(
      'character_not_locked',
      `Lock the cast before generating: ${[...problems].join('; ')} (rule R1)`,
      [...problems],
    );
  }
}

export function clipStatusOf(clip: Clip): Clip['status'] {
  if (clip.status === 'approved') return 'approved';
  if (clip.shots.some((s) => s.status === 'generating' || s.status === 'queued')) return 'generating';
  if (clip.shots.length && clip.shots.every((s) => s.takes.length > 0)) return 'review';
  return clip.shots.some((s) => s.takes.length > 0) ? 'generating' : 'planned';
}

export class ClipService extends Service {
  private requireClip(tx: Tx, clipId: string): Clip {
    return tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`);
  }

  private requireShot(clip: Clip, shotId: string): Shot {
    const s = clip.shots.find((x) => x.id === shotId);
    if (!s) throw notFound(`shot ${shotId}`);
    return s;
  }

  private async docs(projectId: string): Promise<ProjectDocs> {
    return this.deps.projects.docs(projectId);
  }

  async planClip(
    actor: Actor,
    projectId: string,
    sceneId: string,
    opts: { thenGenerate?: boolean } = {},
  ): Promise<Job> {
    const docs = await this.docs(projectId);
    const sp = docs.screenplay as Screenplay | null;
    if (!sp?.scenes.some((s) => s.id === sceneId)) throw notFound(`scene ${sceneId}`);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'clip.plan',
      params: { sceneId, thenGenerate: !!opts.thenGenerate },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `plan:${sceneId}`,
      priority: 5,
    });
  }

  async generateClip(actor: Actor, projectId: string, clipId: string): Promise<Job> {
    const docs = await this.docs(projectId);
    const clip = docs.clips[clipId];
    if (!clip) throw notFound(`clip ${clipId}`);
    if (!clip.shots.length) throw invalid('the clip has no shots; plan it first');
    assertCastReady(clip.shots, docs.characters);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'clip.generate',
      params: { clipId },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `clip:${clipId}`,
      priority: clip.index === 0 ? 5 : 1,
    });
  }

  async updateShot(
    actor: Actor,
    projectId: string,
    clipId: string,
    shotId: string,
    input: ShotUpdateInput,
  ): Promise<Clip> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const clip = structuredClone(this.requireClip(tx, clipId));
        const shot = this.requireShot(clip, shotId);
        for (const id of input.characterIds ?? [])
          if (!tx.get(docPath.character(id))) throw notFound(`character ${id}`);
        Object.assign(
          shot,
          Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && k !== 'camera')),
        );
        if (input.camera) shot.camera = { ...shot.camera, ...input.camera };
        if (shot.index === 0) shot.continuity = 'cut';
        tx.set(docPath.clip(clipId), clip);
        return clip;
      },
      { message: `Edit shot ${clipId.slice(-4)}/${shotId.slice(-4)}`, coalesce: { key: `shot:${shotId}` } },
    );
    return result;
  }

  async regenerateShot(actor: Actor, projectId: string, clipId: string, shotId: string): Promise<Job> {
    const docs = await this.docs(projectId);
    const clip = docs.clips[clipId];
    if (!clip) throw notFound(`clip ${clipId}`);
    const shot = this.requireShot(clip, shotId);
    assertCastReady([shot], docs.characters);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'shot.generate',
      params: { clipId, shotId },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `shot:${shotId}`,
      priority: 10,
    });
  }

  async selectTake(
    actor: Actor,
    projectId: string,
    clipId: string,
    shotId: string,
    takeId: string,
  ): Promise<Clip> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const clip = structuredClone(this.requireClip(tx, clipId));
        const shot = this.requireShot(clip, shotId);
        const take = shot.takes.find((t) => t.id === takeId);
        if (!take) throw notFound(`take ${takeId}`);
        const characters = Object.fromEntries(tx.list<Character>('characters/').map((c) => [c.id, c]));
        shot.selectedTakeId = takeId;
        shot.status = isAcceptable(takeState(take, shot, characters)) ? 'ready' : 'needs_review';
        if (clip.status === 'approved') {
          clip.status = 'review';
          clip.approvedAt = null;
          clip.approvedBy = null;
        }
        clip.status = clipStatusOf(clip);
        tx.set(docPath.clip(clipId), clip);
        return clip;
      },
      { message: `Select take ${takeId.slice(-4)} for shot ${shotId.slice(-4)}` },
    );
    return result;
  }

  /** R8: an audited human (or permitted agent) decision to accept a take that is not verified/passed. */
  async overrideTake(
    actor: Actor,
    projectId: string,
    clipId: string,
    shotId: string,
    takeId: string,
    reason: string,
  ): Promise<Clip> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        this.assertAgentMay(tx.require<Project>('project.json', 'project'), actor, 'override');
        const clip = structuredClone(this.requireClip(tx, clipId));
        const shot = this.requireShot(clip, shotId);
        const take = shot.takes.find((t) => t.id === takeId);
        if (!take) throw notFound(`take ${takeId}`);
        const characters = Object.fromEntries(tx.list<Character>('characters/').map((c) => [c.id, c]));
        if (takeState({ ...take, override: null }, shot, characters) === 'stale') {
          throw new AppError(
            'consistency_gate',
            'Stale takes were generated from an older character lock; regenerate instead of overriding',
          );
        }
        take.override = { actor, reason: reason.trim(), at: new Date().toISOString() };
        shot.selectedTakeId = takeId;
        shot.status = 'ready';
        if (clip.status === 'approved') clip.status = 'review';
        clip.status = clipStatusOf(clip);
        tx.set(docPath.clip(clipId), clip);
        return clip;
      },
      {
        message: `Override consistency for shot ${shotId.slice(-4)}: ${reason.trim().slice(0, 120)}`,
        meta: { override: true },
      },
    );
    return result;
  }

  /** R7: approving requires every selected take to be passed-and-current or overridden. */
  async approveClip(actor: Actor, projectId: string, clipId: string): Promise<Clip> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        this.assertAgentMay(tx.require<Project>('project.json', 'project'), actor, 'approve');
        const clip = structuredClone(this.requireClip(tx, clipId));
        const characters = Object.fromEntries(tx.list<Character>('characters/').map((c) => [c.id, c]));
        const blockers = clipBlockers(clip, characters);
        if (blockers.length) {
          throw new AppError(
            'consistency_gate',
            `Clip ${clip.index + 1} cannot be approved: ${blockers.map((b) => b.message).join('; ')}`,
            blockers,
          );
        }
        clip.status = 'approved';
        clip.approvedAt = new Date().toISOString();
        clip.approvedBy = actor;
        tx.set(docPath.clip(clipId), clip);
        return clip;
      },
      { message: (c) => `Approve clip ${c.index + 1} “${c.title}”` },
    );
    return result;
  }

  async unapproveClip(actor: Actor, projectId: string, clipId: string): Promise<Clip> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const clip = structuredClone(this.requireClip(tx, clipId));
        clip.status = 'review';
        clip.approvedAt = null;
        clip.approvedBy = null;
        clip.status = clipStatusOf({ ...clip, status: 'review' });
        tx.set(docPath.clip(clipId), clip);
        return clip;
      },
      { message: (c) => `Reopen clip ${c.index + 1} for review` },
    );
    return result;
  }

  async startBatch(actor: Actor, projectId: string, opts: { maxGenerations?: number } = {}): Promise<Job> {
    const docs = await this.docs(projectId);
    if (docs.project.kind !== 'story') throw invalid('batch generation is for story projects');
    if (!docs.screenplay) throw invalid('generate a screenplay first');
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'batch.generate',
      params: { maxGenerations: opts.maxGenerations ?? docs.project.settings.batch.maxGenerations },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: 'batch',
      priority: 1,
      maxAttempts: 1,
    });
  }

  async pauseBatch(_actor: Actor, projectId: string): Promise<{ cancelled: string | null }> {
    const batch = this.deps.jobs.active(projectId).find((j) => j.kind === 'batch.generate');
    if (!batch) return { cancelled: null };
    await this.deps.jobs.cancel(projectId, batch.id, 'batch paused', { cascade: false });
    return { cancelled: batch.id };
  }
}

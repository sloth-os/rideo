import { join } from 'node:path';
import {
  approvedReferences,
  assembleStageReview,
  autoApplicable,
  boardNeedsGeneration,
  boardState,
  type Character,
  type Clip,
  castElements,
  castReadyForReview,
  castReviewSubject,
  clipBoardSubject,
  clipGate,
  clipReviewState,
  clipReviewVerdict,
  compactIdentity,
  cutClips,
  cutReviewSubject,
  cutTakeItems,
  docPath,
  identityFragment,
  mergeSubjectReviews,
  orderedShotCharacters,
  type ProjectDocs,
  type ReviewTargets,
  reviewSettings,
  type StageIssue,
  type StageRecommendation,
  type StageReview,
  type StageReviewOutput,
  StageReviewSchema,
  sortedClips,
  stageVerdict,
  takePassesChecks,
  watchesTakes,
  withWatch,
} from '@rideo/shared';
import { watchTake } from '../../consistency/watch';
import { invalid, notFound } from '../../errors';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import {
  applyStoryboardFixes,
  asReview,
  finish,
  historyEntry,
  markApplied,
  reviewSceneFrames,
  videoFacts,
  withCarried,
  writeReview,
} from './ai-review';
import { ensureBlocking } from './blocking';
import { commitAs, docsFor, type HandlerDeps } from './common';
import { activeReferenceJobs } from './story';
import { drawBoards } from './storyboard';

/**
 * Reviews that gate every step of Idea → movie (docs/design/ai-review.md#autopilot-every-step-reviewed-and-approved):
 * the cast, a production scene's storyboard, takes watched whole, the cut before export, and the clip gate.
 */

const byIndex = <T extends { index: number }>(a: T, b: T) => a.index - b.index;

/** The longest direction a redraw adds to its image requests (the round's instructions for one subject). */
const REDRAW_DIRECTION_MAX = 1500;

/**
 * A cast review's fix: the subject's references drawn again as a child job, from the ones they replace and with the
 * round's instructions as its direction.
 */
async function redrawReferences(
  ctx: JobContext,
  docs: ProjectDocs,
  redraw: { characterId?: string; elementId?: string; instructions: string[] },
) {
  // The old references stay as the anchor until the new ones are drawn, then are dismissed: deleting them first drew
  // the new ones from text alone (docs/design/ai-review.md#how-a-review-runs)
  const direction = redraw.instructions.join(' ').slice(0, REDRAW_DIRECTION_MAX).trim();
  const extra = (refs: { id: string; source: string; approved: boolean }[]) => {
    const replaces = refs.filter((r) => r.source === 'generated' && !r.approved).map((r) => r.id);
    return { ...(direction ? { direction } : {}), ...(replaces.length ? { replaces } : {}) };
  };
  if (redraw.characterId) {
    const c = docs.characters[redraw.characterId];
    if (!c || c.lock.locked) return null;
    return ctx.spawn(
      'character.refs',
      {
        characterId: c.id,
        views: ['front', 'three_quarter', 'profile', 'full_body'],
        ...extra(c.references),
      },
      { dedupeKey: `refs:${c.id}` },
    );
  }
  const e = redraw.elementId ? docs.elements[redraw.elementId] : undefined;
  if (!e || e.lock.locked) return null;
  const views = [...new Set(e.references.map((r) => r.view))];
  return ctx.spawn(
    'element.refs',
    { elementId: e.id, ...(views.length ? { views } : {}), ...extra(e.references) },
    { dedupeKey: `element-refs:${e.id}` },
  );
}

/**
 * `cast.review` (docs/design/ai-review.md#how-a-review-runs): every character's and every element in use's references
 * reviewed by the vision model, drawn again where it asks and reviewed again up to `maxRounds`; on autopilot a pass
 * approves and locks the cast and approves `cast_locked`.
 */
export async function castReview(deps: HandlerDeps, ctx: JobContext) {
  const first = await docsFor(deps, ctx);
  if (!castReadyForReview(first))
    throw invalid(
      'generate or upload a reference of every character and of every place and prop in use first',
    );
  return asReview(deps, ctx, 'cast', () => reviewCastRounds(deps, ctx));
}

async function reviewCastRounds(deps: HandlerDeps, ctx: JobContext) {
  const projectId = ctx.job.projectId;
  let docs = await docsFor(deps, ctx);
  const settings = reviewSettings(docs);
  const previous = docs.aiReviews.cast;
  let history = previous?.verdict
    ? [...previous.history, historyEntry(previous, 0)].slice(-20)
    : (previous?.history ?? []);
  for (let round = 1; ; round++) {
    throwIfAborted(ctx.signal);
    // References still being drawn are waited for: the review is of the cast as it will be
    const drawing = activeReferenceJobs(deps, ctx);
    if (drawing.length) {
      ctx.progress(0, 1, `waiting for ${drawing.length} reference job(s)`);
      await ctx.waitFor(drawing.map((j) => j.id));
    }
    docs = await docsFor(deps, ctx);
    const subject = castReviewSubject(docs);
    const sp = docs.screenplay;
    const film = {
      title: sp?.title ?? docs.project.title,
      style: [sp?.style.visual, sp?.style.palette, sp?.style.lighting].filter(Boolean).join('; '),
      tone: sp?.tone ?? '',
    };
    const chars = Object.values(docs.characters).sort((a, b) => a.name.localeCompare(b.name));
    const elements = castElements(docs)
      .filter((e) => e.references.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const total = chars.length + elements.length;
    const parts: { name: string; kind: 'character' | 'element'; out: StageReviewOutput }[] = [];
    const images = async (refs: { view: string; media: Character['references'][number]['media'] }[]) =>
      Promise.all(
        refs.slice(0, 6).map(async (r, i) => ({
          label: `${i + 1} (${r.view.replace(/_/g, ' ')})`,
          data: await deps.media.pngBuffer(projectId, r.media, 512),
        })),
      );
    for (const c of chars) {
      throwIfAborted(ctx.signal);
      ctx.progress(parts.length, total, `reviewing ${c.name} (round ${round})`);
      const wardrobe = c.wardrobe.find((w) => w.default) ?? c.wardrobe[0];
      const out = await deps.llm.reviewCast(
        {
          film,
          subject: {
            kind: 'character',
            name: c.name,
            role: c.role,
            // The whole identity (face, hair, eyes, marks): what the references must show
            identity: identityFragment(c),
            wardrobe: wardrobe?.description ?? '',
            references: c.references
              .slice(0, 6)
              .map((r, i) => ({ index: i + 1, view: r.view, approved: r.approved })),
          },
          others: chars.filter((o) => o.id !== c.id).map((o) => ({ name: o.name, look: compactIdentity(o) })),
        },
        await images(c.references),
        ctx.signal,
      );
      parts.push({ name: c.name, kind: 'character', out });
    }
    for (const e of elements) {
      throwIfAborted(ctx.signal);
      ctx.progress(parts.length, total, `reviewing ${e.name} (round ${round})`);
      const out = await deps.llm.reviewCast(
        {
          film,
          subject: {
            kind: 'element',
            elementKind: e.kind,
            name: e.name,
            description: e.description,
            references: e.references
              .slice(0, 6)
              .map((r, i) => ({ index: i + 1, view: r.view, approved: r.approved })),
          },
          others: [],
        },
        await images(e.references),
        ctx.signal,
      );
      parts.push({ name: e.name, kind: 'element', out });
    }
    const targets: ReviewTargets = {
      scenes: new Map(),
      characters: new Map(chars.map((c) => [c.name.toLowerCase(), c.id])),
      elements: new Map(elements.map((e) => [e.name.toLowerCase(), e.id])),
    };
    const review = await writeReview(
      deps,
      ctx,
      'cast',
      {
        status: 'succeeded',
        jobId: ctx.job.id,
        model: deps.llm.vision.model,
        subject,
        round,
        threshold: settings.threshold,
        history,
        error: undefined,
        ...withCarried(
          assembleStageReview('cast', mergeSubjectReviews(parts), targets, settings.threshold, round),
          docs.aiReviews.cast,
          round,
        ),
      },
      `Review the cast (round ${round})`,
    );
    deps.metrics.aiReviewScore.observe({ stage: 'cast' }, review.verdict!.score);
    ctx.log.info(
      { stage: 'cast', round, score: review.verdict!.score, passed: review.verdict!.passed },
      'reviewed',
    );
    if (review.verdict!.passed) return finish(deps, ctx, 'cast', review, round);
    const todo = settings.autoRevise && round - 1 < settings.maxRounds ? autoApplicable(review) : [];
    if (!todo.length) return finish(deps, ctx, 'cast', review, round);
    ctx.progress(total, total, `drawing ${todo.length} cast member(s) again`);
    await markApplied(
      deps,
      ctx,
      'cast',
      todo.map((r) => r.id),
      ctx.actor,
    );
    // One redraw per character or element, with every instruction the round gave it
    const redraws = new Map<string, { characterId?: string; elementId?: string; instructions: string[] }>();
    for (const r of todo)
      if (r.action?.kind === 'regenerate_refs') {
        const { characterId, elementId, instruction } = r.action;
        const key = characterId ?? elementId ?? '';
        const redraw = redraws.get(key) ?? { characterId, elementId, instructions: [] };
        if (instruction?.trim()) redraw.instructions.push(instruction.trim());
        redraws.set(key, redraw);
        deps.metrics.aiReviewRecommendations.inc({ stage: 'cast', action: r.action.kind, outcome: 'auto' });
      }
    const current = await docsFor(deps, ctx);
    const jobs = [];
    for (const redraw of redraws.values()) {
      throwIfAborted(ctx.signal);
      const job = await redrawReferences(ctx, current, redraw);
      if (job) jobs.push(job);
    }
    if (jobs.length) await ctx.waitFor(jobs.map((j) => j.id));
    history = [...history, historyEntry(review, todo.length)].slice(-20);
  }
}

/** Writes a production scene's storyboard review on its clip. */
async function writeBoardReview(
  deps: HandlerDeps,
  ctx: JobContext,
  clipId: string,
  patch: Partial<StageReview>,
  message: string,
): Promise<StageReview> {
  const { result } = await commitAs(
    deps,
    ctx,
    (tx) => {
      const clip = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
      const now = new Date().toISOString();
      clip.boardReview = StageReviewSchema.parse({
        ...(clip.boardReview ?? { createdAt: now }),
        stage: 'storyboard',
        ...patch,
        updatedAt: now,
      });
      tx.set(docPath.clip(clipId), clip);
      return clip.boardReview;
    },
    message,
  );
  return result;
}

/**
 * `clip.storyboard` (docs/design/ai-review.md#production-storyboards): a production scene blocked, its frames drawn and
 * reviewed (rounds with fixes); a pass approves its frames as the system.
 */
export async function clipStoryboard(deps: HandlerDeps, ctx: JobContext) {
  const { clipId } = ctx.job.params as { clipId: string };
  const projectId = ctx.job.projectId;
  let docs = await docsFor(deps, ctx);
  let clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  if (!clip.shots.length) throw invalid(`plan the shots of clip ${clip.index + 1} first`);
  const scene = clip.index + 1;
  ctx.progress(0.05, 1, `blocking scene ${scene}`);
  await ensureBlocking(deps, ctx, [clipId]);
  const draw = async () => {
    const d = await docsFor(deps, ctx);
    const c = d.clips[clipId]!;
    const targets = c.shots
      .filter((s) => boardNeedsGeneration(boardState(s, d)))
      .map((shot) => ({ clip: c, shot }));
    if (targets.length) await drawBoards(ctx, targets);
  };
  ctx.progress(0.15, 1, `drawing the frames of scene ${scene}`);
  await draw();
  docs = await docsFor(deps, ctx);
  const settings = reviewSettings(docs);
  if (!settings.storyboard) {
    await deps.services.storyboard.approveFrames(ctx.actor, projectId, clipId);
    return { passed: true, reviewed: false };
  }
  const { limits } = await deps.gateway.limitsFor('video', docs.project.settings.models.video);
  const video = videoFacts(limits, docs.project.settings);
  const previous = docs.clips[clipId]!.boardReview;
  let history = previous?.verdict
    ? [...previous.history, historyEntry(previous, 0)].slice(-20)
    : (previous?.history ?? []);
  await writeBoardReview(
    deps,
    ctx,
    clipId,
    { status: 'running', jobId: ctx.job.id, error: undefined },
    `Review the storyboard of scene ${scene}`,
  );
  try {
    for (let round = 1; ; round++) {
      throwIfAborted(ctx.signal);
      docs = await docsFor(deps, ctx);
      clip = docs.clips[clipId]!;
      const sceneDoc = docs.screenplay?.scenes.find((s) => s.id === clip!.sceneId);
      if (!sceneDoc) throw notFound(`the scene of clip ${scene}`);
      const number =
        [...(docs.screenplay?.scenes ?? [])].sort(byIndex).findIndex((s) => s.id === sceneDoc.id) + 1;
      ctx.progress(0.5, 1, `reviewing the storyboard of scene ${scene} (round ${round})`);
      const { out, target } = await reviewSceneFrames(deps, ctx, docs, clip, sceneDoc, number, video);
      const targets: ReviewTargets = {
        scenes: new Map([[number, sceneDoc.id]]),
        clips: new Map([[number, target]]),
      };
      const at = <T extends { scene?: number }>(xs: T[]) =>
        xs.map((x) => ({ ...x, scene: x.scene ?? number }));
      const parts = assembleStageReview(
        'storyboard',
        { ...out, issues: at(out.issues), recommendations: at(out.recommendations) },
        targets,
        settings.threshold,
        round,
      );
      const review = await writeBoardReview(
        deps,
        ctx,
        clipId,
        {
          status: 'succeeded',
          jobId: ctx.job.id,
          model: deps.llm.vision.model,
          subject: clipBoardSubject(clip),
          round,
          threshold: settings.threshold,
          history,
          error: undefined,
          ...withCarried(parts, docs.clips[clipId]!.boardReview ?? undefined, round),
        },
        `Review the storyboard of scene ${scene} (round ${round}): ${parts.verdict?.score ?? '–'}`,
      );
      deps.metrics.aiReviewScore.observe({ stage: 'storyboard' }, review.verdict!.score);
      ctx.log.info(
        { clipId, round, score: review.verdict!.score, passed: review.verdict!.passed },
        'reviewed the scene storyboard',
      );
      if (review.verdict!.passed) {
        deps.metrics.aiReviews.inc({ stage: 'storyboard', outcome: 'passed' });
        deps.metrics.aiReviewRounds.observe({ stage: 'storyboard' }, round);
        await deps.services.storyboard.approveFrames(ctx.actor, projectId, clipId);
        deps.metrics.autopilotApprovals.inc({ step: 'frames' });
        return { passed: true, round, score: review.verdict!.score };
      }
      const todo = settings.autoRevise && round - 1 < settings.maxRounds ? autoApplicable(review) : [];
      if (!todo.length) {
        deps.metrics.aiReviews.inc({ stage: 'storyboard', outcome: 'failed' });
        deps.metrics.aiReviewRounds.observe({ stage: 'storyboard' }, round);
        return { passed: false, round, score: review.verdict!.score, blocking: review.verdict!.blocking };
      }
      const ids = new Set(todo.map((r) => r.id));
      const at2 = new Date().toISOString();
      await writeBoardReview(
        deps,
        ctx,
        clipId,
        {
          recommendations: review.recommendations.map((r) =>
            ids.has(r.id) ? { ...r, status: 'applied', appliedAt: at2, appliedBy: ctx.actor } : r,
          ),
        },
        `Apply ${todo.length} fix(es) of the storyboard review of scene ${scene}`,
      );
      await applyStoryboardFixes(
        deps,
        ctx,
        todo.map((r) => r.action!),
      );
      for (const r of todo)
        deps.metrics.aiReviewRecommendations.inc({
          stage: 'storyboard',
          action: r.action!.kind,
          outcome: 'auto',
        });
      history = [...history, historyEntry(review, todo.length)].slice(-20);
    }
  } catch (err) {
    deps.metrics.aiReviews.inc({ stage: 'storyboard', outcome: 'error' });
    await writeBoardReview(
      deps,
      ctx,
      clipId,
      {
        status: 'failed',
        error: ctx.signal.aborted
          ? 'cancelled'
          : (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      },
      `The storyboard review of scene ${scene} stopped`,
    ).catch(() => undefined);
    throw err;
  }
}

/**
 * `takes.watch` (docs/design/ai-review.md#takes-watched-whole): takes watched whole from their stored videos, without
 * generating anything; each report keeps its identity and sound verdicts and gains its watch. Takes watched already
 * are left alone.
 */
export async function takesWatch(deps: HandlerDeps, ctx: JobContext) {
  const { takes } = ctx.job.params as { takes: { clipId: string; shotId: string; takeId: string }[] };
  const projectId = ctx.job.projectId;
  let watched = 0;
  let failed = 0;
  let unwatched = 0;
  return deps.media.withTmpDir(async (dir) => {
    for (const [i, t] of (takes ?? []).entries()) {
      throwIfAborted(ctx.signal);
      ctx.progress(i, takes.length, `watching take ${i + 1}/${takes.length}`);
      const docs = await docsFor(deps, ctx);
      const clip = docs.clips[t.clipId];
      const shot = clip?.shots.find((s) => s.id === t.shotId);
      const take = shot?.takes.find((x) => x.id === t.takeId);
      if (!clip || !shot || !take?.video || take.consistency.quality?.watch) continue;
      const characters = orderedShotCharacters(shot, docs.characters);
      const references = new Map<string, Buffer[]>();
      for (const c of characters) {
        const ref = approvedReferences(c)[0] ?? c.references[0];
        if (ref) references.set(c.id, [await deps.media.pngBuffer(projectId, ref.media, 512)]);
      }
      const here = new Set(shot.characterIds);
      const offscreen = [...new Set(clip.shots.flatMap((s) => s.characterIds))]
        .filter((id) => !here.has(id))
        .map((id) => docs.characters[id]?.name)
        .filter((n): n is string => !!n);
      const settings = docs.project.settings;
      const result = await watchTake({
        llm: deps.llm,
        ff: deps.ff,
        video: await deps.media.localPath(projectId, take.video),
        clip: join(dir, `watch-${i}.mp4`),
        shot,
        characters,
        references,
        offscreen,
        allCharacters: docs.characters,
        place: docs.screenplay?.scenes.find((s) => s.id === clip.sceneId)?.location ?? '',
        castOnly: settings.consistency.castOnly === true,
        durationSec: take.durationSec ?? shot.durationSec,
        qualityThreshold: settings.consistency.qualityThreshold,
        metrics: deps.metrics,
        log: ctx.log,
        signal: ctx.signal,
      });
      if (!result) {
        unwatched++;
        continue;
      }
      watched++;
      if (!result.watch.passed) failed++;
      await commitAs(
        deps,
        ctx,
        (tx) => {
          const c = structuredClone(tx.require<Clip>(docPath.clip(t.clipId), `clip ${t.clipId}`));
          const x = c.shots.find((s) => s.id === t.shotId)?.takes.find((y) => y.id === t.takeId);
          if (!x) return;
          x.consistency = {
            ...x.consistency,
            quality: withWatch(x.consistency.quality, result.watch, result.issues),
          };
          tx.set(docPath.clip(t.clipId), c);
        },
        `Watch take ${t.takeId} of shot c${clip.index + 1}-s${shot.index + 1} whole (${result.watch.passed ? 'passed' : 'failed'}, ${result.watch.overall}/10)`,
      );
    }
    ctx.progress(takes.length, takes.length, 'done');
    return { watched, failed, unwatched };
  });
}

/** Seconds as `41.0 s`. */
const secs = (n: number) => `${n.toFixed(1)} s`;

/**
 * The cut's review from what its takes' and scenes' checks say (docs/design/ai-review.md#the-cut-before-export): its
 * scores, an issue for every take or scene that fails, their fixes.
 */
export function assembleCutReview(docs: ProjectDocs) {
  const settings = reviewSettings(docs);
  const issues: StageIssue[] = [];
  const recommendations: StageRecommendation[] = [];
  const items = cutTakeItems(docs);
  let passing = 0;
  for (const item of items) {
    const clip = docs.clips[item.clipId];
    const shot = clip?.shots.find((s) => s.id === item.shotId);
    const take = shot?.takes.find((t) => t.id === item.takeId);
    const label = clip && shot ? `C${clip.index + 1}·S${shot.index + 1}` : item.itemId;
    const where = { ...(clip ? { clipId: clip.id } : {}), ...(shot ? { shotId: shot.id } : {}), shot: label };
    if (!clip || !shot || !take) {
      issues.push({
        id: `i${issues.length + 1}`,
        dimension: 'takes',
        severity: 'critical',
        title: `${label}: the take in the cut no longer exists`,
        detail: `at ${secs(item.start)} in the cut`,
        ...where,
      });
      continue;
    }
    const checks = !!take.override || takePassesChecks(take, shot, docs.characters, docs.elements);
    const watch = take.consistency.quality?.watch;
    const watchedOk = !watchesTakes(docs.project.settings) || !!take.override || watch?.passed === true;
    if (checks && watchedOk) {
      passing++;
      continue;
    }
    const why = !checks
      ? take.consistency.quality?.issues.slice(0, 2).join('; ') ||
        `its consistency is ${take.consistency.status}`
      : watch
        ? watch.issues
            .filter((i) => i.severity !== 'minor')
            .map((i) => `${i.title} at ${secs(i.time)}`)
            .slice(0, 2)
            .join('; ') || 'it failed its whole-take watch'
        : 'it was not watched whole (no model watched video)';
    const id = `i${issues.length + 1}`;
    issues.push({
      id,
      dimension: 'takes',
      severity: 'critical',
      title: `${label}: the take ${checks ? 'failed its watch' : 'fails its checks'}`,
      detail: `${why} (at ${secs(item.start)} in the cut)`.slice(0, 3000),
      ...where,
    });
    if (watch || !checks)
      recommendations.push({
        id: `r${recommendations.length + 1}`,
        priority: 1,
        dimension: 'takes',
        title: `Generate ${label} again`,
        detail: why.slice(0, 3000),
        issueIds: [id],
        action: { kind: 'regenerate_shot', clipId: clip.id, shotId: shot.id },
        status: 'open',
      });
  }
  const scenes = cutClips(docs);
  const weights: { w: number; overall: number; continuity: number | null; sound: number | null }[] = [];
  for (const clip of scenes) {
    const dur = Math.max(
      1,
      clip.shots.reduce((n, s) => n + s.durationSec, 0),
    );
    const r = clip.review;
    if (!settings.scenes || clip.shots.length < 2) continue;
    const state = clipReviewState(clip);
    const label = `Scene ${clip.index + 1}`;
    if (!r || state !== 'current') {
      issues.push({
        id: `i${issues.length + 1}`,
        dimension: 'scenes',
        severity: 'critical',
        title: `${label} has no current review`,
        detail: `its review is ${state}`,
        clipId: clip.id,
      });
      continue;
    }
    const verdict = r.verdict ?? clipReviewVerdict(r, settings.sceneThreshold);
    weights.push({
      w: dur,
      overall: r.overall ?? 0,
      continuity: r.scores.continuity ?? null,
      sound: r.scores.sound ?? r.scores.dialogue ?? null,
    });
    if (verdict.passed) continue;
    const id = `i${issues.length + 1}`;
    issues.push({
      id,
      dimension: 'scenes',
      severity: 'critical',
      title: `${label} did not pass its review (${verdict.score}/10)`,
      detail: verdict.blocking.slice(0, 4).join('; '),
      clipId: clip.id,
    });
    for (const rec of r.recommendations)
      if (
        rec.status === 'open' &&
        rec.priority === 1 &&
        rec.action?.kind === 'regenerate_shot' &&
        recommendations.length < 40
      )
        recommendations.push({
          id: `r${recommendations.length + 1}`,
          priority: 1,
          dimension: 'scenes',
          title: rec.title,
          detail: rec.detail,
          issueIds: [id],
          action: { kind: 'regenerate_shot', clipId: clip.id, shotId: rec.action.shotId },
          status: 'open',
        });
  }
  const mean = (pick: (x: (typeof weights)[number]) => number | null) => {
    const xs = weights.filter((x) => pick(x) !== null);
    const w = xs.reduce((n, x) => n + x.w, 0);
    return xs.length ? Math.round((xs.reduce((n, x) => n + pick(x)! * x.w, 0) / w) * 10) / 10 : null;
  };
  const scores: Record<string, number | null> = {
    takes: items.length ? Math.round((100 * passing) / items.length) / 10 : null,
    scenes: mean((x) => x.overall),
    continuity: mean((x) => x.continuity),
    sound: mean((x) => x.sound),
  };
  const verdict = stageVerdict('cut', scores, issues, settings.sceneThreshold);
  const failedTakes = items.length - passing;
  return {
    scores,
    summary: `${passing} of ${items.length} takes of the cut pass every check${watchesTakes(docs.project.settings) ? ', watched whole' : ''}; ${weights.length} scene(s) reviewed${failedTakes ? `; ${failedTakes} take(s) to fix` : ''}.`,
    strengths: [],
    issues: issues.slice(0, 200),
    recommendations: recommendations.slice(0, 100),
    verdict,
  };
}

/**
 * `cut.review` (docs/design/ai-review.md#the-cut-before-export): every take of the cut watched whole and passing,
 * every scene's review current and passing, fixes applied up to `maxRounds`; on autopilot a pass approves
 * `cut_approved`, and the export follows.
 */
export async function cutReview(deps: HandlerDeps, ctx: JobContext) {
  const first = await docsFor(deps, ctx);
  if (!cutTakeItems(first).length) throw invalid('assemble the cut first');
  return asReview(deps, ctx, 'cut', () => reviewCutRounds(deps, ctx));
}

async function reviewCutRounds(deps: HandlerDeps, ctx: JobContext) {
  let docs = await docsFor(deps, ctx);
  const settings = reviewSettings(docs);
  const previous = docs.aiReviews.cut;
  let history = previous?.verdict
    ? [...previous.history, historyEntry(previous, 0)].slice(-20)
    : (previous?.history ?? []);
  for (let round = 1; ; round++) {
    throwIfAborted(ctx.signal);
    docs = await docsFor(deps, ctx);
    // Clip level: the takes of the cut that were never watched whole
    if (watchesTakes(docs.project.settings)) {
      const unwatched = cutTakeItems(docs).filter((t) => {
        const take = docs.clips[t.clipId]?.shots
          .find((s) => s.id === t.shotId)
          ?.takes.find((x) => x.id === t.takeId);
        return !!take?.video && !take.consistency.quality?.watch;
      });
      if (unwatched.length) {
        ctx.progress(0.1, 1, `watching ${unwatched.length} take(s) of the cut whole (round ${round})`);
        const job = await ctx.spawn('takes.watch', {
          takes: unwatched.map(({ clipId, shotId, takeId }) => ({ clipId, shotId, takeId })),
        });
        await ctx.waitFor([job.id]);
      }
    }
    // Scene level: every scene of the cut with a current review
    docs = await docsFor(deps, ctx);
    if (settings.scenes) {
      const stale = cutClips(docs).filter((c) => c.shots.length >= 2 && clipReviewState(c) !== 'current');
      if (stale.length) {
        ctx.progress(0.4, 1, `reviewing ${stale.length} scene(s) of the cut (round ${round})`);
        const jobs = [];
        for (const c of stale)
          jobs.push(await ctx.spawn('clip.review', { clipId: c.id }, { dedupeKey: `review:${c.id}` }));
        await ctx.waitFor(jobs.map((j) => j.id));
      }
    }
    docs = await docsFor(deps, ctx);
    const parts = assembleCutReview(docs);
    const review = await writeReview(
      deps,
      ctx,
      'cut',
      {
        status: 'succeeded',
        jobId: ctx.job.id,
        model: deps.llm.vision.model,
        subject: cutReviewSubject(docs),
        round,
        threshold: settings.sceneThreshold,
        history,
        error: undefined,
        ...withCarried(parts, docs.aiReviews.cut, round),
      },
      `Review the cut (round ${round}): ${parts.verdict.passed ? 'passed' : `${parts.issues.length} issue(s)`}`,
    );
    deps.metrics.aiReviewScore.observe({ stage: 'cut' }, review.verdict!.score);
    ctx.log.info(
      {
        stage: 'cut',
        round,
        score: review.verdict!.score,
        passed: review.verdict!.passed,
        issues: review.issues.length,
      },
      'reviewed',
    );
    if (review.verdict!.passed) return finish(deps, ctx, 'cut', review, round);
    // The fixes: at most sceneFixes regenerations per scene, each selected and put in the cut only when it passes
    const perScene = new Map<string, number>();
    const todo =
      settings.autoRevise && round - 1 < settings.maxRounds
        ? autoApplicable(review).filter((r) => {
            if (r.action?.kind !== 'regenerate_shot') return false;
            const n = perScene.get(r.action.clipId) ?? 0;
            if (n >= Math.max(1, settings.sceneFixes)) return false;
            perScene.set(r.action.clipId, n + 1);
            return true;
          })
        : [];
    if (!todo.length) return finish(deps, ctx, 'cut', review, round);
    ctx.progress(0.7, 1, `generating ${todo.length} shot(s) of the cut again`);
    await markApplied(
      deps,
      ctx,
      'cut',
      todo.map((r) => r.id),
      ctx.actor,
    );
    const jobs = [];
    const shots = new Set<string>();
    for (const r of todo) {
      if (r.action?.kind !== 'regenerate_shot' || shots.has(r.action.shotId)) continue;
      shots.add(r.action.shotId);
      jobs.push(
        await ctx.spawn(
          'shot.generate',
          { clipId: r.action.clipId, shotId: r.action.shotId, selectIfPasses: true, swapInCut: true },
          { priority: 10, dedupeKey: `shot:${r.action.shotId}` },
        ),
      );
      deps.metrics.aiReviewRecommendations.inc({ stage: 'cut', action: 'regenerate_shot', outcome: 'auto' });
    }
    if (jobs.length) await ctx.waitFor(jobs.map((j) => j.id));
    history = [...history, historyEntry(review, todo.length)].slice(-20);
  }
}

/**
 * On autopilot, approves a clip when its clip gate holds (docs/design/ai-review.md#the-clip-gate); the pilot's
 * approval approves `pilot_approved` too. Returns whether the clip was approved.
 */
export async function approveClipOnAutopilot(
  deps: HandlerDeps,
  ctx: JobContext,
  clipId: string,
): Promise<boolean> {
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  if (!docs.project.settings.autopilot) return false;
  const clip = docs.clips[clipId];
  if (!clip || clip.status === 'approved') return false;
  const gate = clipGate(clip, docs);
  if (!gate.ok) {
    ctx.log.info({ clipId, blocking: gate.blocking.slice(0, 5) }, 'the clip waits for a person');
    return false;
  }
  try {
    await deps.services.clips.approveClip(ctx.actor, projectId, clipId);
    deps.metrics.autopilotApprovals.inc({ step: 'clip' });
  } catch (err) {
    ctx.log.info({ clipId, err: (err as Error).message.slice(0, 300) }, 'the clip could not be approved');
    return false;
  }
  const after = await docsFor(deps, ctx);
  if (after.project.workflow.stage === 'pilot' && sortedClips(after)[0]?.id === clipId)
    try {
      await deps.services.workflow.approve(ctx.actor, projectId, 'pilot_approved');
      deps.metrics.autopilotApprovals.inc({ step: 'pilot' });
    } catch (err) {
      ctx.log.info({ err: (err as Error).message.slice(0, 300) }, 'the pilot gate stays open');
    }
  return true;
}

/** On autopilot, approves `production_approved` once every clip is approved and the target is reached. */
export async function approveProductionOnAutopilot(deps: HandlerDeps, ctx: JobContext): Promise<boolean> {
  const docs = await docsFor(deps, ctx);
  if (!docs.project.settings.autopilot || docs.project.workflow.stage !== 'production') return false;
  try {
    await deps.services.workflow.approve(ctx.actor, ctx.job.projectId, 'production_approved');
    deps.metrics.autopilotApprovals.inc({ step: 'production' });
    return true;
  } catch (err) {
    ctx.log.info({ err: (err as Error).message.slice(0, 300) }, 'the production gate stays open');
    return false;
  }
}

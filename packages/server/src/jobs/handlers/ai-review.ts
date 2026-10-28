import {
  type Actor,
  assembleStageReview,
  autoApplicable,
  boardState,
  type Character,
  type Clip,
  carriedFixes,
  castIdsOf,
  compactIdentity,
  docPath,
  type Element,
  type ModelLimits,
  mergeSceneReviews,
  type ProjectDocs,
  plannedShotRange,
  type ReviewStage,
  type ReviewTargets,
  reviewSettings,
  reviseScenes,
  type Scene,
  type Screenplay,
  type ScreenplayReviewInput,
  type StageAction,
  type StageRecommendation,
  type StageReview,
  type StageReviewOutput,
  StageReviewSchema,
  type StoryboardSceneReviewInput,
  screenplayReviewSubject,
  storyboardClips,
  storyboardReviewSubject,
  type VideoModelFacts,
  voicePhrase,
} from '@rideo/shared';
import { invalid } from '../../errors';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps } from './common';

/** What the video model does well and badly, told to the reviewers (docs/design/ai-review.md#how-a-review-runs). */
export const VIDEO_MODEL_FACTS = {
  strengths: [
    'one or two characters in a shot, three at most',
    'clear, simple actions with visible cause and effect',
    'natural light, weather and landscapes',
    'medium shots and close-ups that hold one framing',
    "lines spoken in the shot, in each character's voice",
  ],
  weaknesses: [
    'crowds and background people',
    'on-screen text, signs and labels',
    'fine hand work: holding small objects, tying, buckling, operating machines',
    'mechanical handling: boarding a lift, putting on equipment',
    'quick repeated motion',
    'a character who appears in a shot from nowhere',
    'takes longer than ten seconds: they drift and cut themselves',
    'inserts that must hold a tight framing: the camera widens',
  ],
};

export function videoFacts(limits: ModelLimits | null): VideoModelFacts {
  const { min, max } = plannedShotRange(limits);
  return { shotSeconds: { min, max }, ...VIDEO_MODEL_FACTS };
}

const byIndex = <T extends { index: number }>(a: T, b: T) => a.index - b.index;

/** The screenplay as the reviewer and the reviser read it (scenes numbered from 1 in order). */
export function screenplayReviewInput(docs: ProjectDocs, video: VideoModelFacts): ScreenplayReviewInput {
  const sp = docs.screenplay!;
  const settings = docs.project.settings;
  const nameOf = (id: string) => docs.characters[id]?.name ?? '';
  const elementName = (id: string | null) => (id ? (docs.elements[id]?.name ?? '') : '');
  const level = settings.dialogue?.level ?? 'any';
  return {
    brief: {
      prompt: docs.project.brief.prompt,
      targetDurationSec: settings.targetDurationSec,
      dialogueLevel: level === 'any' ? null : level,
      castOnly: settings.consistency.castOnly === true,
    },
    screenplay: {
      title: sp.title,
      logline: sp.logline,
      synopsis: sp.synopsis.slice(0, 6000),
      genre: sp.genre,
      tone: sp.tone,
      style: [sp.style.visual, sp.style.palette, sp.style.lighting, sp.style.camera]
        .filter(Boolean)
        .join('; '),
      outline: [...sp.outline].sort(byIndex).map((b) => ({
        index: b.index,
        title: b.title,
        summary: b.summary.slice(0, 1500),
        purpose: b.purpose,
        estDurationSec: b.estDurationSec,
      })),
      scenes: [...sp.scenes].sort(byIndex).map((s, i) => ({
        number: i + 1,
        heading: s.heading,
        location: s.location || elementName(s.locationId),
        timeOfDay: s.timeOfDay,
        continuity: s.continuity,
        summary: s.summary,
        action: s.action.slice(0, 6000),
        dialogue: s.dialogue.map((d) => ({ character: d.character, line: d.line })),
        characters: s.characterIds.map(nameOf).filter(Boolean),
        props: s.elementIds.map((id) => elementName(id)).filter(Boolean),
        estDurationSec: s.estDurationSec,
      })),
    },
    cast: Object.values(docs.characters).map((c: Character) => ({
      name: c.name,
      role: c.role,
      summary: c.summary.slice(0, 600),
      look: compactIdentity(c),
      voice: voicePhrase(c),
    })),
    places: Object.values(docs.elements)
      .filter((e) => e.kind === 'location')
      .map((e) => e.name),
    props: Object.values(docs.elements)
      .filter((e) => e.kind === 'prop')
      .map((e) => e.name),
    video,
  };
}

/** One storyboarded scene as the reviewer sees it, its frames attached in shot order. */
export function storyboardSceneInput(
  docs: ProjectDocs,
  clip: Clip,
  scene: Scene,
  number: number,
  video: VideoModelFacts,
): StoryboardSceneReviewInput {
  const sp = docs.screenplay!;
  const sp2 = [...sp.scenes].sort(byIndex);
  const neighbour = (s?: Scene) => (s ? { heading: s.heading, summary: s.summary } : null);
  const at = sp2.findIndex((s) => s.id === scene.id);
  const castIds = [...new Set(clip.shots.flatMap((s) => s.characterIds))];
  const names = (ids: string[]) => ids.map((id) => docs.characters[id]?.name ?? '').filter(Boolean);
  const level = docs.project.settings.dialogue?.level ?? 'any';
  return {
    film: {
      title: sp.title,
      tone: sp.tone,
      style: [sp.style.visual, sp.style.palette, sp.style.lighting].filter(Boolean).join('; '),
      dialogueLevel: level === 'any' ? null : level,
      castOnly: docs.project.settings.consistency.castOnly === true,
    },
    scene: { number, heading: scene.heading, continuity: scene.continuity, summary: scene.summary },
    previousScene: neighbour(sp2[at - 1]),
    nextScene: neighbour(sp2[at + 1]),
    cast: castIds
      .map((id) => docs.characters[id])
      .filter((c): c is Character => !!c)
      .map((c) => ({ name: c.name, look: compactIdentity(c) })),
    shots: [...clip.shots].sort(byIndex).map((s, i) => ({
      index: i,
      label: `C${clip.index + 1}·S${s.index + 1}`,
      durationSec: s.durationSec,
      camera: `${s.camera.framing.replace(/_/g, ' ')}, ${s.camera.movement.replace(/_/g, ' ')}${s.camera.lensMm ? `, ${s.camera.lensMm} mm` : ''}`,
      description: s.description,
      action: s.action,
      characters: names(s.characterIds),
      dialogue: s.dialogue.map((d) => ({
        character: d.characterId ? (docs.characters[d.characterId]?.name ?? 'Someone') : 'Narrator',
        line: d.line,
      })),
      frame: s.board ? 'attached' : 'missing',
    })),
    video,
  };
}

/** Writes the stage's review over what is there (the history and the override stay unless replaced). */
async function writeReview(
  deps: HandlerDeps,
  ctx: JobContext,
  stage: ReviewStage,
  patch: Partial<StageReview>,
  message: string,
): Promise<StageReview> {
  const { result } = await commitAs(
    deps,
    ctx,
    (tx) => {
      const now = new Date().toISOString();
      const current = tx.get<StageReview>(docPath.aiReview(stage));
      const next = StageReviewSchema.parse({
        ...(current ?? { createdAt: now }),
        stage,
        ...patch,
        updatedAt: now,
      });
      tx.set(docPath.aiReview(stage), next);
      return next;
    },
    message,
  );
  return result;
}

/** Marks recommendations applied by the review's own round. */
async function markApplied(
  deps: HandlerDeps,
  ctx: JobContext,
  stage: ReviewStage,
  ids: string[],
  actor: Actor,
): Promise<void> {
  if (!ids.length) return;
  await commitAs(
    deps,
    ctx,
    (tx) => {
      const r = structuredClone(tx.require<StageReview>(docPath.aiReview(stage), `${stage} review`));
      const at = new Date().toISOString();
      for (const rec of r.recommendations)
        if (ids.includes(rec.id)) Object.assign(rec, { status: 'applied', appliedAt: at, appliedBy: actor });
      r.updatedAt = at;
      tx.set(docPath.aiReview(stage), r);
    },
    `Apply ${ids.length} fix(es) of the ${stage} review`,
  );
}

function historyEntry(review: StageReview, applied: number) {
  return {
    round: Math.max(1, review.round),
    at: review.updatedAt,
    score: review.verdict?.score ?? 0,
    passed: review.verdict?.passed ?? false,
    issues: review.issues.length,
    applied,
  };
}

/**
 * Runs a review job: the document says `running` while it works and `failed` with the error when it cannot finish
 * (a review left `running` would hold its gate forever).
 */
async function asReview<T>(
  deps: HandlerDeps,
  ctx: JobContext,
  stage: ReviewStage,
  work: () => Promise<T>,
): Promise<T> {
  await writeReview(
    deps,
    ctx,
    stage,
    { status: 'running', jobId: ctx.job.id, error: undefined },
    `Review the ${stage}`,
  );
  try {
    return await work();
  } catch (err) {
    deps.metrics.aiReviews.inc({ stage, outcome: 'error' });
    await writeReview(
      deps,
      ctx,
      stage,
      {
        status: 'failed',
        error: ctx.signal.aborted
          ? 'cancelled'
          : (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      },
      `The ${stage} review stopped`,
    ).catch(() => undefined);
    throw err;
  }
}

/** A round's review with the fixes this run's earlier rounds applied (a new run starts its list afresh). */
function withCarried<T extends { recommendations: StageRecommendation[] }>(
  parts: T,
  previous: StageReview | undefined,
  round: number,
): T {
  return round > 1
    ? { ...parts, recommendations: [...parts.recommendations, ...carriedFixes(previous)] }
    : parts;
}

/** Approves the stage's gate when the project is on autopilot and the gate's requirements hold. */
async function approveOnAutopilot(deps: HandlerDeps, ctx: JobContext, stage: ReviewStage): Promise<boolean> {
  const docs = await docsFor(deps, ctx);
  if (!docs.project.settings.autopilot) return false;
  const projectId = ctx.job.projectId;
  try {
    if (stage === 'storyboard') await deps.services.storyboard.approveAll(ctx.actor, projectId);
    await deps.services.workflow.approve(
      ctx.actor,
      projectId,
      stage === 'screenplay' ? 'screenplay_approved' : 'storyboard_approved',
    );
    return true;
  } catch (err) {
    ctx.log.info(
      { stage, err: (err as Error).message.slice(0, 300) },
      'the gate stays open after the review',
    );
    return false;
  }
}

/** Rewrites the screenplay where the instructions say (one `screenplay.revise` call); returns the scenes changed. */
export async function reviseScreenplayWith(
  deps: HandlerDeps,
  ctx: JobContext,
  instructions: { sceneId?: string; outline?: boolean; instruction: string }[],
): Promise<number> {
  const docs = await docsFor(deps, ctx);
  if (!docs.screenplay) throw invalid('no screenplay to revise');
  const ordered = [...docs.screenplay.scenes].sort(byIndex);
  const numberOf = (id: string) => ordered.findIndex((s) => s.id === id) + 1;
  const asked = instructions
    .map((i) =>
      i.sceneId
        ? { scene: numberOf(i.sceneId), instruction: i.instruction }
        : { outline: true, instruction: i.instruction },
    )
    .filter((i) => !('scene' in i) || (i.scene ?? 0) > 0);
  if (!asked.length) return 0;
  const { limits } = await deps.gateway.limitsFor('video', docs.project.settings.models.video);
  const { video: _video, ...base } = screenplayReviewInput(docs, videoFacts(limits));
  const out = await deps.llm.reviseScreenplay({ ...base, instructions: asked }, ctx.signal);
  // Only the scenes asked for change; the outline only when an instruction is about it
  const wanted = new Set(asked.flatMap((i) => ('scene' in i && i.scene ? [i.scene] : [])));
  const scenes = out.scenes.filter((s) => wanted.has(s.number));
  const outline = asked.some((i) => 'outline' in i) ? out.outline : [];
  const { result } = await commitAs(
    deps,
    ctx,
    (tx) => {
      const current = tx.require<Screenplay>('screenplay.json', 'screenplay');
      const existing = tx.list<Element>('elements/');
      const { screenplay, changed, elements } = reviseScenes(
        current,
        scenes,
        outline,
        tx.list<Character>('characters/'),
        {
          existing,
          introduced: { locations: out.locations, props: out.props },
        },
      );
      tx.set('screenplay.json', screenplay);
      for (const e of elements)
        if (
          !existing.some((x) => x.id === e.id) ||
          e.description !== existing.find((x) => x.id === e.id)?.description
        )
          tx.set(docPath.element(e.id), e);
      return changed.length;
    },
    (n) => `Revise ${n} scene(s) after the screenplay review`,
  );
  return result;
}

function instructionOf(
  a: StageAction | null,
): { sceneId?: string; outline?: boolean; instruction: string } | null {
  if (a?.kind === 'revise_scene') return { sceneId: a.sceneId, instruction: a.instruction };
  if (a?.kind === 'revise_outline') return { outline: true, instruction: a.instruction };
  return null;
}

/**
 * `screenplay.review` (docs/design/ai-review.md#how-a-review-runs): the screenplay reviewed by the text model, its
 * fixes applied by one revision call per round, up to `settings.review.maxRounds`; a pass approves the gate on
 * autopilot.
 */
export async function screenplayReview(deps: HandlerDeps, ctx: JobContext) {
  const first = await docsFor(deps, ctx);
  if (!first.screenplay?.scenes.length) throw invalid('write or import the screenplay first');
  return asReview(deps, ctx, 'screenplay', () => reviewScreenplayRounds(deps, ctx));
}

async function reviewScreenplayRounds(deps: HandlerDeps, ctx: JobContext) {
  let docs = await docsFor(deps, ctx);
  const settings = reviewSettings(docs);
  const { limits } = await deps.gateway.limitsFor('video', docs.project.settings.models.video);
  const video = videoFacts(limits);
  const previous = docs.aiReviews.screenplay;
  let history = previous?.verdict
    ? [...previous.history, historyEntry(previous, 0)].slice(-20)
    : (previous?.history ?? []);
  for (let round = 1; ; round++) {
    throwIfAborted(ctx.signal);
    ctx.progress(round - 1, settings.maxRounds + 1, `reviewing the screenplay (round ${round})`);
    docs = await docsFor(deps, ctx);
    const subject = screenplayReviewSubject(docs);
    const out = await deps.llm.reviewScreenplay(screenplayReviewInput(docs, video), ctx.signal);
    const ordered = [...docs.screenplay!.scenes].sort(byIndex);
    const targets: ReviewTargets = { scenes: new Map(ordered.map((s, i) => [i + 1, s.id])) };
    const review = await writeReview(
      deps,
      ctx,
      'screenplay',
      {
        status: 'succeeded',
        jobId: ctx.job.id,
        model: deps.llm.text.model,
        subject,
        round,
        threshold: settings.threshold,
        history,
        error: undefined,
        ...withCarried(
          assembleStageReview('screenplay', out, targets, settings.threshold, round),
          docs.aiReviews.screenplay,
          round,
        ),
      },
      `Review the screenplay (round ${round})`,
    );
    deps.metrics.aiReviewScore.observe({ stage: 'screenplay' }, review.verdict!.score);
    ctx.log.info(
      { stage: 'screenplay', round, score: review.verdict!.score, passed: review.verdict!.passed },
      'reviewed',
    );
    if (review.verdict!.passed) return finish(deps, ctx, 'screenplay', review, round);
    const todo = settings.autoRevise && round - 1 < settings.maxRounds ? autoApplicable(review) : [];
    const instructions = todo.map((r) => instructionOf(r.action)).filter((i) => !!i);
    if (!instructions.length) return finish(deps, ctx, 'screenplay', review, round);
    ctx.progress(
      round - 0.5,
      settings.maxRounds + 1,
      `revising ${instructions.length} part(s) of the screenplay`,
    );
    await reviseScreenplayWith(deps, ctx, instructions);
    await markApplied(
      deps,
      ctx,
      'screenplay',
      todo.map((r) => r.id),
      ctx.actor,
    );
    for (const r of todo)
      deps.metrics.aiReviewRecommendations.inc({
        stage: 'screenplay',
        action: r.action!.kind,
        outcome: 'auto',
      });
    history = [...history, historyEntry(review, todo.length)].slice(-20);
  }
}

/** `screenplay.revise`: a person's fixes from the screenplay review (or any instructions), in one call. */
export async function screenplayRevise(deps: HandlerDeps, ctx: JobContext) {
  const { instructions } = ctx.job.params as {
    instructions: { sceneId?: string; outline?: boolean; instruction: string }[];
  };
  const changed = await reviseScreenplayWith(deps, ctx, instructions ?? []);
  return { changed };
}

async function finish(
  deps: HandlerDeps,
  ctx: JobContext,
  stage: ReviewStage,
  review: StageReview,
  round: number,
) {
  const passed = review.verdict!.passed;
  deps.metrics.aiReviews.inc({ stage, outcome: passed ? 'passed' : 'failed' });
  deps.metrics.aiReviewRounds.observe({ stage }, round);
  const approved = passed ? await approveOnAutopilot(deps, ctx, stage) : false;
  return { passed, score: review.verdict!.score, threshold: review.threshold, round, approved };
}

/** Draws the frames of these clips that are missing, failed, stale or outdated, and waits for them. */
async function drawFrames(deps: HandlerDeps, ctx: JobContext, clipIds: string[]): Promise<void> {
  const docs = await docsFor(deps, ctx);
  const jobs = [];
  for (const id of clipIds) {
    const clip = docs.clips[id];
    for (const shot of clip?.shots ?? []) {
      const state = boardState(shot, docs);
      if (state === 'approved' || state === 'unapproved') continue;
      jobs.push(
        await ctx.spawn('shot.board', { clipId: id, shotId: shot.id }, { dedupeKey: `board:${shot.id}` }),
      );
    }
  }
  if (jobs.length) await ctx.waitFor(jobs.map((j) => j.id));
}

/** Applies a storyboard round's fixes: shots revised and redrawn, scenes planned again and drawn. */
export async function applyStoryboardFixes(
  deps: HandlerDeps,
  ctx: JobContext,
  actions: StageAction[],
): Promise<void> {
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const redraw = new Set<string>();
  const replans = [];
  for (const a of actions) {
    throwIfAborted(ctx.signal);
    if (a.kind === 'redraw_board') {
      const clip = docs.clips[a.clipId];
      if (!clip?.shots.some((s) => s.id === a.shotId)) continue;
      const cast = a.characters?.length ? castIdsOf(a.characters, docs.characters) : [];
      const camera =
        a.framing || a.movement
          ? { ...(a.framing ? { framing: a.framing } : {}), ...(a.movement ? { movement: a.movement } : {}) }
          : undefined;
      await deps.services.clips.updateShot(ctx.actor, projectId, a.clipId, a.shotId, {
        ...(a.description ? { description: a.description } : {}),
        ...(a.action ? { action: a.action } : {}),
        ...(camera ? { camera } : {}),
        ...(cast.length ? { characterIds: cast } : {}),
        ...(a.durationSec ? { durationSec: a.durationSec } : {}),
      });
      redraw.add(a.clipId);
    } else if (a.kind === 'replan_scene') {
      const sceneId = docs.clips[a.clipId]?.sceneId;
      if (!sceneId) continue;
      replans.push({
        clipId: a.clipId,
        job: await ctx.spawn(
          'clip.plan',
          { sceneId, direction: a.direction },
          { dedupeKey: `plan:${sceneId}:review` },
        ),
      });
    }
  }
  if (replans.length) await ctx.waitFor(replans.map((r) => r.job.id));
  // A plan replaces the clip's shots; their frames are missing now, like the redrawn ones' frames are outdated
  const fresh = await docsFor(deps, ctx);
  const replanned = replans
    .map((r) => Object.values(fresh.clips).find((c) => c.sceneId === docs.clips[r.clipId]?.sceneId)?.id)
    .filter((id): id is string => !!id);
  await drawFrames(deps, ctx, [...new Set([...redraw, ...replanned])]);
}

/**
 * `storyboard.review` (docs/design/ai-review.md#how-a-review-runs): each storyboarded scene reviewed by the vision
 * model with its frames, merged; fixes applied (frames redrawn, scenes planned again) and reviewed again up to
 * `settings.review.maxRounds`; a pass approves the frames and the gate on autopilot.
 */
export async function storyboardReview(deps: HandlerDeps, ctx: JobContext) {
  const first = await docsFor(deps, ctx);
  if (!storyboardClips(first).length) throw invalid('plan and draw the storyboard first');
  return asReview(deps, ctx, 'storyboard', () => reviewStoryboardRounds(deps, ctx));
}

async function reviewStoryboardRounds(deps: HandlerDeps, ctx: JobContext) {
  let docs = await docsFor(deps, ctx);
  const settings = reviewSettings(docs);
  const { limits } = await deps.gateway.limitsFor('video', docs.project.settings.models.video);
  const video = videoFacts(limits);
  const previous = docs.aiReviews.storyboard;
  let history = previous?.verdict
    ? [...previous.history, historyEntry(previous, 0)].slice(-20)
    : (previous?.history ?? []);
  for (let round = 1; ; round++) {
    throwIfAborted(ctx.signal);
    docs = await docsFor(deps, ctx);
    const clips = storyboardClips(docs);
    if (!clips.length) throw invalid('plan and draw the storyboard first');
    const ordered = [...(docs.screenplay?.scenes ?? [])].sort(byIndex);
    const numberOf = (sceneId: string) => ordered.findIndex((s) => s.id === sceneId) + 1;
    const subject = storyboardReviewSubject(docs);
    const parts: { number: number; durationSec: number; out: StageReviewOutput }[] = [];
    const targets: ReviewTargets = { scenes: new Map(), clips: new Map() };
    for (const [k, clip] of clips.entries()) {
      throwIfAborted(ctx.signal);
      ctx.progress(
        k,
        clips.length,
        `reviewing the storyboard of scene ${k + 1}/${clips.length} (round ${round})`,
      );
      const scene = ordered.find((s) => s.id === clip.sceneId)!;
      const number = numberOf(scene.id);
      const shots = [...clip.shots].sort(byIndex);
      targets.scenes.set(number, scene.id);
      targets.clips!.set(number, {
        clipId: clip.id,
        shots: shots.map((s) => ({ shotId: s.id, label: `C${clip.index + 1}·S${s.index + 1}` })),
      });
      const frames = [];
      for (const s of shots)
        if (s.board)
          frames.push({
            label: `C${clip.index + 1}·S${s.index + 1}`,
            data: await deps.media.pngBuffer(ctx.job.projectId, s.board.keyframe, 512),
          });
      const out = await deps.llm.reviewStoryboardScene(
        storyboardSceneInput(docs, clip, scene, number, video),
        frames,
        ctx.signal,
      );
      parts.push({ number, durationSec: shots.reduce((n, s) => n + s.durationSec, 0), out });
    }
    const review = await writeReview(
      deps,
      ctx,
      'storyboard',
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
          assembleStageReview('storyboard', mergeSceneReviews(parts), targets, settings.threshold, round),
          docs.aiReviews.storyboard,
          round,
        ),
      },
      `Review the storyboard (round ${round})`,
    );
    deps.metrics.aiReviewScore.observe({ stage: 'storyboard' }, review.verdict!.score);
    ctx.log.info(
      { stage: 'storyboard', round, score: review.verdict!.score, passed: review.verdict!.passed },
      'reviewed',
    );
    if (review.verdict!.passed) return finish(deps, ctx, 'storyboard', review, round);
    const todo = settings.autoRevise && round - 1 < settings.maxRounds ? autoApplicable(review) : [];
    if (!todo.length) return finish(deps, ctx, 'storyboard', review, round);
    ctx.progress(clips.length, clips.length, `redrawing after the review (${todo.length} fix(es))`);
    await markApplied(
      deps,
      ctx,
      'storyboard',
      todo.map((r) => r.id),
      ctx.actor,
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
}

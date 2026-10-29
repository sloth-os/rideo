import {
  absentCast,
  boardApprovable,
  boardNeedsGeneration,
  boardPromptHash,
  boardState,
  type Clip,
  docPath,
  type Job,
  type MediaRef,
  orderedShotCharacters,
  orderedShotElements,
  type ProjectDocs,
  promptVersionOf,
  type Shot,
  type ShotBoard,
  type ShotContext,
  shotContextOf,
  storyboardScenes,
  voicesNotReady,
} from '@rideo/shared';
import { assertCastReady } from '../../domain/clips';
import { notFound } from '../../errors';
import type { JobContext } from '../queue';
import { cameraView, ensureBlocking, withCameraView } from './blocking';
import { commitAs, docsFor, type HandlerDeps } from './common';
import { speakLines } from './dialogue';
import { generateKeyframe, prepareShotReferences } from './keyframe';

/**
 * The scene reference of a storyboard frame (docs/design/storyboard.md#jobs): the clip's first shot's frame when it is
 * drawn and did not fail, approved or not; none for the first shot itself.
 */
export function boardSceneReference(clip: Clip, shot: Shot, docs: ProjectDocs): MediaRef | null {
  const first = [...clip.shots].sort((a, b) => a.index - b.index)[0];
  if (!first || first.id === shot.id || !first.board) return null;
  return boardApprovable(boardState(first, docs)) ? first.board.keyframe : null;
}

/**
 * Draws these frames and waits for them: each clip's first shot first, then the others in parallel, so they take
 * the first frame as their scene reference (docs/design/storyboard.md#jobs).
 */
export async function drawBoards(
  ctx: JobContext,
  targets: { clip: Clip; shot: Shot }[],
): Promise<(Job | undefined)[]> {
  const isFirst = ({ clip, shot }: { clip: Clip; shot: Shot }) =>
    shot.index === Math.min(...clip.shots.map((s) => s.index));
  const spawn = async (list: { clip: Clip; shot: Shot }[]) => {
    const jobs: Job[] = [];
    for (const { clip, shot } of list)
      jobs.push(
        await ctx.spawn(
          'shot.board',
          { clipId: clip.id, shotId: shot.id },
          { dedupeKey: `board:${shot.id}` },
        ),
      );
    return jobs.length ? ctx.waitFor(jobs.map((j) => j.id)) : [];
  };
  const firsts = await spawn(targets.filter(isFirst));
  return [...firsts, ...(await spawn(targets.filter((t) => !isFirst(t))))];
}

/**
 * `shot.board` (docs/design/storyboard.md#jobs): the shot's keyframe with references, judge and retries (R4), and its
 * TTS dialogue when the speakers have locked voices; committed as the shot's unapproved storyboard frame.
 */
export async function shotBoard(deps: HandlerDeps, ctx: JobContext) {
  const { clipId, shotId } = ctx.job.params as { clipId: string; shotId: string };
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  const shot = clip.shots.find((s) => s.id === shotId);
  if (!shot) throw notFound(`shot ${shotId}`);
  if (shot.board?.jobId === ctx.job.id) return { status: shot.board.consistency.status, reused: true };
  assertCastReady([shot], docs.characters, docs.elements);
  const settings = docs.project.settings;
  const characters = orderedShotCharacters(shot, docs.characters);
  const elements = orderedShotElements(shot, docs.elements);
  const judgedElements = settings.consistency.judgeElements ? elements : [];
  const judge = settings.consistency.judge === 'off' ? deps.offJudge : deps.judge;
  const { threshold, maxAttempts } = settings.consistency;
  const name = `board-c${clip.index + 1}-s${shot.index + 1}`;
  const baseCtx: ShotContext = { ...shotContextOf(shot, docs, clip), characters, elements };
  return deps.media.withTmpDir(async (dir) => {
    ctx.progress(0.05, 1, 'preparing references');
    const imageLimits = await deps.gateway.limitsFor('image', settings.models.image);
    const shotRefs = await prepareShotReferences(deps, ctx, {
      shot,
      characters,
      elements,
      judgedElements,
      maxInputImages: imageLimits.limits?.max_input_images,
      dir,
    });
    // The scene's first frame as one more image, as for the video pass's keyframes (docs/design/storyboard.md#jobs)
    const sceneFrame = promptVersionOf(settings) >= 2 ? boardSceneReference(clip, shot, docs) : null;
    const maxImages = imageLimits.limits?.max_input_images;
    const withScene =
      sceneFrame &&
      (maxImages === undefined || (maxImages >= 3 && shotRefs.referenceUris.length < maxImages));
    // The shot's camera view on the desk, before the scene reference (docs/design/director-desk.md)
    const view = withCameraView(shotRefs, cameraView(docs, clip, shot), {
      maxImages,
      sceneReferenceUri: withScene ? await deps.media.pngDataUri(ctx.job.projectId, sceneFrame, 1024) : null,
    });
    const refs = view.refs;
    const shotCtx: ShotContext = {
      ...baseCtx,
      sceneReference: view.sceneReference,
      blockingImage: view.blockingImage,
    };
    const kf = await generateKeyframe(deps, ctx, {
      shotCtx,
      refs,
      judge,
      judgedElements,
      threshold,
      maxAttempts,
      // A frame is checked like a keyframe (docs/design/continuity.md#quality-checks-in-the-gate)
      ...(settings.consistency.qualityChecks
        ? {
            quality: {
              threshold: settings.consistency.qualityThreshold,
              absent: absentCast(shotCtx.offscreen, docs.characters),
              castOnly: settings.consistency.castOnly === true,
            },
          }
        : {}),
      name,
      step: 'board',
      progress: (attempt) =>
        ctx.progress(0.1 + (0.6 * attempt) / maxAttempts, 1, `frame attempt ${attempt + 1}/${maxAttempts}`),
    });
    // The animatic speaks the lines when every speaker has a locked voice (docs/design/dialogue.md).
    const spoken =
      voicesNotReady([shot], docs.characters, 'tts').length === 0
        ? await speakLines(deps, ctx, { shot, characters: docs.characters, settings, dir, name })
        : null;
    const report = kf.report!;
    const board: ShotBoard = {
      keyframe: kf.keyframe!,
      createdAt: new Date().toISOString(),
      jobId: ctx.job.id,
      request: {
        imageModel: kf.imageModel,
        prompt: kf.prompt,
        seed: kf.seed,
        // The cast's and elements' images, as for takes (the scene reference is one more)
        referenceCount: shotRefs.referenceUris.length,
      },
      promptHash: boardPromptHash(shotCtx),
      consistency: report,
      characterLocks: Object.fromEntries(characters.map((c) => [c.id, c.lock.version])),
      elementLocks: Object.fromEntries(elements.map((e) => [e.id, e.lock.version])),
      audio: spoken
        ? {
            mode: 'tts',
            dialogue: spoken.mix.ref,
            lines: spoken.lines,
            voiceLocks: spoken.voiceLocks,
            lipSync: 'none',
          }
        : null,
      gatewayTaskIds: kf.taskIds,
      approved: false,
      approvedAt: null,
      approvedBy: null,
    };
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const c = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
        const s = c.shots.find((x) => x.id === shotId);
        if (!s) throw notFound(`shot ${shotId}`);
        s.board = board;
        tx.set(docPath.clip(clipId), c);
      },
      `Storyboard frame c${clip.index + 1}-s${shot.index + 1} (${report.status}${report.characters.length ? ` ${report.score.toFixed(2)}` : ''})`,
    );
    deps.metrics.storyboardFrames.inc({ result: report.status });
    ctx.progress(1, 1, `frame ${report.status}`);
    return { status: report.status, score: report.score, dialogue: !!spoken };
  });
}

/**
 * `storyboard.generate`: plans the storyboarded scenes that have no clip, then draws every frame that is missing,
 * failed, stale or outdated, and waits for them.
 */
export async function storyboardGenerate(deps: HandlerDeps, ctx: JobContext) {
  const { sceneIds } = ctx.job.params as { sceneIds?: string[] };
  let docs = await docsFor(deps, ctx);
  const scenes = storyboardScenes(docs).filter((s) => !sceneIds?.length || sceneIds.includes(s.id));
  const planned = new Set(Object.values(docs.clips).map((c) => c.sceneId));
  const plans = [];
  for (const scene of scenes) {
    if (planned.has(scene.id)) continue;
    plans.push(await ctx.spawn('clip.plan', { sceneId: scene.id }, { dedupeKey: `plan:${scene.id}` }));
  }
  if (plans.length) {
    ctx.progress(0.1, 1, `planning ${plans.length} scene(s)`);
    await ctx.waitFor(plans.map((j) => j.id));
    docs = await docsFor(deps, ctx);
  }
  const ids = new Set(scenes.map((s) => s.id));
  // Each scene blocked in 3D before its frames are drawn (docs/design/director-desk.md#jobs)
  ctx.progress(0.15, 1, 'blocking the scenes');
  await ensureBlocking(
    deps,
    ctx,
    Object.values(docs.clips)
      .filter((c) => c.sceneId && ids.has(c.sceneId))
      .map((c) => c.id),
  );
  docs = await docsFor(deps, ctx);
  const targets = Object.values(docs.clips)
    .filter((c) => c.sceneId && ids.has(c.sceneId))
    .flatMap((clip) =>
      clip.shots
        .filter((shot) => boardNeedsGeneration(boardState(shot, docs)))
        .map((shot) => ({ clip, shot })),
    );
  ctx.progress(0.2, 1, `drawing ${targets.length} frame(s)`);
  const done = await drawBoards(ctx, targets);
  // The frames are reviewed before any video (docs/design/ai-review.md#how-a-review-runs)
  await deps.services.aiReviews
    .followUp(ctx.actor, ctx.job.projectId, 'storyboard')
    .catch((err) => ctx.log.warn({ err: (err as Error).message }, 'could not queue the storyboard review'));
  return {
    scenes: scenes.length,
    planned: plans.length,
    frames: targets.length,
    failed: done.filter((j) => j?.status !== 'succeeded').length,
  };
}

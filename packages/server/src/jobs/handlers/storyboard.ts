import {
  boardNeedsGeneration,
  boardPromptHash,
  boardState,
  type Clip,
  docPath,
  orderedShotCharacters,
  orderedShotElements,
  type ShotBoard,
  type ShotContext,
  storyboardScenes,
  voicesNotReady,
} from '@rideo/shared';
import { assertCastReady } from '../../domain/clips';
import { notFound } from '../../errors';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps } from './common';
import { speakLines } from './dialogue';
import { generateKeyframe, prepareShotReferences } from './keyframe';

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
  const shotCtx: ShotContext = { shot, characters, elements, screenplay: docs.screenplay, settings };
  return deps.media.withTmpDir(async (dir) => {
    ctx.progress(0.05, 1, 'preparing references');
    const imageLimits = await deps.gateway.limitsFor('image', settings.models.image);
    const refs = await prepareShotReferences(deps, ctx, {
      shot,
      characters,
      elements,
      judgedElements,
      maxInputImages: imageLimits.limits?.max_input_images,
      dir,
    });
    const kf = await generateKeyframe(deps, ctx, {
      shotCtx,
      refs,
      judge,
      judgedElements,
      threshold,
      maxAttempts,
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
        referenceCount: refs.referenceUris.length,
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
  const jobs = [];
  for (const clip of Object.values(docs.clips).filter((c) => c.sceneId && ids.has(c.sceneId))) {
    for (const shot of clip.shots) {
      if (!boardNeedsGeneration(boardState(shot, docs))) continue;
      jobs.push(
        await ctx.spawn(
          'shot.board',
          { clipId: clip.id, shotId: shot.id },
          { dedupeKey: `board:${shot.id}` },
        ),
      );
    }
  }
  ctx.progress(0.2, 1, `drawing ${jobs.length} frame(s)`);
  const done = jobs.length ? await ctx.waitFor(jobs.map((j) => j.id)) : [];
  return {
    scenes: scenes.length,
    planned: plans.length,
    frames: jobs.length,
    failed: done.filter((j) => j?.status !== 'succeeded').length,
  };
}

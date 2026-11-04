import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  approvedElementReferences,
  attemptDone,
  betterAttempt,
  type Character,
  type CharacterReference,
  type ConsistencyReport,
  compactIdentity,
  compileFrameEditRequest,
  compileKeyframeRequest,
  type Element,
  type FrameReconcileInput,
  type FrameReconcileOutput,
  HEAD_CROP_SHARE,
  type MediaRef,
  promptVersionOf,
  referenceLabels,
  type Shot,
  type ShotContext,
  selectReferences,
} from '@rideo/shared';
import { verifyFrames } from '../../consistency/gate';
import type { ConsistencyJudge } from '../../consistency/judge';
import { topCrop } from '../../media/frames';
import { makeCastSheet } from '../../media/sheet';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { gatewayOptions, type HandlerDeps } from './common';

/** The image inputs of a shot and the judge's references (rules R3, E3, E4). */
export interface ShotReferences {
  referenceUris: string[];
  /** What each of `referenceUris` shows, for the keyframe prompt. */
  referenceLabels: string[];
  judgeRefs: Map<string, Buffer[]>;
  elementJudgeRefs: Map<string, Buffer[]>;
}

/**
 * R3/E3: deterministic references bounded by the model, a cast sheet when the cast exceeds the budget and an
 * element sheet when the elements outnumber their slots; the judge sees every judged element (E4).
 */
export async function prepareShotReferences(
  deps: HandlerDeps,
  ctx: JobContext,
  input: {
    shot: Shot;
    characters: Character[];
    elements: Element[];
    judgedElements: Element[];
    maxInputImages: number | undefined;
    dir: string;
    /**
     * A close framing of prompt version 3 (`headCropped`): whole-figure references go as their head and shoulders
     * (docs/design/first-pass.md#framings-spelled-out); the judge keeps the whole figures.
     */
    headCrop?: boolean;
  },
): Promise<ShotReferences> {
  const projectId = ctx.job.projectId;
  const { shot, characters, elements, dir } = input;
  const selection = selectReferences(characters, shot, input.maxInputImages, 2, elements);
  const judgeRefs = new Map<string, Buffer[]>();
  const refPngs: Buffer[] = [];
  const refPng = async (r: CharacterReference) => {
    const png = await deps.media.pngBuffer(projectId, r.media, 1024);
    if (!input.headCrop || r.view !== 'full_body') return png;
    const whole = join(dir, `head-${r.id}-whole.png`);
    await writeFile(whole, png);
    return readFile(
      await topCrop(deps.ff, whole, join(dir, `head-${r.id}.png`), HEAD_CROP_SHARE, ctx.signal),
    );
  };
  for (const pc of selection.perCharacter) {
    for (const r of pc.refs) refPngs.push(await refPng(r));
    judgeRefs.set(
      pc.characterId,
      await Promise.all(pc.refs.slice(0, 2).map((r) => deps.media.pngBuffer(projectId, r.media, 512))),
    );
  }
  const sheet = async (pngs: Buffer[], prefix: string) => {
    const parts = await Promise.all(
      pngs.map(async (b, i) => {
        const p = join(dir, `${prefix}-${i}.png`);
        await writeFile(p, b);
        return p;
      }),
    );
    const out = await makeCastSheet(deps.ff, parts, join(dir, `${prefix}.png`), 512, ctx.signal);
    return `data:image/png;base64,${(await readFile(out)).toString('base64')}`;
  };
  let referenceUris = refPngs.map((b) => `data:image/png;base64,${b.toString('base64')}`);
  if (selection.needsSheet && refPngs.length > 1) referenceUris = [await sheet(refPngs, 'cast-sheet')];
  // Element references follow the cast (location first); an element sheet when they outnumber their slots.
  const elementPngs: Buffer[] = [];
  for (const pe of selection.perElement)
    for (const r of pe.refs) elementPngs.push(await deps.media.pngBuffer(projectId, r.media, 1024));
  if (selection.elementSheet && elementPngs.length > 1)
    referenceUris.push(await sheet(elementPngs, 'element-sheet'));
  else for (const b of elementPngs) referenceUris.push(`data:image/png;base64,${b.toString('base64')}`);
  const elementJudgeRefs = new Map<string, Buffer[]>();
  for (const e of input.judgedElements) {
    const ref = approvedElementReferences(e)[0];
    if (ref) elementJudgeRefs.set(e.id, [await deps.media.pngBuffer(projectId, ref.media, 512)]);
  }
  return {
    referenceUris,
    referenceLabels: referenceLabels(selection, characters, elements, { headCrop: input.headCrop }),
    judgeRefs,
    elementJudgeRefs,
  };
}

export interface KeyframeResult {
  /** The chosen frame read against its shot, when the staging check ran. */
  seen?: FrameReading;
  keyframe: MediaRef | null;
  report: ConsistencyReport | null;
  imageModel?: string;
  taskIds: string[];
  /** The request of the last attempt. */
  prompt: string;
  seed: number;
}

/**
 * The keyframe step (R4): image task → judge → retry up to `maxAttempts`. With quality checks the judge also scores
 * physics and the cast in frame, and a failure draws again (docs/design/continuity.md#quality-checks-in-the-gate).
 * The best attempt is returned: identity first, then quality, then the score.
 */
export async function generateKeyframe(
  deps: HandlerDeps,
  ctx: JobContext,
  input: {
    shotCtx: ShotContext;
    refs: ShotReferences;
    judge: ConsistencyJudge;
    judgedElements: Element[];
    threshold: number;
    maxAttempts: number;
    name: string;
    /** Gateway idempotency step (`keyframe` in the shot pipeline, `board` for storyboard frames). */
    step: string;
    /** Variations offset the seed (docs/design/directing.md#variations-and-comparison). */
    variation?: number;
    /** Quality checks: physics and who must not be in the frame. */
    quality?: { threshold: number; absent?: { name: string; look: string }[]; castOnly?: boolean };
    /**
     * The staging check (docs/design/first-pass.md#frames-that-follow-their-shot): a frame that passes is read against
     * its shot (`frame.reconcile`), and drawn again while it contradicts what the shot needs.
     */
    staging?: { shot: FrameReconcileInput['shot']; source: 'storyboard' | 'keyframe'; opening?: MediaRef };
    /**
     * A frame already drawn, its first attempt: a panel of the scene's sheet
     * (docs/design/storyboard.md#scene-sheets), checked like any frame and drawn again alone only if it fails.
     */
    given?: {
      keyframe: MediaRef;
      prompt: string;
      seed: number;
      imageModel?: string;
      taskId?: string;
      /** Its reading against the shot, already made: a frame that passes the gate is kept as it is. */
      seen?: FrameReading | null;
    };
    progress: (attempt: number) => void;
  },
): Promise<KeyframeResult> {
  const { shotCtx, refs } = input;
  const projectId = ctx.job.projectId;
  const out: KeyframeResult = { keyframe: null, report: null, taskIds: [], prompt: '', seed: 0 };
  let best: Pick<KeyframeResult, 'keyframe' | 'report' | 'prompt' | 'seed'> | null = null;
  // A passing frame read against its shot: the first that needs no redraw wins, else the one with the fewest conflicts
  let staged:
    | (Pick<KeyframeResult, 'keyframe' | 'report' | 'prompt' | 'seed'> & { seen: FrameReading })
    | null = null;
  // What the last reading found wrong, for the next attempt to show instead
  let correction: string | null = null;
  // The frame that reading read, which the next attempt edits (consistency.frameEdits); an edit that fails is followed by a drawing
  let toEdit: { frame: MediaRef; fix: string } | null = null;
  for (let attempt = 0; attempt < input.maxAttempts; attempt++) {
    throwIfAborted(ctx.signal);
    input.progress(attempt);
    if (attempt === 0 && input.given) {
      out.prompt = input.given.prompt;
      out.seed = input.given.seed;
      out.imageModel = input.given.imageModel ?? out.imageModel;
      if (input.given.taskId) out.taskIds.push(input.given.taskId);
      out.keyframe = input.given.keyframe;
    } else {
      const editing = toEdit;
      toEdit = null;
      const referenceLabels = refs.referenceLabels.slice(0, refs.referenceUris.length);
      const req = editing
        ? compileFrameEditRequest(shotCtx, {
            frameUri: await deps.media.dataUri(projectId, editing.frame),
            fix: editing.fix,
            referenceUris: refs.referenceUris,
            referenceLabels,
            attempt,
            model: shotCtx.settings.models.image,
            variation: input.variation,
          })
        : compileKeyframeRequest(
            { ...shotCtx, referenceLabels, correction },
            {
              referenceUris: refs.referenceUris,
              attempt,
              model: shotCtx.settings.models.image,
              variation: input.variation,
            },
          );
      if (editing && input.staging) deps.metrics.frameEdits.inc({ source: input.staging.source });
      out.prompt = (req.input[0] as { text: string }).text;
      out.seed = req.parameters?.seed ?? 0;
      const task = await deps.gateway.generateImage(req, gatewayOptions(ctx, 'image', input.step, attempt));
      out.taskIds.push(task.id);
      out.imageModel = task.model || out.imageModel;
      out.keyframe = await deps.media.importUri(projectId, task.outputs![0]!.uri, {
        kind: 'keyframes',
        name: `${input.name}-a${attempt + 1}`,
        signal: ctx.signal,
      });
    }
    const png = await deps.media.pngBuffer(projectId, out.keyframe, 512);
    out.report = await verifyFrames({
      judge: input.judge,
      shot: shotCtx.shot,
      characters: shotCtx.characters,
      references: refs.judgeRefs,
      elements: input.judgedElements,
      elementReferences: refs.elementJudgeRefs,
      frames: [png],
      frameRefs: [out.keyframe],
      threshold: input.threshold,
      attempts: attempt + 1,
      metrics: deps.metrics,
      log: ctx.log,
      signal: ctx.signal,
      ...(input.quality
        ? {
            quality: {
              threshold: input.quality.threshold,
              temporal: null,
              absent: input.quality.absent,
              castOnly: input.quality.castOnly,
            },
          }
        : {}),
    });
    if (!best?.report || betterAttempt(out.report, best.report))
      best = { keyframe: out.keyframe, report: out.report, prompt: out.prompt, seed: out.seed };
    // A panel already read against its shot, from the best of its scene's sheets (docs/design/storyboard.md#scene-sheets)
    const read =
      attempt === 0 && input.given?.seen?.keyframeHash === out.keyframe.hash ? input.given.seen : null;
    if (read && attemptDone(out.report)) {
      staged = { keyframe: out.keyframe, report: out.report, prompt: out.prompt, seed: out.seed, seen: read };
      break;
    }
    if (attemptDone(out.report) && input.staging) {
      const seen = await readFrame(deps, ctx, input.staging, out.keyframe);
      if (!seen) break;
      if (
        !staged ||
        (!seen.redraw && staged.seen.redraw) ||
        seen.conflicts.length < staged.seen.conflicts.length
      )
        staged = { keyframe: out.keyframe, report: out.report, prompt: out.prompt, seed: out.seed, seen };
      if (!seen.redraw) break;
      correction = seen.fix.trim() || seen.conflicts.join('; ') || null;
      if (shotCtx.settings.consistency.frameEdits && seen.fix.trim())
        toEdit = { frame: out.keyframe, fix: seen.fix.trim() };
      ctx.log.info(
        { projectId, attempt, conflicts: seen.conflicts },
        'the frame contradicts its shot; drawing it again',
      );
      continue;
    }
    if (attemptDone(out.report)) break;
    if (out.report.status === 'failed')
      ctx.log.info({ attempt, score: out.report.score }, 'keyframe failed the consistency gate');
    else
      ctx.log.info(
        { attempt, physics: out.report.quality?.physics, extras: out.report.quality?.extras },
        'keyframe failed the quality checks',
      );
  }
  if (staged) return { ...out, ...staged };
  return best ? { ...out, ...best } : out;
}

/** The shot as `frame.reconcile` reads it beside its frame. */
export function reconcileShot(shot: Shot, characters: Character[]): FrameReconcileInput['shot'] {
  return {
    description: shot.description,
    action: shot.action,
    endState: shot.endState ?? '',
    framing: shot.camera.framing,
    movement: shot.camera.movement,
    durationSec: shot.durationSec,
    cast: characters.map((c) => ({ name: c.name, look: compactIdentity(c, shot) })),
  };
}

/**
 * The staging check of prompt version 3 (docs/design/first-pass.md#frames-that-follow-their-shot), unless a person
 * wrote the shot's prompt.
 */
export function stagingFor(
  shotCtx: ShotContext,
  source: 'storyboard' | 'keyframe',
  /** The scene's opening frame, which this frame must agree with (docs/design/first-pass.md#frames-that-agree-with-each-other). */
  opening?: MediaRef | null,
): { shot: FrameReconcileInput['shot']; source: 'storyboard' | 'keyframe'; opening?: MediaRef } | undefined {
  if (promptVersionOf(shotCtx.settings) < 3 || shotCtx.shot.promptOverride?.trim()) return undefined;
  return { shot: reconcileShot(shotCtx.shot, shotCtx.characters), source, ...(opening ? { opening } : {}) };
}

/** What a frame shows against its shot (`frame.reconcile`): null when the model cannot say. */
export type FrameReading = FrameReconcileOutput & { keyframeHash: string; model: string };

export async function readFrame(
  deps: HandlerDeps,
  ctx: JobContext,
  staging: NonNullable<Parameters<typeof generateKeyframe>[2]['staging']>,
  keyframe: MediaRef,
): Promise<FrameReading | null> {
  try {
    const opening =
      staging.opening && staging.opening.hash !== keyframe.hash
        ? await deps.media.pngBuffer(ctx.job.projectId, staging.opening, 768)
        : undefined;
    const out = await deps.llm.reconcileFrame(
      { shot: staging.shot, ...(opening ? { opening: true } : {}) },
      await deps.media.pngBuffer(ctx.job.projectId, keyframe, 1024),
      ctx.signal,
      opening,
    );
    deps.metrics.frameReconciles.inc({
      source: staging.source,
      outcome: out.redraw ? 'redraw' : out.conflicts.length ? 'adjusted' : 'agreed',
    });
    return { ...out, keyframeHash: keyframe.hash, model: deps.llm.vision.model };
  } catch (err) {
    throwIfAborted(ctx.signal);
    deps.metrics.frameReconciles.inc({ source: staging.source, outcome: 'error' });
    ctx.log.warn({ err: (err as Error).message }, 'could not read the frame against its shot');
    return null;
  }
}

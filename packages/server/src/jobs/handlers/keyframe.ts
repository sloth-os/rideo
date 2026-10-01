import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  approvedElementReferences,
  type Character,
  type ConsistencyReport,
  compileKeyframeRequest,
  type Element,
  type MediaRef,
  type Shot,
  type ShotContext,
  selectReferences,
} from '@rideo/shared';
import { verifyFrames } from '../../consistency/gate';
import type { ConsistencyJudge } from '../../consistency/judge';
import { makeCastSheet } from '../../media/sheet';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { gatewayOptions, type HandlerDeps } from './common';

/** The image inputs of a shot and the judge's references (rules R3, E3, E4). */
export interface ShotReferences {
  referenceUris: string[];
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
  },
): Promise<ShotReferences> {
  const projectId = ctx.job.projectId;
  const { shot, characters, elements, dir } = input;
  const selection = selectReferences(characters, shot, input.maxInputImages, 2, elements);
  const judgeRefs = new Map<string, Buffer[]>();
  const refPngs: Buffer[] = [];
  for (const pc of selection.perCharacter) {
    for (const r of pc.refs) refPngs.push(await deps.media.pngBuffer(projectId, r.media, 1024));
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
  return { referenceUris, judgeRefs, elementJudgeRefs };
}

export interface KeyframeResult {
  keyframe: MediaRef | null;
  report: ConsistencyReport | null;
  imageModel?: string;
  taskIds: string[];
  /** The request of the last attempt. */
  prompt: string;
  seed: number;
}

/** The keyframe step (R4): image task → judge → retry up to `maxAttempts`; the last verdict is returned. */
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
    progress: (attempt: number) => void;
  },
): Promise<KeyframeResult> {
  const { shotCtx, refs } = input;
  const projectId = ctx.job.projectId;
  const out: KeyframeResult = { keyframe: null, report: null, taskIds: [], prompt: '', seed: 0 };
  for (let attempt = 0; attempt < input.maxAttempts; attempt++) {
    throwIfAborted(ctx.signal);
    input.progress(attempt);
    const req = compileKeyframeRequest(shotCtx, {
      referenceUris: refs.referenceUris,
      attempt,
      model: shotCtx.settings.models.image,
    });
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
    });
    if (out.report.status !== 'failed') break;
    ctx.log.info({ attempt, score: out.report.score }, 'keyframe failed the consistency gate');
  }
  return out;
}

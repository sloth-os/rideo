import {
  type Clip,
  docPath,
  isStale,
  orderedShotCharacters,
  orderedShotElements,
  shotLabel,
  sortedClips,
} from '@rideo/shared';
import { verifyFrames } from '../../consistency/gate';
import { clipStatusOf } from '../../domain/clips';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps } from './common';
import { prepareShotReferences } from './keyframe';

/** Takes in a row that may stay unverified before the judge counts as still down. */
const STILL_DOWN = 3;

/**
 * `consistency.recheck` (docs/design/character-consistency.md#re-checking-unverified-takes): unverified takes judged
 * again from the evidence frames they keep, with the characters' current references; nothing is generated.
 */
export async function consistencyRecheck(deps: HandlerDeps, ctx: JobContext) {
  const { clipIds } = ctx.job.params as { clipIds?: string[] };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const settings = docs.project.settings;
  const judge = settings.consistency.judge === 'off' ? deps.offJudge : deps.judge;
  const targets = sortedClips(docs)
    .filter((c) => !clipIds?.length || clipIds.includes(c.id))
    .flatMap((clip) =>
      clip.shots.flatMap((shot) =>
        shot.takes
          .filter(
            (t) =>
              t.consistency.status === 'unverified' &&
              t.video &&
              !t.override &&
              t.consistency.frames.length > 0 &&
              !isStale(t, shot, docs.characters, docs.elements),
          )
          .map((take) => ({ clip, shot, take })),
      ),
    );
  let passed = 0;
  let failed = 0;
  let unverified = 0;
  let inARow = 0;
  for (const [k, { clip, shot, take }] of targets.entries()) {
    throwIfAborted(ctx.signal);
    const label = shotLabel(clip.index, shot.index);
    ctx.progress(k, targets.length, `re-checking ${label}`);
    const characters = orderedShotCharacters(shot, docs.characters);
    const elements = orderedShotElements(shot, docs.elements);
    const judgedElements = settings.consistency.judgeElements ? elements : [];
    const report = await deps.media.withTmpDir(async (dir) => {
      const refs = await prepareShotReferences(deps, ctx, {
        shot,
        characters,
        elements,
        judgedElements,
        maxInputImages: undefined,
        dir,
      });
      const frames = await Promise.all(
        take.consistency.frames.map((f) => deps.media.pngBuffer(projectId, f, 512)),
      );
      return verifyFrames({
        judge,
        shot,
        characters,
        references: refs.judgeRefs,
        elements: judgedElements,
        elementReferences: refs.elementJudgeRefs,
        frames,
        frameRefs: take.consistency.frames,
        threshold: settings.consistency.threshold,
        attempts: take.consistency.attempts,
        metrics: deps.metrics,
        log: ctx.log,
        signal: ctx.signal,
        ...(settings.consistency.qualityChecks
          ? {
              quality: {
                threshold: settings.consistency.qualityThreshold,
                temporal: take.consistency.quality?.temporal ?? null,
              },
            }
          : {}),
      });
    });
    if (report.status === 'unverified') {
      unverified++;
      if (++inARow >= STILL_DOWN) {
        ctx.log.warn({ checked: k + 1 }, 'the judge is still unavailable; re-check stopped');
        break;
      }
      continue;
    }
    inARow = 0;
    if (report.status === 'passed') passed++;
    else failed++;
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const c = structuredClone(tx.require<Clip>(docPath.clip(clip.id), `clip ${clip.id}`));
        const s = c.shots.find((x) => x.id === shot.id);
        const t = s?.takes.find((x) => x.id === take.id);
        if (!s || !t || t.consistency.status !== 'unverified') return;
        t.consistency = {
          ...report,
          voices: t.consistency.voices,
          quality: report.quality ?? t.consistency.quality,
          note: 're-checked',
        };
        if (s.selectedTakeId === t.id) s.status = report.status === 'passed' ? 'ready' : 'needs_review';
        c.status = clipStatusOf(c);
        tx.set(docPath.clip(clip.id), c);
      },
      `Re-check ${label}: ${report.status} ${report.score.toFixed(2)}`,
    );
  }
  ctx.progress(targets.length, targets.length, 'done');
  ctx.log.info({ checked: targets.length, passed, failed, unverified }, 'unverified takes re-checked');
  return { checked: targets.length, passed, failed, unverified };
}

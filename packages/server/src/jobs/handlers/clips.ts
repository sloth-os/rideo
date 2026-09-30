import {
  type Clip,
  DEFAULT_VIDEO_LIMITS,
  docPath,
  isAcceptable,
  type Job,
  newId,
  nextUnwrittenBeats,
  normalizePlannedShots,
  plannedDuration,
  type Screenplay,
  sortedClips,
  TARGET_REACHED_RATIO,
  takeState,
} from '@rideo/shared';
import { assertCastReady, clipStatusOf } from '../../domain/clips';
import { AppError, notFound } from '../../errors';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps } from './common';

export async function clipPlan(deps: HandlerDeps, ctx: JobContext) {
  const { sceneId, thenGenerate } = ctx.job.params as { sceneId: string; thenGenerate?: boolean };
  const docs = await docsFor(deps, ctx);
  const sp = docs.screenplay as Screenplay | null;
  const scene = sp?.scenes.find((s) => s.id === sceneId);
  if (!sp || !scene) throw notFound(`scene ${sceneId}`);
  const settings = docs.project.settings;
  const { limits } = await deps.gateway.limitsFor('video', settings.models.video);
  const minSec = limits?.min_duration_seconds ?? DEFAULT_VIDEO_LIMITS.min;
  const maxSec = limits?.max_duration_seconds ?? DEFAULT_VIDEO_LIMITS.max;
  // The first clip is the pilot: its length is the user's pilot setting (10 s – 3 min).
  const target = Math.min(
    180,
    Math.max(10, scene.index === 0 ? settings.pilotDurationSec : scene.estDurationSec),
  );
  const all = Object.values(docs.characters);
  const cast = scene.characterIds.length
    ? scene.characterIds.map((id) => docs.characters[id]).filter((c) => !!c)
    : all;
  ctx.progress(0.2, 1, `planning shots for “${scene.heading}”`);
  const out = await deps.llm.planClip(
    {
      scene: {
        heading: scene.heading,
        summary: scene.summary,
        action: scene.action,
        dialogue: scene.dialogue.map((d) => ({
          character: d.characterId ? (docs.characters[d.characterId]?.name ?? d.character) : d.character,
          line: d.line,
        })),
        estDurationSec: target,
      },
      characters: cast.map((c) => ({ name: c!.name, summary: c!.summary })),
      style: [sp.style.visual, sp.style.camera].filter(Boolean).join('; '),
      limits: { minDurationSec: minSec, maxDurationSec: maxSec },
      targetDurationSec: target,
    },
    ctx.signal,
  );
  const shots = normalizePlannedShots(out.shots, { characters: all, minSec, maxSec, targetSec: target });
  if (!shots.length) throw new AppError('llm_invalid_output', 'the shot plan was empty', [], true);
  const { result: clip } = await commitAs(
    deps,
    ctx,
    (tx) => {
      const existing = tx.list<Clip>('clips/').find((c) => c.sceneId === sceneId);
      const next: Clip = existing
        ? { ...existing, shots, status: 'planned', approvedAt: null, approvedBy: null }
        : {
            id: newId('clip'),
            index: scene.index,
            sceneId,
            title: scene.heading,
            status: 'planned',
            shots,
            approvedAt: null,
            approvedBy: null,
            notes: '',
          };
      tx.set(docPath.clip(next.id), next);
      return next;
    },
    (c) =>
      `Plan clip ${c.index + 1} “${c.title}” (${c.shots.length} shots, ${c.shots.reduce((s, x) => s + x.durationSec, 0).toFixed(0)}s)`,
  );
  if (thenGenerate) {
    const fresh = await docsFor(deps, ctx);
    assertCastReady(clip.shots, fresh.characters);
    await ctx.spawn('clip.generate', { clipId: clip.id }, { dedupeKey: `clip:${clip.id}` });
  }
  return { clipId: clip.id, shots: clip.shots.length };
}

/** Generates every shot without a take; continuous shots wait for their predecessor (R5), cuts run in parallel. */
export async function clipGenerate(deps: HandlerDeps, ctx: JobContext) {
  const { clipId } = ctx.job.params as { clipId: string };
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  assertCastReady(clip.shots, docs.characters);
  const todo = [...clip.shots]
    .sort((a, b) => a.index - b.index)
    .filter((s) => {
      const t = s.takes.find((x) => x.id === s.selectedTakeId);
      return !t?.video || !isAcceptable(takeState(t, s, docs.characters));
    });
  if (!todo.length) return { generated: 0, failed: 0 };
  await commitAs(
    deps,
    ctx,
    (tx) => {
      const c = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
      for (const s of c.shots)
        if (todo.some((t) => t.id === s.id) && s.status !== 'generating') s.status = 'queued';
      c.status = clipStatusOf(c);
      tx.set(docPath.clip(clipId), c);
    },
    `Queue ${todo.length} shot(s) of clip ${clip.index + 1}`,
  );
  const jobs: Job[] = [];
  let prev: Job | null = null;
  for (const shot of todo) {
    throwIfAborted(ctx.signal);
    if (shot.continuity === 'continuous' && prev) await ctx.waitFor([prev.id]);
    const j = await ctx.spawn('shot.generate', { clipId, shotId: shot.id }, { dedupeKey: `shot:${shot.id}` });
    jobs.push(j);
    prev = j;
    ctx.progress(jobs.length, todo.length * 2, `shot ${shot.index + 1} queued`);
  }
  const results = await ctx.waitFor(jobs.map((j) => j.id));
  const failed = results.filter((r) => r.status !== 'succeeded');
  await commitAs(
    deps,
    ctx,
    (tx) => {
      const c = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
      c.status = clipStatusOf(c);
      tx.set(docPath.clip(clipId), c);
    },
    `Clip ${clip.index + 1} generated (${results.length - failed.length}/${results.length} shots)`,
  );
  if (failed.length === results.length) {
    throw new AppError(
      'gateway_error',
      `every shot of clip ${clip.index + 1} failed: ${failed[0]?.error?.message ?? 'unknown error'}`,
    );
  }
  return { generated: results.length - failed.length, failed: failed.length };
}

/**
 * Generates the film up to the target length (docs/design/generation-pipeline.md#batch-generation): clips in
 * order with a lookahead of two, planning and extending the screenplay just in time, under a generation budget.
 */
export async function batchGenerate(deps: HandlerDeps, ctx: JobContext) {
  const maxGenerations = Number(ctx.job.params.maxGenerations ?? 2000);
  const inFlight: Job[] = [];
  const started = new Set<string>();
  let generations = 0;
  let stopReason = 'target reached';
  const planFailures = new Set<string>();
  for (let guard = 0; guard < 10_000; guard++) {
    throwIfAborted(ctx.signal);
    const docs = await docsFor(deps, ctx);
    const target = docs.project.settings.targetDurationSec;
    const planned = plannedDuration(docs);
    const clips = sortedClips(docs);
    ctx.progress(
      Math.min(planned, target),
      target,
      `${Math.round(planned)}s of ${Math.round(target)}s planned · ${started.size} clip(s) generating or done`,
    );
    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (['succeeded', 'failed', 'cancelled'].includes(deps.jobs.find(inFlight[i]!.id)?.status ?? ''))
        inFlight.splice(i, 1);
    }
    const next = clips.find(
      (c) =>
        !started.has(c.id) &&
        c.status !== 'approved' &&
        c.shots.length > 0 &&
        c.shots.some((s) => {
          const t = s.takes.find((x) => x.id === s.selectedTakeId);
          return !t?.video || !isAcceptable(takeState(t, s, docs.characters));
        }),
    );
    if (next && inFlight.length < 2) {
      const cost = next.shots.length * 2;
      if (generations + cost > maxGenerations) {
        stopReason = 'generation budget reached';
        break;
      }
      assertCastReady(next.shots, docs.characters);
      const job = await ctx.spawn('clip.generate', { clipId: next.id }, { dedupeKey: `clip:${next.id}` });
      started.add(next.id);
      inFlight.push(job);
      generations += cost;
      continue;
    }
    const sp = docs.screenplay;
    const underTarget = planned < target * TARGET_REACHED_RATIO && planned < target * 1.05;
    const unplanned = sp?.scenes
      .slice()
      .sort((a, b) => a.index - b.index)
      .find((s) => !clips.some((c) => c.sceneId === s.id) && !planFailures.has(s.id));
    if (unplanned && underTarget) {
      const job = await ctx.spawn(
        'clip.plan',
        { sceneId: unplanned.id },
        { dedupeKey: `plan:${unplanned.id}` },
      );
      const [done] = await ctx.waitFor([job.id]);
      if (done?.status !== 'succeeded') planFailures.add(unplanned.id);
      continue;
    }
    if (sp && underTarget && nextUnwrittenBeats(sp, 1).length) {
      const job = await ctx.spawn('screenplay.extend', { beats: 3 }, { dedupeKey: 'screenplay.extend' });
      const [done] = await ctx.waitFor([job.id]);
      if (done?.status !== 'succeeded') {
        stopReason = `screenplay extension failed: ${done?.error?.message ?? 'unknown'}`;
        break;
      }
      continue;
    }
    if (inFlight.length) {
      await ctx.waitFor([inFlight[0]!.id]);
      continue;
    }
    if (next) continue;
    stopReason = underTarget ? 'the outline is complete' : 'target reached';
    break;
  }
  if (inFlight.length) await ctx.waitFor(inFlight.map((j) => j.id));
  const docs = await docsFor(deps, ctx);
  return {
    clips: started.size,
    plannedDurationSec: plannedDuration(docs),
    stopReason,
    generationsBudgeted: generations,
  };
}

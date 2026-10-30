import {
  approvedElementReferences,
  boardState,
  type Clip,
  clipBoardReviewState,
  clipFramesApproved,
  dialogueDirection,
  dialogueMode,
  docPath,
  framedGroupJoins,
  isAcceptable,
  type Job,
  needsOwnRequest,
  newId,
  nextUnwrittenBeats,
  normalizePlannedShots,
  plannedDuration,
  planShotGroups,
  promptVersionOf,
  reviewEnabled,
  reviewState,
  type Screenplay,
  shotRangeFor,
  shotsWithoutTakes,
  sortedClips,
  TARGET_REACHED_RATIO,
  takeState,
  voiceOf,
  voicesNotReady,
  wordsCapacity,
} from '@rideo/shared';
import { assertCastReady, assertVoicesReady, clipStatusOf } from '../../domain/clips';
import { AppError, notFound } from '../../errors';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { ensureBlocking } from './blocking';
import { commitAs, docsFor, type HandlerDeps } from './common';
import { approveClipOnAutopilot, approveProductionOnAutopilot } from './reviews';

export async function clipPlan(deps: HandlerDeps, ctx: JobContext) {
  const { sceneId, thenGenerate, thenBoard, direction } = ctx.job.params as {
    sceneId: string;
    thenGenerate?: boolean;
    thenBoard?: boolean;
    direction?: string;
  };
  const docs = await docsFor(deps, ctx);
  const sp = docs.screenplay as Screenplay | null;
  const scene = sp?.scenes.find((s) => s.id === sceneId);
  if (!sp || !scene) throw notFound(`scene ${sceneId}`);
  const settings = docs.project.settings;
  const { limits } = await deps.gateway.limitsFor('video', settings.models.video);
  // The model's range, capped: a long take drifts and cuts itself (docs/design/continuity.md#shot-planning); at most
  // 5 s a shot when the model renders sequences from a first frame (docs/design/multi-shot.md#planning-for-sequences)
  const { min: minSec, max: maxSec, sequences } = shotRangeFor(settings, limits);
  // The first clip is the pilot: its length is the user's pilot setting (10 s – 3 min).
  const target = Math.min(
    180,
    Math.max(10, scene.index === 0 ? settings.pilotDurationSec : scene.estDurationSec),
  );
  const all = Object.values(docs.characters);
  const cast = scene.characterIds.length
    ? scene.characterIds.map((id) => docs.characters[id]).filter((c) => !!c)
    : all;
  // The scene's location goes on every shot; the planner picks the props each shot shows (docs/design/elements.md).
  const location = scene.locationId ? docs.elements[scene.locationId] : undefined;
  const sceneElements = scene.elementIds.map((id) => docs.elements[id]).filter((e) => !!e);
  ctx.progress(0.2, 1, `planning shots for “${scene.heading}”`);
  // Version 2 (docs/design/continuity.md#shot-planning): the brief, the level, the words a shot can hold, the scene's
  // light and state, and the last shot of the previous scene.
  const v2 = promptVersionOf(settings) >= 2;
  const previousClip = sortedClips(docs)
    .filter((c) => c.index < scene.index)
    .pop();
  const previousShot = previousClip?.shots
    .slice()
    .sort((a, b) => a.index - b.index)
    .pop();
  const v2Inputs = v2
    ? {
        brief: docs.project.brief.prompt,
        maxWordsPerShot: wordsCapacity(maxSec),
        previousShot: previousShot
          ? { description: previousShot.description, endState: previousShot.endState ?? '' }
          : null,
        ...dialogueDirection(settings.dialogue?.level ?? 'any', maxSec),
        ...(sequences
          ? {
              sequence: {
                maxShots: limits?.max_shots ?? 2,
                maxDurationSec: limits?.max_duration_seconds ?? maxSec * 2,
              },
            }
          : {}),
      }
    : {};
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
        location: location ? { name: location.name, description: location.description } : null,
        props: sceneElements.map((e) => ({ name: e!.name, description: e!.description })),
        ...(v2 ? { timeOfDay: scene.timeOfDay, continuity: scene.continuity ?? '' } : {}),
      },
      characters: cast.map((c) => ({ name: c!.name, summary: c!.summary })),
      style: [sp.style.visual, sp.style.camera].filter(Boolean).join('; '),
      limits: { minDurationSec: minSec, maxDurationSec: maxSec },
      targetDurationSec: target,
      ...v2Inputs,
      ...(direction ? { direction } : {}),
    },
    ctx.signal,
    v2 ? 2 : 1,
  );
  const shots = normalizePlannedShots(out.shots, {
    characters: all,
    minSec,
    maxSec,
    targetSec: target,
    locationId: location?.id ?? null,
    sceneElements: sceneElements.filter((e) => e !== undefined),
  });
  if (!shots.length) throw new AppError('llm_invalid_output', 'the shot plan was empty', [], true);
  const { result: clip } = await commitAs(
    deps,
    ctx,
    (tx) => {
      const existing = tx.list<Clip>('clips/').find((c) => c.sceneId === sceneId);
      // A plan again keeps the scene's set and marks: its new shots get cameras when it is blocked again
      const next: Clip = existing
        ? {
            ...existing,
            shots,
            status: 'planned',
            approvedAt: null,
            approvedBy: null,
            review: null,
            boardReview: null,
          }
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
            review: null,
            blocking: null,
            boardReview: null,
          };
      tx.set(docPath.clip(next.id), next);
      return next;
    },
    (c) =>
      `Plan clip ${c.index + 1} “${c.title}” (${c.shots.length} shots, ${c.shots.reduce((s, x) => s + x.durationSec, 0).toFixed(0)}s)`,
  );
  if (thenGenerate) {
    const fresh = await docsFor(deps, ctx);
    assertCastReady(clip.shots, fresh.characters, fresh.elements);
    assertVoicesReady(deps, clip.shots, fresh.characters, fresh.project.settings);
    await ctx.spawn('clip.generate', { clipId: clip.id }, { dedupeKey: `clip:${clip.id}` });
  }
  if (thenBoard) await ensureBlocking(deps, ctx, [clip.id]);
  if (thenBoard)
    for (const shot of clip.shots)
      await ctx.spawn('shot.board', { clipId: clip.id, shotId: shot.id }, { dedupeKey: `board:${shot.id}` });
  return { clipId: clip.id, shots: clip.shots.length };
}

/** Generates every shot without a take; continuous shots wait for their predecessor (R5), cuts run in parallel. */
export async function clipGenerate(deps: HandlerDeps, ctx: JobContext) {
  const { clipId } = ctx.job.params as { clipId: string };
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  assertCastReady(clip.shots, docs.characters, docs.elements);
  assertVoicesReady(deps, clip.shots, docs.characters, docs.project.settings);
  const todo = [...clip.shots]
    .sort((a, b) => a.index - b.index)
    .filter((s) => {
      const t = s.takes.find((x) => x.id === s.selectedTakeId);
      return !t?.video || !isAcceptable(takeState(t, s, docs.characters, docs.elements));
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
  // Multi-shot models render groups of consecutive shots in one request (docs/design/multi-shot.md#when).
  const settings = docs.project.settings;
  const limits = (await deps.gateway.limitsFor('video', settings.models.video)).limits;
  const maxShots = limits?.max_shots ?? 0;
  // A sequence carries the takes' own voices and each of its segments is checked like a single take
  // (docs/design/multi-shot.md#splitting-and-verification); native dialogue is conditioned shot by shot
  const units =
    maxShots >= 2 && settings.generation.multiShot !== 'off' && dialogueMode(settings) !== 'native'
      ? planShotGroups(todo, {
          maxShots,
          maxDurationSec: limits?.max_duration_seconds ?? 10,
          eligible: (id) => !needsOwnRequest(todo.find((s) => s.id === id)!),
          // An approved storyboard frame is where its shot starts: such a shot may open a group, never join one
          joins: (first, next) =>
            boardState(next, docs) !== 'approved' &&
            (!limits?.exclusive_frames_and_references || framedGroupJoins(first, next)),
        })
      : todo.map((s) => [s.id]);
  const jobs: Job[] = [];
  let prev: Job | null = null;
  // Version 2: the clip's first shot goes first, so the others can match its place and light
  // (docs/design/continuity.md#scene-reference-frame).
  const firstIndex = Math.min(...clip.shots.map((s) => s.index));
  const anchorFirst = promptVersionOf(settings) >= 2 && todo[0]?.index === firstIndex && units.length > 1;
  for (const unit of units) {
    throwIfAborted(ctx.signal);
    const shot = todo.find((s) => s.id === unit[0])!;
    if (shot.continuity === 'continuous' && prev) await ctx.waitFor([prev.id]);
    else if (anchorFirst && jobs.length === 1) await ctx.waitFor([jobs[0]!.id]);
    const j =
      unit.length > 1
        ? await ctx.spawn('shot.group', { clipId, shotIds: unit }, { dedupeKey: `group:${unit.join(',')}` })
        : await ctx.spawn('shot.generate', { clipId, shotId: shot.id }, { dedupeKey: `shot:${shot.id}` });
    jobs.push(j);
    prev = j;
    ctx.progress(
      jobs.length,
      units.length * 2,
      `shot ${shot.index + 1}${unit.length > 1 ? `–${shot.index + unit.length}` : ''} queued`,
    );
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
  // The scene watched before the edit and the shots that break it made again, so the cut is assembled from the fixed
  // takes (docs/design/ai-review.md#scenes-before-the-edit); a review that fails never fails the clip
  const made = (await docsFor(deps, ctx)).clips[clipId];
  if (
    made &&
    made.shots.length >= 2 &&
    !shotsWithoutTakes(made).length &&
    settings.review.scenes &&
    deps.config.gateway.configured
  ) {
    const review = await ctx.spawn('clip.review', { clipId }, { dedupeKey: `review:${clipId}` });
    const [done] = await ctx.waitFor([review.id]);
    if (done?.status !== 'succeeded')
      ctx.log.warn(
        { clipId, err: done?.error?.message?.slice(0, 300) },
        'the scene review did not finish; the clip goes on',
      );
  }
  // On autopilot the clip is approved when its takes and its scene passed their reviews (docs/design/ai-review.md)
  const approved = await approveClipOnAutopilot(deps, ctx, clipId);
  return { generated: results.length - failed.length, failed: failed.length, approved };
}

/**
 * An unattended batch's new places and props (docs/design/generation-pipeline.md#batch-generation): references drawn
 * when there are none, the first approved, the element locked. Returns the names of those without a reference.
 */
async function approveNewElements(
  deps: HandlerDeps,
  ctx: JobContext,
  elementIds: string[],
): Promise<string[]> {
  const projectId = ctx.job.projectId;
  let docs = await docsFor(deps, ctx);
  const jobs = [];
  for (const id of elementIds) {
    const e = docs.elements[id];
    if (e && !e.lock.locked && e.references.length === 0)
      jobs.push(await deps.services.elements.generateReferences(ctx.actor, projectId, id));
  }
  if (jobs.length) await ctx.waitFor(jobs.map((j) => j.id));
  docs = await docsFor(deps, ctx);
  const missing: string[] = [];
  for (const id of elementIds) {
    const e = docs.elements[id];
    if (!e || e.lock.locked) continue;
    const first = approvedElementReferences(e)[0] ?? e.references[0];
    if (!first) {
      missing.push(e.name);
      continue;
    }
    if (!first.approved)
      await deps.services.elements.setReferenceApproval(ctx.actor, projectId, id, first.id, true);
    await deps.services.elements.lock(ctx.actor, projectId, id);
    ctx.log.info(
      { elementId: id, name: e.name },
      'approved and locked a new element for an unattended batch',
    );
  }
  return missing;
}

/**
 * On autopilot, a new place or prop is reviewed like the cast (docs/design/ai-review.md#autopilot-every-step-reviewed-and-approved):
 * its references drawn, the cast review run, and on a pass its references approved and the element locked. Returns
 * the names of those still waiting for a person.
 */
async function reviewNewElements(
  deps: HandlerDeps,
  ctx: JobContext,
  elementIds: string[],
): Promise<string[]> {
  const projectId = ctx.job.projectId;
  let docs = await docsFor(deps, ctx);
  const jobs = [];
  for (const id of elementIds) {
    const e = docs.elements[id];
    if (e && !e.lock.locked && e.references.length === 0)
      jobs.push(await deps.services.elements.generateReferences(ctx.actor, projectId, id));
  }
  if (jobs.length) await ctx.waitFor(jobs.map((j) => j.id));
  const review = await ctx.spawn('cast.review', {}, { dedupeKey: 'ai-review:cast' });
  await ctx.waitFor([review.id]);
  docs = await docsFor(deps, ctx);
  const names = elementIds.map((id) => docs.elements[id]?.name ?? id);
  const state = reviewState(docs, 'cast');
  if (state !== 'passed' && state !== 'overridden') return names;
  const flagged = new Set(
    (docs.aiReviews.cast?.issues ?? []).filter((i) => i.severity !== 'minor').map((i) => i.elementId),
  );
  for (const id of elementIds) {
    const e = docs.elements[id];
    if (!e || e.lock.locked) continue;
    if (!e.references.some((r) => r.approved))
      for (const r of flagged.has(id) ? e.references.slice(0, 1) : e.references)
        await deps.services.elements.setReferenceApproval(ctx.actor, projectId, id, r.id, true);
    await deps.services.elements.lock(ctx.actor, projectId, id);
    deps.metrics.autopilotApprovals.inc({ step: 'cast' });
  }
  ctx.log.info({ elements: names }, 'reviewed, approved and locked new elements on autopilot');
  return [];
}

/**
 * Generates the film up to the target length (docs/design/generation-pipeline.md#batch-generation): clips in
 * order, `settings.batch.lookahead` of them at once, planning and extending the screenplay just in time, under a
 * generation budget.
 */
export async function batchGenerate(deps: HandlerDeps, ctx: JobContext) {
  const maxGenerations = Number(ctx.job.params.maxGenerations ?? 2000);
  const inFlight: Job[] = [];
  const started = new Set<string>();
  let generations = 0;
  let stopReason = 'target reached';
  const planFailures = new Set<string>();
  // Production scenes whose storyboard this batch made or approved (docs/design/ai-review.md#production-storyboards)
  const boardTried = new Set<string>();
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
          return !t?.video || !isAcceptable(takeState(t, s, docs.characters, docs.elements));
        }),
    );
    if (next && inFlight.length < (docs.project.settings.batch?.lookahead ?? 3)) {
      const cost = next.shots.length * 2;
      if (generations + cost > maxGenerations) {
        stopReason = 'generation budget reached';
        break;
      }
      // Safety net (docs/design/elements.md#workflow): a location or prop the extension introduced must be
      // approved and locked by a person before shots use it; prepare its references and stop.
      const pending = [...new Set(next.shots.flatMap((s) => s.elementIds))]
        .map((id) => docs.elements[id])
        .filter((e) => !!e && (!e.lock.locked || approvedElementReferences(e).length === 0));
      // Unattended: draw, approve the first reference and lock, then go on (a person reviews it later). A locked
      // element without an approved reference still stops the batch: only a person can unlock it.
      const unattended = docs.project.settings.batch?.approveNewElements
        ? pending.filter((e) => !e!.lock.locked)
        : [];
      if (unattended.length) {
        const missing = await approveNewElements(
          deps,
          ctx,
          unattended.map((e) => e!.id),
        );
        if (!missing.length) continue;
        stopReason = `new locations or props need approval: ${missing.join(', ')} (no reference could be drawn)`;
        break;
      }
      // On autopilot with the cast review: the cast review approves them (docs/design/ai-review.md)
      const reviewed =
        docs.project.settings.autopilot && reviewEnabled(docs, 'cast')
          ? pending.filter((e) => !e!.lock.locked)
          : [];
      if (reviewed.length && reviewed.length === pending.length) {
        const waiting = await reviewNewElements(
          deps,
          ctx,
          reviewed.map((e) => e!.id),
        );
        if (!waiting.length) continue;
        stopReason = `new locations or props did not pass the cast review: ${waiting.join(', ')}`;
        break;
      }
      if (pending.length) {
        for (const e of pending)
          if (!e!.lock.locked && e!.references.length === 0)
            await deps.services.elements.generateReferences(ctx.actor, ctx.job.projectId, e!.id);
        stopReason = `new locations or props need approval: ${pending.map((e) => e!.name).join(', ')}`;
        break;
      }
      // The same for a speaker without a locked voice (docs/design/dialogue.md#workflow): design and stop.
      const silent = voicesNotReady(next.shots, docs.characters, dialogueMode(docs.project.settings));
      if (silent.length) {
        for (const c of silent) {
          const v = voiceOf(c);
          if (deps.tts && !v.lock.locked && !v.voiceId && !v.sample && v.candidates.length === 0)
            await deps.services.voices.design(ctx.actor, ctx.job.projectId, c.id);
        }
        stopReason = `voices need approval: ${silent.map((c) => c.name).join(', ')}`;
        break;
      }
      assertCastReady(next.shots, docs.characters, docs.elements);
      assertVoicesReady(deps, next.shots, docs.characters, docs.project.settings);
      // Production storyboards (docs/design/ai-review.md#production-storyboards): the scene is blocked, drawn, reviewed
      // and its frames approved before any of its video is made; one of the storyboard stage's scenes too when the
      // stage did not draw it (written after it)
      const sb = docs.project.settings.storyboard;
      if (sb?.production && sb.enabled !== false && !clipFramesApproved(next, docs)) {
        const state = clipBoardReviewState(next);
        if (state === 'failed') {
          stopReason = `the storyboard of scene ${next.index + 1} did not pass its review`;
          break;
        }
        if ((state === 'passed' || state === 'overridden') && !boardTried.has(next.id)) {
          await deps.services.storyboard.approveFrames(ctx.actor, ctx.job.projectId, next.id);
          boardTried.add(next.id);
          continue;
        }
        if (boardTried.has(next.id) && state !== 'outdated' && state !== 'missing') {
          stopReason = `the storyboard of scene ${next.index + 1} needs a person: its frames are not all approved`;
          break;
        }
        boardTried.add(next.id);
        ctx.progress(
          Math.min(planned, target),
          target,
          `storyboarding scene ${next.index + 1} before its video`,
        );
        const board = await ctx.spawn(
          'clip.storyboard',
          { clipId: next.id },
          { dedupeKey: `clip-storyboard:${next.id}` },
        );
        const [boarded] = await ctx.waitFor([board.id]);
        if (boarded?.status !== 'succeeded') {
          stopReason = `the storyboard of scene ${next.index + 1} could not be made: ${boarded?.error?.message ?? 'unknown'}`;
          break;
        }
        continue;
      }
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
      const before = new Set(sp.scenes.map((s) => s.id));
      const job = await ctx.spawn('screenplay.extend', { beats: 3 }, { dedupeKey: 'screenplay.extend' });
      const [done] = await ctx.waitFor([job.id]);
      if (done?.status !== 'succeeded') {
        stopReason = `screenplay extension failed: ${done?.error?.message ?? 'unknown'}`;
        break;
      }
      // The new scenes are reviewed (and revised) before they are planned (docs/design/ai-review.md#how-a-review-runs)
      const review = docs.project.settings.review;
      if (review.extensions && review.screenplay && deps.config.gateway.configured) {
        const written = ((await docsFor(deps, ctx)).screenplay?.scenes ?? [])
          .filter((s) => !before.has(s.id))
          .map((s) => s.id);
        if (written.length) {
          const reviewJob = await ctx.spawn(
            'screenplay.review',
            { sceneIds: written },
            { dedupeKey: 'ai-review:screenplay' },
          );
          const [reviewed] = await ctx.waitFor([reviewJob.id]);
          const state = reviewState(await docsFor(deps, ctx), 'screenplay');
          if (reviewed?.status !== 'succeeded' || (state !== 'passed' && state !== 'overridden')) {
            stopReason = `the new scenes did not pass their review (${written.length} scene(s))`;
            break;
          }
        }
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
  // Takes the judge could not verify while the batch ran are judged again (docs/design/character-consistency.md)
  const unverified = Object.values(docs.clips).some((c) =>
    c.shots.some((s) => s.takes.some((t) => t.consistency.status === 'unverified' && t.video && !t.override)),
  );
  if (unverified && docs.project.settings.consistency.judge !== 'off')
    await deps.services.clips
      .recheck(ctx.actor, ctx.job.projectId)
      .catch((err) => ctx.log.warn({ err: (err as Error).message }, 'could not start the re-check'));
  // On autopilot the production gate is approved once every clip passed its gate (docs/design/ai-review.md)
  const approved =
    stopReason === 'target reached' || stopReason === 'the outline is complete'
      ? await approveProductionOnAutopilot(deps, ctx)
      : false;
  return {
    clips: started.size,
    plannedDurationSec: plannedDuration(docs),
    stopReason,
    generationsBudgeted: generations,
    approved,
  };
}

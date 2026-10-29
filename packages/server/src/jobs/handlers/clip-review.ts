import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assembleFeedback,
  type Clip,
  type ClipReview,
  ClipReviewSchema,
  clipReviewSubject,
  clipReviewVerdict,
  docPath,
  type FeedbackRecommendation,
  FeedbackSignalsSchema,
  fixEstimate,
  fixOutcome,
  madeFixes,
  meanAttempts,
  mergeSceneOutputs,
  overallScore,
  type SceneReview,
  sceneFixes,
  shotsWithoutTakes,
  takeSpans,
} from '@rideo/shared';
import { shotRevision } from '../../domain/feedback';
import { invalid, notFound } from '../../errors';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps } from './common';
import { sceneInput, strip } from './feedback';

type Watched = Pick<
  ClipReview,
  | 'subject'
  | 'overall'
  | 'scores'
  | 'summary'
  | 'issues'
  | 'recommendations'
  | 'watched'
  | 'heard'
  | 'verdict'
>;

/** The largest scene video sent inline (models take base64 video under 10 MB, docs/design/ai-gateway.md). */
const SCENE_VIDEO_MAX_BYTES = 7 * 1024 * 1024;
const SCENE_AUDIO_KBPS = 48;

/**
 * The scene as one video (docs/design/ai-review.md#scenes-before-the-edit): its selected takes one after another, each
 * scaled to the same frame, with its sound or silence, H.264 CRF 32 with mono AAC; at the bitrate that fits 7 MB when
 * it is longer, 360p past 90 s; null when even that does not fit.
 */
export async function sceneTakesVideo(
  deps: HandlerDeps,
  takes: { file: string; durationSec: number; hasAudio: boolean }[],
  aspect: number,
  out: string,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const total = takes.reduce((n, t) => n + t.durationSec, 0);
  const h = total > 90 ? 360 : 480;
  const w = Math.max(2, Math.round((h * aspect) / 2) * 2);
  const graph: string[] = [];
  const inputs: string[] = [];
  takes.forEach((t, i) => {
    inputs.push('-i', t.file);
    graph.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`,
    );
    graph.push(
      t.hasAudio
        ? `[${i}:a]aresample=48000,aformat=channel_layouts=mono,atrim=0:${t.durationSec.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
        : `anullsrc=channel_layout=mono:sample_rate=48000,atrim=0:${t.durationSec.toFixed(3)}[a${i}]`,
    );
  });
  graph.push(`${takes.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${takes.length}:v=1:a=1[v][a]`);
  const encode = async (rate: string[]) => {
    await deps.ff.run(
      [
        ...inputs,
        '-filter_complex',
        graph.join(';'),
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        ...rate,
        '-c:a',
        'aac',
        '-b:a',
        `${SCENE_AUDIO_KBPS}k`,
        '-movflags',
        '+faststart',
        out,
      ],
      { signal },
    );
    return (await stat(out)).size;
  };
  if ((await encode(['-crf', '32'])) <= SCENE_VIDEO_MAX_BYTES) return readFile(out);
  const kbps = Math.floor((SCENE_VIDEO_MAX_BYTES * 8 * 0.9) / Math.max(1, total) / 1000) - SCENE_AUDIO_KBPS;
  if (kbps < 100) return null;
  const size = await encode(['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`]);
  return size <= SCENE_VIDEO_MAX_BYTES ? readFile(out) : null;
}

/** Writes the clip's scene review over what is there. */
async function writeReview(
  deps: HandlerDeps,
  ctx: JobContext,
  clipId: string,
  patch: Partial<ClipReview>,
  message: string,
): Promise<ClipReview> {
  const { result } = await commitAs(
    deps,
    ctx,
    (tx) => {
      const clip = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
      const next = ClipReviewSchema.parse({
        ...(clip.review ?? {}),
        ...patch,
        checkedAt: new Date().toISOString(),
      });
      clip.review = next;
      tx.set(docPath.clip(clipId), clip);
      return next;
    },
    message,
  );
  return result;
}

/**
 * One watch of the scene's selected takes (docs/design/ai-review.md#scenes-before-the-edit): a strip per whole take,
 * the export feedback's scene call with `stage: "takes"`, assembled as the feedback is.
 */
async function watch(
  deps: HandlerDeps,
  ctx: JobContext,
  clipId: string,
  dir: string,
  round: number,
): Promise<Watched> {
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  const missing = shotsWithoutTakes(clip);
  if (missing.length)
    throw invalid(`shot ${missing[0]!.index + 1} of clip ${clip.index + 1} has no take to watch`);
  const spans = takeSpans(clip);
  const strips: { label: string; data: Buffer }[] = [];
  const files: { file: string; durationSec: number; hasAudio: boolean }[] = [];
  for (const [i, span] of spans.entries()) {
    throwIfAborted(ctx.signal);
    const take = clip.shots.find((s) => s.id === span.shotId)!.takes.find((t) => t.id === span.takeId)!;
    const file = await deps.media.localPath(ctx.job.projectId, take.video!);
    const probe = await deps.ff.probe(file);
    files.push({ file, durationSec: Math.max(0.1, span.end - span.start), hasAudio: probe.hasAudio });
    strips.push({
      label: `${i}: ${span.label} (${span.start.toFixed(1)}–${span.end.toFixed(1)} s)`,
      data: await strip(
        deps,
        file,
        { start: 0, end: span.end - span.start },
        join(dir, `strip-${round}-${i}.jpg`),
        ctx.signal,
      ),
    });
  }
  const ordered = Object.values(docs.clips).sort((a, b) => a.index - b.index);
  const at = ordered.findIndex((c) => c.id === clipId);
  const neighbours = { previous: ordered[at - 1]?.id ?? null, next: ordered[at + 1]?.id ?? null };
  const durationSec = spans.at(-1)!.end;
  const signals = FeedbackSignalsSchema.parse({ durationSec });
  // The scene as one video: the picture watched by the vision model, the sound heard by the audio-visual model
  const { width, height } = docs.project.settings.resolution;
  const video = await sceneTakesVideo(
    deps,
    files,
    width / Math.max(1, height),
    join(dir, `scene-${round}.mp4`),
    ctx.signal,
  ).catch((err) => {
    if (ctx.signal.aborted) throw err;
    ctx.log.warn({ clipId, err: (err as Error).message.slice(0, 300) }, 'could not cut the scene video');
    return null;
  });
  const base = sceneInput(docs, clipId, spans, neighbours, signals);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const where = (i: number) => ({ from: round2(spans[i]!.start), to: round2(spans[i]!.end) });
  const pictureInput = {
    ...base,
    stage: 'takes' as const,
    shots: base.shots.map((s, i) => ({ ...s, video: where(i) })),
  };
  const listen = !!video && !!deps.llm.omni && files.some((f) => f.hasAudio);
  const [seen, heard] = await Promise.allSettled([
    deps.llm.feedbackScene(pictureInput, strips, ctx.signal, video ?? undefined),
    listen
      ? deps.llm.feedbackListen(
          { ...sceneInput(docs, clipId, spans, neighbours, signals, true), stage: 'takes' },
          video!,
          ctx.signal,
        )
      : Promise.resolve(null),
  ]);
  throwIfAborted(ctx.signal);
  if (seen.status === 'rejected') throw seen.reason;
  if (heard.status === 'rejected')
    ctx.log.warn(
      { clipId, err: (heard.reason as Error)?.message?.slice(0, 300) },
      'the scene could not be heard; the picture review goes on',
    );
  const heardOut = heard.status === 'fulfilled' ? heard.value : null;
  const watched = seen.value.watched === 'video' ? 'video' : 'frames';
  deps.metrics.clipReviewWatched.inc({ watched });
  const output = mergeSceneOutputs(seen.value, heardOut)!;
  const scene: SceneReview = {
    clipId,
    index: clip.index,
    title: clip.title,
    start: 0,
    end: durationSec,
    spans,
    output,
  };
  const parts = assembleFeedback({ scenes: [scene], film: null, signals, retrospective: [] });
  const scores = parts.scenes[0]?.scores ?? {};
  // What each fix is expected to cost (docs/design/feedback.md#what-a-fix-costs)
  const attempts = meanAttempts(docs.clips);
  const overall = overallScore(scores);
  const issues = parts.issues.slice(0, 60);
  return {
    subject: clipReviewSubject(clip),
    overall,
    scores,
    watched,
    heard: !!heardOut,
    verdict: clipReviewVerdict({ overall, scores, issues }, docs.project.settings.review.sceneThreshold),
    summary: output.summary,
    issues,
    recommendations: parts.recommendations.slice(0, 40).map((r) => {
      const estimate = fixEstimate(r.action, docs, deps.config.prices, attempts);
      return estimate ? { ...r, estimate } : r;
    }),
  };
}

/**
 * `clip.review` (docs/design/ai-review.md#scenes-before-the-edit): the scene's takes watched before the edit; its
 * priority 1 regenerations applied (at most `settings.review.sceneFixes`, one per shot, each new take selected only
 * when it passes every check) and the scene watched once more. Params: `clipId`, `fix` (false: watch only).
 */
export async function clipReview(deps: HandlerDeps, ctx: JobContext) {
  const { clipId, fix } = ctx.job.params as { clipId: string; fix?: boolean };
  const projectId = ctx.job.projectId;
  const first = await docsFor(deps, ctx);
  const clip = first.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  const max = fix === false ? 0 : first.project.settings.review.sceneFixes;
  const scene = clip.index + 1;
  const model = deps.llm.vision.model;
  // A retry after this job's fixes were made (its second watch failed) never fixes twice
  const made = madeFixes(clip.review, ctx.job.id);
  await writeReview(
    deps,
    ctx,
    clipId,
    { status: 'running', jobId: ctx.job.id, model, error: undefined },
    `Watch scene ${scene} before the edit`,
  );
  try {
    return await deps.media.withTmpDir(async (dir) => {
      let one: Watched;
      let fixes: FeedbackRecommendation[];
      if (made.length) {
        const r = clip.review!;
        one = {
          subject: r.subject,
          overall: r.overall,
          scores: r.scores,
          watched: r.watched,
          heard: r.heard,
          verdict: r.verdict,
          summary: r.summary,
          issues: r.issues,
          recommendations: r.recommendations,
        };
        fixes = made;
        ctx.log.info({ clipId, fixes: fixes.length }, 'resuming the scene review after its fixes');
      } else {
        ctx.progress(0.05, 1, 'watching the scene');
        one = await watch(deps, ctx, clipId, dir, 1);
        deps.metrics.clipReviewScore.observe({ round: '1' }, one.overall ?? 0);
        ctx.log.info(
          { clipId, round: 1, overall: one.overall, issues: one.issues.length },
          'watched the scene before the edit',
        );
        const todo = sceneFixes(one.recommendations, max);
        if (!todo.length) {
          await writeReview(
            deps,
            ctx,
            clipId,
            { status: 'succeeded', round: 1, ...one, fixes: [], before: null },
            `Scene ${scene} watched before the edit: ${one.overall ?? '–'}/10`,
          );
          deps.metrics.clipReviews.inc({ outcome: 'clean' });
          return { round: 1, overall: one.overall, fixes: 0, fixed: 0 };
        }

        // The fixes: each shot revised and generated again; its take selected (and put in the cut, once there is
        // one) only when it passes every check
        ctx.progress(0.3, 1, `generating ${todo.length} shot(s) again`);
        const docs = await docsFor(deps, ctx);
        const appliedAt = new Date().toISOString();
        fixes = [];
        for (const rec of todo) {
          throwIfAborted(ctx.signal);
          if (rec.action?.kind !== 'regenerate_shot') continue;
          const { shotId } = rec.action;
          const patch = shotRevision(rec.action, docs.characters);
          if (patch) await deps.services.clips.updateShot(ctx.actor, projectId, clipId, shotId, patch);
          const job = await ctx.spawn(
            'shot.generate',
            { clipId, shotId, selectIfPasses: true, swapInCut: true },
            { priority: 10, dedupeKey: `shot:${shotId}` },
          );
          fixes.push({ ...rec, status: 'applied', appliedAt, appliedBy: ctx.actor, jobId: job.id });
        }
        const applied = fixes;
        await writeReview(
          deps,
          ctx,
          clipId,
          {
            round: 1,
            ...one,
            recommendations: one.recommendations.map((r) => applied.find((f) => f.id === r.id) ?? r),
            fixes,
            before: null,
          },
          `Fix ${fixes.length} shot(s) of scene ${scene} before the edit`,
        );
      }
      const results = await ctx.waitFor(fixes.map((f) => f.jobId!));
      const after = await docsFor(deps, ctx);
      const states = fixes.map((f) => {
        const job = results.find((r) => r.id === f.jobId);
        const outcome = fixOutcome(f, after);
        return job?.status !== 'succeeded' ? 'failed' : outcome?.state === 'fixed' ? 'fixed' : 'not_fixed';
      });
      const fixed = states.filter((s) => s === 'fixed').length;

      // Once more, for the record: the cut is assembled from what this watch sees
      ctx.progress(0.85, 1, 'watching the scene again');
      const two = await watch(deps, ctx, clipId, dir, 2);
      deps.metrics.clipReviewScore.observe({ round: '2' }, two.overall ?? 0);
      ctx.log.info(
        { clipId, round: 2, before: one.overall, overall: two.overall, fixes: fixes.length, fixed },
        'watched the scene again after its fixes',
      );
      await writeReview(
        deps,
        ctx,
        clipId,
        {
          status: 'succeeded',
          round: 2,
          ...two,
          fixes,
          before: { overall: one.overall, scores: one.scores, issues: one.issues.length },
        },
        `Scene ${scene} watched again after ${fixes.length} fix(es): ${one.overall ?? '–'} → ${two.overall ?? '–'}/10`,
      );
      // Counted once the review is written: a retry that resumes it counts its fixes then
      for (const state of states) deps.metrics.clipReviewFixes.inc({ outcome: state });
      deps.metrics.clipReviews.inc({ outcome: 'fixed' });
      return { round: 2, before: one.overall, overall: two.overall, fixes: fixes.length, fixed };
    });
  } catch (err) {
    deps.metrics.clipReviews.inc({ outcome: 'error' });
    await writeReview(
      deps,
      ctx,
      clipId,
      {
        status: 'failed',
        error: ctx.signal.aborted
          ? 'cancelled'
          : (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      },
      `The review of scene ${scene} stopped`,
    ).catch(() => undefined);
    throw err;
  }
}

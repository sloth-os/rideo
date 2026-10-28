import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assembleFeedback,
  compactIdentity,
  cutPoints,
  dialogueDelivery,
  docPath,
  type Export,
  FEEDBACK_DIMENSIONS,
  type Feedback,
  type FeedbackFilmInput,
  type FeedbackFilmOutput,
  type FeedbackSceneInput,
  FeedbackSchema,
  type FeedbackShotSpan,
  type FeedbackSignals,
  feedbackMarkdown,
  fixEstimate,
  framingRuns,
  meanAttempts,
  mergeSceneOutputs,
  type ProjectDocs,
  rushedLines,
  type SceneReview,
  shotSpans,
  type Timeline,
  takeSignals,
  takeState,
  unexpectedCuts,
  voicePhrase,
} from '@rideo/shared';
import { retrospective } from '../../domain/retrospective';
import { invalid, notFound } from '../../errors';
import { exportSignals } from '../../media/temporal';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps } from './common';

/** Points of a shot in the strip (docs/design/feedback.md#how-a-film-is-watched, step 2). */
const STRIP_AT = [0.15, 0.5, 0.85];
const STRIP_WIDTH = 384;
/** Scene calls made at once. */
const SCENE_CONCURRENCY = 3;
/** The largest scene video sent inline (Qwen-Omni takes base64 under 10 MB, docs/design/ai-gateway.md). */
const SCENE_VIDEO_MAX_BYTES = 7 * 1024 * 1024;
const SCENE_AUDIO_KBPS = 48;

/** The timeline the export rendered: its own render timeline when it has one, else the cut at its commit. */
async function exportTimeline(deps: HandlerDeps, projectId: string, exp: Export): Promise<Timeline> {
  const render = (await deps.services.projects
    .getDoc(projectId, docPath.render(exp.id))
    .catch(() => null)) as Timeline | null;
  if (render) return render;
  const t = (await deps.services.projects.getDoc(
    projectId,
    'timeline.json',
    exp.timelineCommit ?? undefined,
  )) as Timeline | null;
  if (!t) throw invalid(`export ${exp.id} has no timeline`);
  return t;
}

/** Three frames of a shot side by side, labelled by its place in the scene. */
async function strip(
  deps: HandlerDeps,
  file: string,
  span: FeedbackShotSpan,
  out: string,
  signal: AbortSignal,
): Promise<Buffer> {
  // Within the shot's clean part: a transition blends it with its neighbour (docs/design/feedback.md)
  const { start, end } = span.clean;
  const len = Math.max(0.1, end - start);
  const times = STRIP_AT.map((f) => Math.max(0, start + f * len));
  const args: string[] = [];
  for (const t of times) args.push('-ss', t.toFixed(3), '-i', file);
  const scaled = times.map((_, i) => `[${i}:v]scale=${STRIP_WIDTH}:-2,setsar=1[v${i}]`).join(';');
  args.push(
    '-filter_complex',
    `${scaled};${times.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${times.length}`,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    out,
  );
  await deps.ff.run(args, { signal });
  return readFile(out);
}

/**
 * The scene as a small video with its sound (docs/design/feedback.md#how-a-film-is-watched, step 2): 480p (360p past
 * 90 s) at CRF 32, else at the bitrate that fits; null when even that does not fit.
 */
async function sceneVideo(
  deps: HandlerDeps,
  file: string,
  range: { start: number; end: number },
  out: string,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const duration = Math.max(0.5, range.end - range.start);
  const height = duration > 90 ? 360 : 480;
  const encode = async (rate: string[]) => {
    await deps.ff.run(
      [
        '-ss',
        range.start.toFixed(3),
        '-t',
        duration.toFixed(3),
        '-i',
        file,
        '-vf',
        `scale=-2:${height}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        ...rate,
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        `${SCENE_AUDIO_KBPS}k`,
        '-ac',
        '1',
        '-movflags',
        '+faststart',
        out,
      ],
      { signal },
    );
    return readFile(out);
  };
  const first = await encode(['-crf', '32']);
  if (first.length <= SCENE_VIDEO_MAX_BYTES) return first;
  const kbps = Math.floor((SCENE_VIDEO_MAX_BYTES * 8 * 0.9) / duration / 1000) - SCENE_AUDIO_KBPS;
  if (kbps < 100) return null;
  const fitted = await encode(['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`]);
  return fitted.length <= SCENE_VIDEO_MAX_BYTES ? fitted : null;
}

/** What the scene's reviewers get (docs/design/feedback.md#how-a-film-is-watched, step 3); exported for tests. */
export function sceneInput(
  docs: ProjectDocs,
  clipId: string,
  spans: FeedbackShotSpan[],
  neighbours: { previous: string | null; next: string | null },
  signals: FeedbackSignals,
  listening = false,
): FeedbackSceneInput {
  const clip = docs.clips[clipId]!;
  const sp = docs.screenplay;
  const scene = sp?.scenes.find((s) => s.id === clip.sceneId);
  const sceneOf = (id: string | null) => {
    const c = id ? docs.clips[id] : undefined;
    const s = c?.sceneId ? sp?.scenes.find((x) => x.id === c.sceneId) : undefined;
    return s ? { heading: s.heading, summary: s.summary } : null;
  };
  const start = spans[0]!.start;
  const end = spans[spans.length - 1]!.end;
  const castIds = [
    ...new Set(spans.flatMap((s) => clip.shots.find((x) => x.id === s.shotId)?.characterIds ?? [])),
  ];
  const level = docs.project.settings.dialogue?.level ?? 'any';
  return {
    film: {
      title: sp?.title ?? docs.project.title,
      logline: sp?.logline ?? '',
      genre: sp?.genre ?? '',
      tone: sp?.tone ?? '',
      style: [sp?.style.visual, sp?.style.palette, sp?.style.lighting].filter(Boolean).join('; '),
      dialogueLevel: level === 'any' ? null : level,
    },
    scene: {
      number: clip.index + 1,
      heading: scene?.heading ?? clip.title,
      location: scene?.location ?? '',
      timeOfDay: scene?.timeOfDay ?? '',
      continuity: scene?.continuity ?? '',
      summary: scene?.summary ?? '',
      action: (scene?.action ?? '').slice(0, 3000),
      dialogue: (scene?.dialogue ?? []).slice(0, 30).map((d) => ({ character: d.character, line: d.line })),
      start,
      end,
    },
    previousScene: sceneOf(neighbours.previous),
    nextScene: sceneOf(neighbours.next),
    cast: castIds
      .map((id) => docs.characters[id])
      .filter((c) => !!c)
      .map((c) => ({
        name: c!.name,
        look: compactIdentity(c!),
        ...(listening ? { voice: voicePhrase(c!) } : {}),
      })),
    shots: spans.map((span, index) => {
      const shot = clip.shots.find((x) => x.id === span.shotId)!;
      const take = shot.takes.find((t) => t.id === span.takeId);
      const names = new Map(Object.values(docs.characters).map((c) => [c.id, c.name]));
      const q = take?.consistency.quality ?? null;
      return {
        index,
        label: span.label,
        start: span.start,
        end: span.end,
        description: shot.description,
        action: shot.action,
        camera: `${shot.camera.framing.replace(/_/g, ' ')}, ${shot.camera.movement.replace(/_/g, ' ')}${shot.camera.lensMm ? `, ${shot.camera.lensMm} mm` : ''}`,
        dialogue: shot.dialogue.map((d) => ({
          character: d.characterId ? (names.get(d.characterId) ?? 'Someone') : 'Narrator',
          line: d.line,
        })),
        characters: shot.characterIds.map((id) => names.get(id) ?? id),
        ...(listening ? { video: { from: round2(span.start - start), to: round2(span.end - start) } } : {}),
        take: take
          ? {
              consistency: takeState(take, shot, docs.characters, docs.elements),
              score: take.consistency.score,
              quality: q
                ? {
                    passed: q.passed,
                    physics: q.physics,
                    continuity: q.continuity,
                    jumps: q.temporal?.jumps.length ?? 0,
                  }
                : null,
            }
          : null,
      };
    }),
    signals: {
      unexpectedCuts: signals.unexpectedCuts.filter((c) => c.at >= start && c.at < end).map((c) => c.at),
      frozen: signals.frozen.filter((r) => r.end > start && r.start < end),
      black: signals.black.filter((r) => r.end > start && r.start < end),
    },
    stripCount: listening ? 0 : spans.length,
    listening,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Runs `fn` over `items` with at most `n` at once, keeping the order of the results. */
async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

/**
 * `export.feedback` (docs/design/feedback.md#how-a-film-is-watched): signals of the export, a vision call per scene
 * with strips of its shots, a text call for the film, the retrospective and the report.
 */
export async function exportFeedback(deps: HandlerDeps, ctx: JobContext) {
  const { exportId, feedbackId } = ctx.job.params as { exportId: string; feedbackId: string };
  const projectId = ctx.job.projectId;
  const log = ctx.log;
  const docs = await docsFor(deps, ctx);
  const exp = docs.exports[exportId];
  if (!exp?.media) throw notFound(`export ${exportId}`);
  const started = Date.now();
  try {
    return await deps.media.withTmpDir(async (dir) => {
      const timeline = await exportTimeline(deps, projectId, exp);
      const spans = shotSpans(timeline, docs.clips);
      const file = await deps.media.localPath(projectId, exp.media!);
      const probe = await deps.ff.probe(file);
      const durationSec = probe.durationSec || exp.durationSec || 0;

      // 1. Signals (no model).
      ctx.progress(0.05, 1, 'measuring the export');
      const measured = await exportSignals(deps.ff, file, durationSec, {
        hasAudio: probe.hasAudio,
        signal: ctx.signal,
      });
      const shotLengths = spans.map((s) => s.end - s.start);
      const signals: FeedbackSignals = {
        durationSec,
        targetDurationSec: docs.project.kind === 'story' ? docs.project.settings.targetDurationSec : null,
        black: measured.black,
        frozen: measured.frozen,
        silences: measured.silences,
        unexpectedCuts: unexpectedCuts(measured.changes, cutPoints(timeline), { durationSec }),
        loudness: exp.loudness
          ? {
              target: exp.loudness.target,
              integratedLufs: exp.loudness.integratedLufs,
              truePeakDb: exp.loudness.truePeakDb,
            }
          : null,
        shots: spans.length
          ? {
              count: spans.length,
              meanSec: Math.round((shotLengths.reduce((a, b) => a + b, 0) / spans.length) * 100) / 100,
              minSec: Math.round(Math.min(...shotLengths) * 100) / 100,
              maxSec: Math.round(Math.max(...shotLengths) * 100) / 100,
            }
          : null,
        framingRuns: framingRuns(spans, docs.clips),
        rushedLines: rushedLines(spans, docs.clips),
        takes: takeSignals(spans, docs.clips, docs.characters, docs.elements),
        dialogue: null,
      };
      throwIfAborted(ctx.signal);

      // 2–3. Scenes: one vision call per clip with a strip per shot.
      const groups: { clipId: string; spans: FeedbackShotSpan[] }[] = [];
      for (const span of spans) {
        const last = groups[groups.length - 1];
        if (last && last.clipId === span.clipId) last.spans.push(span);
        else groups.push({ clipId: span.clipId, spans: [span] });
      }
      const watching = deps.config.gateway.configured;
      // With an audio-visual model, each scene is watched with its sound (docs/design/feedback.md#how-a-film-is-watched).
      const listening = watching && !!deps.llm.omni && probe.hasAudio;
      let done = 0;
      const scenes: SceneReview[] = await pool(groups, watching ? SCENE_CONCURRENCY : 1, async (g, k) => {
        const clip = docs.clips[g.clipId]!;
        const review: SceneReview = {
          clipId: g.clipId,
          index: clip.index,
          title: clip.title,
          start: g.spans[0]!.start,
          end: g.spans[g.spans.length - 1]!.end,
          spans: g.spans,
          output: null,
        };
        if (!watching) return review;
        const neighbours = { previous: groups[k - 1]?.clipId ?? null, next: groups[k + 1]?.clipId ?? null };
        // The picture from strips (the vision model) and, with an audio-visual model, the sound from the scene's video,
        // at the same time (docs/design/feedback.md#how-a-film-is-watched, step 3)
        const picture = (async () => {
          throwIfAborted(ctx.signal);
          const strips: { label: string; data: Buffer }[] = [];
          for (const [i, span] of g.spans.entries())
            strips.push({
              label: `${i}: ${span.label} (${span.start.toFixed(1)}–${span.end.toFixed(1)} s)`,
              data: await strip(deps, file, span, join(dir, `strip-${k}-${i}.jpg`), ctx.signal),
            });
          return deps.llm.feedbackScene(
            sceneInput(docs, g.clipId, g.spans, neighbours, signals),
            strips,
            ctx.signal,
          );
        })();
        const heard = listening
          ? (async () => {
              const video = await sceneVideo(deps, file, review, join(dir, `scene-${k}.mp4`), ctx.signal);
              if (!video) return null;
              const input = sceneInput(docs, g.clipId, g.spans, neighbours, signals, true);
              return deps.llm.feedbackListen(input, video, ctx.signal);
            })()
          : Promise.resolve(null);
        const [seen, listenedTo] = await Promise.allSettled([picture, heard]);
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
        if (seen.status === 'rejected') {
          review.error = (seen.reason as Error).message.slice(0, 1000);
          log.warn({ clipId: g.clipId, err: review.error, exportId, feedbackId }, 'scene feedback failed');
        }
        if (listenedTo.status === 'rejected')
          log.warn(
            {
              clipId: g.clipId,
              err: (listenedTo.reason as Error).message.slice(0, 500),
              exportId,
              feedbackId,
            },
            'listening to the scene failed',
          );
        const heardOut = listenedTo.status === 'fulfilled' ? listenedTo.value : null;
        review.output = mergeSceneOutputs(seen.status === 'fulfilled' ? seen.value : null, heardOut);
        review.listened = !!heardOut;
        done++;
        ctx.progress(0.2 + (0.65 * done) / groups.length, 1, `watched ${done}/${groups.length} scenes`);
        return review;
      });
      throwIfAborted(ctx.signal);
      // The script's lines against what was heard (step 5)
      signals.dialogue = dialogueDelivery(scenes, docs.clips, docs.characters);
      const listened = scenes.some((s) => s.listened && s.output);

      // 4. The film (text only).
      const usage = await deps.usage.ledger.get(projectId);
      let film: FeedbackFilmOutput | null = null;
      if (watching && scenes.some((s) => s.output)) {
        ctx.progress(0.88, 1, 'reviewing the whole film');
        const sp = docs.screenplay;
        const level = docs.project.settings.dialogue?.level ?? 'any';
        const input: FeedbackFilmInput = {
          film: {
            title: sp?.title ?? docs.project.title,
            logline: sp?.logline ?? '',
            synopsis: (sp?.synopsis ?? '').slice(0, 4000),
            genre: sp?.genre ?? '',
            tone: sp?.tone ?? '',
            style: [sp?.style.visual, sp?.style.palette, sp?.style.lighting].filter(Boolean).join('; '),
            dialogueLevel: level === 'any' ? null : level,
            targetDurationSec: signals.targetDurationSec,
            durationSec,
          },
          outline: (sp?.outline ?? []).slice(0, 120).map((b) => ({
            title: b.title,
            purpose: b.purpose ?? '',
            summary: b.summary.slice(0, 400),
          })),
          scenes: scenes.map((s) => ({
            number: s.index + 1,
            heading: s.title,
            start: s.start,
            end: s.end,
            scores: s.output?.scores ?? {},
            summary: s.output?.summary ?? (s.error ? `not reviewed: ${s.error}` : ''),
            issues: (s.output?.issues ?? []).slice(0, 8).map((i) => ({
              severity: i.severity,
              dimension: i.dimension,
              title: i.title,
            })),
          })),
          signals: {
            unexpectedCuts: signals.unexpectedCuts.length,
            frozen: signals.frozen.length,
            black: signals.black.length,
            silences: signals.silences.length,
            rushedLines: signals.rushedLines.length,
            framingRuns: signals.framingRuns.length,
            dialogue: signals.dialogue
              ? { lines: signals.dialogue.lines, heard: signals.dialogue.heard }
              : null,
            loudness: signals.loudness
              ? { target: signals.loudness.target, integratedLufs: signals.loudness.integratedLufs }
              : null,
          },
          run: {
            shots: spans.length,
            takes: {
              passed: signals.takes.passed,
              unverified: signals.takes.unverified,
              overridden: signals.takes.overridden,
              qualityFailed: signals.takes.qualityFailed,
            },
            costUsd: usage.totals.costUsd > 0 ? Math.round(usage.totals.costUsd * 100) / 100 : null,
            videoSeconds: Math.round(usage.totals.videoSeconds),
            discardedVideoSeconds: Math.round(usage.totals.discardedVideoSeconds),
            llmRetries: usage.totals.llmRetries,
            failedJobs: deps.jobs.list(projectId, { status: 'failed' }).length,
          },
        };
        try {
          film = await deps.llm.feedbackFilm(input, ctx.signal);
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          log.warn({ err: (err as Error).message, exportId, feedbackId }, 'film feedback failed');
        }
      }

      // 5. Assembly, the retrospective and the report.
      ctx.progress(0.95, 1, 'writing the feedback');
      const assembled = assembleFeedback({ scenes, film, signals, retrospective: [] });
      // What each fix is expected to cost (docs/design/feedback.md#what-a-fix-costs)
      const attempts = meanAttempts(docs.clips);
      assembled.recommendations = assembled.recommendations.map((r) => {
        const estimate = fixEstimate(r.action, docs, deps.config.prices, attempts);
        return estimate ? { ...r, estimate } : r;
      });
      const retro = retrospective({
        docs,
        usage,
        jobs: deps.jobs.list(projectId),
        signals,
        scores: assembled.scores,
        spans,
      });
      const now = new Date().toISOString();
      const current = (await docsFor(deps, ctx)).feedback[feedbackId];
      let feedback: Feedback = FeedbackSchema.parse({
        ...(current ?? {}),
        id: feedbackId,
        exportId,
        jobId: ctx.job.id,
        status: 'succeeded',
        error: undefined,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        model: watching ? deps.llm.vision.model : null,
        listener: listened ? (deps.llm.omni?.model ?? null) : null,
        listened,
        timelineCommit: exp.timelineCommit,
        durationSec,
        ...assembled,
        retrospective: [...retro, ...assembled.retrospective].slice(0, 60),
        signals,
        report: null,
      });
      const title = docs.screenplay?.title ?? docs.project.title;
      const markdown = feedbackMarkdown(feedback, {
        title,
        run: {
          costUsd: usage.totals.costUsd > 0 ? usage.totals.costUsd : null,
          videoSeconds: usage.totals.videoSeconds,
          hours: null,
        },
      });
      const md = join(dir, 'feedback.md');
      await writeFile(md, markdown);
      const report = await deps.media.putFile(projectId, md, {
        kind: 'reports',
        name: `${exportId}-feedback`,
        mime: 'text/markdown',
        probe: false,
      });
      feedback = { ...feedback, report };
      await commitAs(
        deps,
        ctx,
        (tx) => tx.set(docPath.feedback(feedbackId), feedback),
        `Feedback on export ${exportId.slice(-6)}: ${feedback.overall !== null ? `${feedback.overall.toFixed(1)}/10` : 'measured'}, ${feedback.issues.length} issues, ${feedback.recommendations.length} recommendations`,
        { exportId, feedbackId },
      );
      deps.metrics.feedback.inc({ outcome: 'succeeded' });
      for (const d of FEEDBACK_DIMENSIONS) {
        const v = feedback.scores[d.id];
        if (typeof v === 'number') deps.metrics.feedbackScore.observe({ dimension: d.id }, v);
      }
      log.info(
        {
          exportId,
          feedbackId,
          overall: feedback.overall,
          issues: feedback.issues.length,
          recommendations: feedback.recommendations.length,
          scenesFailed: scenes.filter((s) => s.error).length,
          ms: Date.now() - started,
        },
        'feedback written',
      );
      return {
        feedbackId,
        overall: feedback.overall,
        issues: feedback.issues.length,
        recommendations: feedback.recommendations.length,
      };
    });
  } catch (err) {
    if (!ctx.signal.aborted && ctx.job.attempts >= ctx.job.maxAttempts) {
      deps.metrics.feedback.inc({ outcome: 'failed' });
      await commitAs(
        deps,
        ctx,
        (tx) => {
          const fb = tx.get<Feedback>(docPath.feedback(feedbackId));
          if (fb)
            tx.set(docPath.feedback(feedbackId), {
              ...fb,
              status: 'failed',
              error: (err as Error).message.slice(0, 4000),
              updatedAt: new Date().toISOString(),
            });
        },
        `Feedback on export ${exportId.slice(-6)} failed`,
      ).catch(() => undefined);
    }
    throw err;
  }
}

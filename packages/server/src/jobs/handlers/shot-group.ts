import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  absentCast,
  analysisCommand,
  attemptDone,
  betterAttempt,
  boardState,
  type Clip,
  type ConsistencyReport,
  compileMultiShotRequest,
  docPath,
  type Job,
  multiShotBoundaries,
  orderedShotCharacters,
  orderedShotElements,
  parseAnalysisLog,
  promptVersionOf,
  type Shot,
  type ShotContext,
  shotContextOf,
  temporalVerdict,
} from '@rideo/shared';
import { verifyFrames } from '../../consistency/gate';
import { checkSound, silentTakeVerdict, spokenLines, withSoundVerdict } from '../../consistency/sound';
import { assertCastReady, assertVoicesReady, clipStatusOf } from '../../domain/clips';
import { invalid, notFound } from '../../errors';
import { extractFrame, sampleFrames } from '../../media/frames';
import { sceneChanges } from '../../media/temporal';
import { throwIfAborted } from '../../util/abort';
import { Semaphore } from '../../util/mutex';
import type { JobContext } from '../queue';
import { commitAs, docsFor, gatewayOptions, type HandlerDeps } from './common';
import { speakLines, takeAudio } from './dialogue';
import { generateKeyframe, prepareShotReferences } from './keyframe';
import { sceneReferenceOf } from './shot';
import { commitTake, finishTake } from './take-finish';

/** Segments of a sequence checked at the same time (docs/design/multi-shot.md#splitting-and-verification). */
const SEGMENT_CHECKS_AT_ONCE = 4;

interface Segment {
  local: string;
  frames: string[];
  report: ConsistencyReport;
  model: string;
  taskId: string;
  prompt: string;
  seed: number;
  cut: 'detected' | 'planned';
}

/** Cut times of a render with the footage analysis' scene filter (docs/design/multi-shot.md#splitting-and-verification). */
async function detectCuts(deps: HandlerDeps, local: string, durationSec: number, signal: AbortSignal) {
  const log = await deps.ff.run(analysisCommand(local, { hasVideo: true, hasAudio: false }), {
    signal,
    logLevel: 'info',
  });
  return parseAnalysisLog(log, durationSec)
    .scenes.slice(1)
    .map((s) => s.start);
}

/**
 * `shot.group` (docs/design/multi-shot.md): consecutive shots rendered by a multi-shot model in one request, split
 * at the cuts, each segment checked like a single take of its own shot (R4, the quality checks, its lines heard) and
 * finished as that shot's take. A voiced or checked group is rendered once and its failing shots are made again alone.
 */
export async function shotGroup(deps: HandlerDeps, ctx: JobContext) {
  const { clipId, shotIds } = ctx.job.params as { clipId: string; shotIds: string[] };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  const shots = shotIds.map((id) => {
    const s = clip.shots.find((x) => x.id === id);
    if (!s) throw notFound(`shot ${id}`);
    return s;
  });
  if (shots.length < 2) throw invalid('a group needs at least two shots');
  if (shots.every((s) => s.takes.some((t) => t.jobId === ctx.job.id)))
    return { reused: true, shots: shots.length };
  assertCastReady(shots, docs.characters, docs.elements);
  assertVoicesReady(deps, shots, docs.characters, docs.project.settings);
  const settings = docs.project.settings;
  const judge = settings.consistency.judge === 'off' ? deps.offJudge : deps.judge;
  const { threshold, maxAttempts } = settings.consistency;
  const ctxs: ShotContext[] = shots.map((shot) => shotContextOf(shot, docs, clip));
  // The sequence carries the model's own voices like a single take (docs/design/multi-shot.md#request)
  const voiced = (settings.dialogue?.mode ?? 'off') === 'off' && settings.generation.includeAudio === true;
  const qualityChecks = settings.consistency.qualityChecks === true;
  const listen = qualityChecks && !!deps.llm.omni && voiced;
  // A voiced or checked sequence is rendered once; its failing shots are made again alone
  const renders = voiced || qualityChecks ? 1 : maxAttempts;
  const castOnly = settings.consistency.castOnly === true;
  const place = docs.screenplay?.scenes.find((s) => s.id === clip.sceneId)?.location ?? '';
  const label = (s: Shot) => `c${clip.index + 1}-s${s.index + 1}`;
  await markShots(deps, ctx, clipId, shotIds, 'generating', null);
  try {
    return await deps.media.withTmpDir(async (dir) => {
      const [imageLimits, videoLimits] = await Promise.all([
        deps.gateway.limitsFor('image', settings.models.image),
        deps.gateway.limitsFor('video', settings.models.video),
      ]);
      // The union of the group's cast and elements, one reference set for the whole sequence (R3).
      const union: Shot = {
        ...shots[0]!,
        characterIds: [...new Set(shots.flatMap((s) => s.characterIds))],
        elementIds: [...new Set(shots.flatMap((s) => s.elementIds))],
        wardrobe: Object.assign({}, ...shots.map((s) => s.wardrobe)),
      };
      const unionCharacters = orderedShotCharacters(union, docs.characters);
      const unionElements = orderedShotElements(union, docs.elements);
      const judgedElements = settings.consistency.judgeElements ? unionElements : [];
      const refs = await prepareShotReferences(deps, ctx, {
        shot: union,
        characters: unionCharacters,
        elements: unionElements,
        judgedElements,
        maxInputImages: imageLimits.limits?.max_input_images,
        dir,
      });
      const taskIds: string[] = [];
      const keyframeTaskIds: string[] = [];
      // The first shot's start frame: its approved storyboard frame, or a verified keyframe.
      const first = shots[0]!;
      let keyframe = first.board && boardState(first, docs) === 'approved' ? first.board.keyframe : null;
      let keyframeReport: ConsistencyReport | null = keyframe ? first.board!.consistency : null;
      if (!keyframe && settings.generation.keyframes) {
        const kf = await generateKeyframe(deps, ctx, {
          shotCtx: ctxs[0]!,
          refs,
          judge,
          judgedElements: settings.consistency.judgeElements ? (ctxs[0]!.elements ?? []) : [],
          threshold,
          maxAttempts,
          name: `${label(first)}-group`,
          step: 'keyframe',
          progress: (attempt) => ctx.progress(0.05, 1, `keyframe attempt ${attempt + 1}/${maxAttempts}`),
        });
        taskIds.push(...kf.taskIds);
        keyframeTaskIds.push(...kf.taskIds);
        keyframe = kf.keyframe;
        keyframeReport = kf.report;
        if (kf.report?.status === 'failed') {
          // Never spend the group's render on an unverified identity: the evidence stays on the first shot.
          await commitTake(deps, ctx, clipId, first.id, {
            keyframe,
            video: null,
            lastFrame: null,
            report: { ...kf.report, note: 'keyframe failed the consistency gate; no video generated' },
            request: {
              imageModel: kf.imageModel,
              prompt: kf.prompt,
              seed: kf.seed,
              durationSec: first.durationSec,
              firstFrameSource: 'none',
              referenceCount: refs.referenceUris.length,
              lastFrameSource: null,
              motionReference: null,
              multiShot: null,
            },
            taskIds,
            characters: ctxs[0]!.characters,
            elements: ctxs[0]!.elements ?? [],
            audio: null,
            variation: 0,
          });
          await markShots(deps, ctx, clipId, shotIds.slice(1), 'planned', 'the group keyframe failed');
          return { status: 'failed', stage: 'keyframe' };
        }
      }
      const firstFrameUri = keyframe ? await deps.media.pngDataUri(projectId, keyframe, 1920) : undefined;
      const planned = shots.map((s) => s.durationSec);
      // Each segment's place and light are judged against the scene's first shot, as a single take's are
      const sceneReferences = await Promise.all(
        shots.map(async (shot) => {
          const media =
            qualityChecks && promptVersionOf(settings) >= 2 ? sceneReferenceOf(clip, shot, docs) : null;
          return media ? deps.media.pngBuffer(projectId, media, 512) : undefined;
        }),
      );
      // A render whose every shot passes is used whole (continuity across its cuts); otherwise every shot keeps
      // its best segment over the attempts.
      const best: (Segment | null)[] = shots.map(() => null);
      let chosen: Segment[] | null = null;
      for (let attempt = 0; attempt < renders; attempt++) {
        throwIfAborted(ctx.signal);
        ctx.progress(0.3 + (0.5 * attempt) / renders, 1, `sequence attempt ${attempt + 1}/${renders}`);
        const req = compileMultiShotRequest(ctxs, {
          firstFrameUri,
          referenceUris: refs.referenceUris,
          attempt,
          model: settings.models.video,
          limits: videoLimits.limits,
          includeAudio: voiced,
        });
        const task = await deps.gateway.generateVideo(req, gatewayOptions(ctx, 'video', 'sequence', attempt));
        taskIds.push(task.id);
        const raw = join(dir, `sequence-${attempt}.mp4`);
        await deps.media.downloadTo(task.outputs![0]!.uri, raw, ctx.signal);
        const rawProbe = await deps.ff.probe(raw);
        const total = rawProbe.durationSec || planned.reduce((n, d) => n + d, 0);
        // Each segment keeps its part of the sound
        const sound = voiced && rawProbe.hasAudio;
        const { boundaries, cut } = multiShotBoundaries(
          await detectCuts(deps, raw, total, ctx.signal),
          planned,
          total,
        );
        // A cut's time is its new shot's first frame, rounded to the millisecond (10.042 for 10.0417): a segment
        // ends, and the next begins, half a frame earlier, so neither holds a frame of the other shot
        const half = 0.5 / (rawProbe.fps || 30);
        // Cut every segment, then check them four at a time: each check waits on the judge and the listener
        const cuts = shots.map((_, k) => ({
          local: join(dir, `seq-${attempt}-shot-${k}.mp4`),
          from: k > 0 ? Math.max(0, boundaries[k]! - half) : 0,
          to: k < shots.length - 1 ? boundaries[k + 1]! - half : boundaries[k + 1]!,
        }));
        for (const { local, from, to } of cuts)
          await deps.ff.run(
            [
              '-ss',
              from.toFixed(3),
              '-i',
              raw,
              '-t',
              (to - from).toFixed(3),
              ...(sound ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-crf',
              '18',
              '-pix_fmt',
              'yuv420p',
              local,
            ],
            { signal: ctx.signal },
          );
        const text = req.input[0]?.type === 'text' ? (req.input[0] as { text: string }).text : '';
        const checking = new Semaphore(SEGMENT_CHECKS_AT_ONCE);
        const segments = await Promise.all(
          shots.map(async (shot, k): Promise<Segment> => {
            await checking.acquire();
            try {
              const { local, from, to } = cuts[k]!;
              const shotCtx = ctxs[k]!;
              // Checked like a single take (docs/design/continuity.md#quality-checks-in-the-gate): its own jumps, and
              // its lines heard while the judge looks at its frames
              const temporal = qualityChecks
                ? temporalVerdict(await sceneChanges(deps.ff, local, { signal: ctx.signal }))
                : null;
              const heard =
                listen && sound
                  ? checkSound({
                      llm: deps.llm,
                      ff: deps.ff,
                      video: local,
                      clip: join(dir, `seq-${attempt}-sound-${k}.mp4`),
                      shot,
                      characters: docs.characters,
                      place,
                      voiced,
                      musicAllowed: settings.generation.modelMusic === true,
                      rejectMusic: settings.consistency.rejectMusic === true,
                      metrics: deps.metrics,
                      log: ctx.log,
                      signal: ctx.signal,
                    }).catch(() => null)
                  : null;
              const frames = await sampleFrames(deps.ff, local, to - from, dir, `seq-${attempt}-${k}`, {
                maxWidth: 512,
                signal: ctx.signal,
              });
              let report = await verifyFrames({
                judge,
                shot,
                characters: shotCtx.characters,
                references: refs.judgeRefs,
                elements: settings.consistency.judgeElements ? (shotCtx.elements ?? []) : [],
                elementReferences: refs.elementJudgeRefs,
                frames: await Promise.all(frames.map((f) => readFile(f))),
                frameRefs: [],
                threshold,
                attempts: attempt + 1,
                metrics: deps.metrics,
                log: ctx.log,
                signal: ctx.signal,
                ...(qualityChecks
                  ? {
                      quality: {
                        threshold: settings.consistency.qualityThreshold,
                        sceneReference: sceneReferences[k],
                        temporal,
                        absent: absentCast(shotCtx.offscreen, docs.characters),
                        castOnly,
                      },
                    }
                  : {}),
              });
              if (heard) report = withSoundVerdict(report, await heard);
              else if (listen && !sound && spokenLines(shot, docs.characters).length)
                report = withSoundVerdict(report, silentTakeVerdict(spokenLines(shot, docs.characters)));
              return {
                local,
                frames,
                report,
                model: task.model,
                taskId: task.id,
                prompt: text,
                seed: req.parameters?.seed ?? 0,
                cut,
              };
            } finally {
              checking.release();
            }
          }),
        );
        // Identity first, then the quality checks, then the score, as for a single take
        for (const [k, segment] of segments.entries())
          if (betterAttempt(segment.report, best[k]?.report ?? null)) best[k] = segment;
        if (segments.every((s) => attemptDone(s.report))) {
          chosen = segments;
          break;
        }
        ctx.log.info(
          { attempt, failed: segments.flatMap((s, k) => (attemptDone(s.report) ? [] : [k])) },
          'a shot of the multi-shot render failed its checks',
        );
      }
      const final = chosen ?? best.map((s) => s!);
      const startSource =
        keyframe && first.board?.keyframe.hash === keyframe.hash ? 'storyboard' : 'keyframe';
      // Every shot keeps its best segment as a take (watermark, C2PA, poster, last frame).
      let passed = 0;
      for (const [k, shot] of shots.entries()) {
        const seg = final[k]!;
        const shotCtx = ctxs[k]!;
        const spoken =
          settings.dialogue.mode === 'tts'
            ? await speakLines(deps, ctx, {
                shot,
                characters: docs.characters,
                settings,
                dir,
                name: label(shot),
              })
            : null;
        const done = await finishTake(deps, ctx, {
          local: seg.local,
          frames: seg.frames,
          dir,
          name: label(shot),
          title: docs.project.title,
          clipId,
          shotId: shot.id,
          models: { videoModel: seg.model || undefined },
          report: seg.report,
          keyframe: k === 0 ? keyframe : null,
          fallbackDurationSec: shot.durationSec,
        });
        await commitTake(deps, ctx, clipId, shot.id, {
          id: done.takeId,
          keyframe: k === 0 ? keyframe : null,
          video: done.video,
          lastFrame: done.lastFrame,
          report: {
            ...seg.report,
            frames: k === 0 && keyframeReport ? [...keyframeReport.frames, ...done.frames] : done.frames,
          },
          request: {
            videoModel: seg.model || undefined,
            prompt: seg.prompt,
            seed: seg.seed,
            durationSec: done.video.durationSec ?? shot.durationSec,
            firstFrameSource: k === 0 && keyframe ? startSource : 'none',
            referenceCount: refs.referenceUris.length,
            lastFrameSource: null,
            motionReference: null,
            multiShot: { index: k, of: shots.length, cut: seg.cut },
          },
          // the first shot also lists its keyframe generations
          taskIds: k === 0 ? [...keyframeTaskIds, seg.taskId] : [seg.taskId],
          watermarkId: done.watermarkId,
          contentCredentials: done.contentCredentials,
          characters: shotCtx.characters,
          elements: shotCtx.elements ?? [],
          audio: spoken
            ? takeAudio(
                {
                  mode: 'tts',
                  lines: spoken.lines,
                  mix: spoken.mix,
                  referenceAudioUris: [],
                  conditioned: false,
                  durationSec: spoken.durationSec,
                  voiceLocks: spoken.voiceLocks,
                  speakers: [],
                  judgeLines: [],
                },
                'none',
              )
            : null,
          variation: 0,
        });
        if (attemptDone(seg.report)) passed++;
        deps.metrics.sequenceSegments.inc({ outcome: attemptDone(seg.report) ? 'passed' : 'failed' });
      }
      // A shot whose segment failed is made again alone; its new take replaces the segment only when it passes
      // (docs/design/multi-shot.md#splitting-and-verification)
      const remake =
        renders === 1 && maxAttempts > 1
          ? shots.flatMap((shot, k) => (attemptDone(final[k]!.report) ? [] : [{ shot, segment: final[k]! }]))
          : [];
      if (remake.length) {
        ctx.progress(0.95, 1, `${passed}/${shots.length} shots passed; ${remake.length} made again alone`);
        const jobs: Job[] = [];
        for (const { shot, segment } of remake) {
          // From the segment's first frame, which has the sequence's look, unless its identity failed
          const start = join(dir, `${label(shot)}-start.png`);
          const startFrame =
            segment.report.status === 'failed'
              ? null
              : await deps.media.putFile(
                  projectId,
                  await extractFrame(deps.ff, segment.local, 0, start, undefined, ctx.signal),
                  { kind: 'keyframes', name: `${label(shot)}-sequence`, mime: 'image/png', probe: false },
                );
          jobs.push(
            await ctx.spawn(
              'shot.generate',
              { clipId, shotId: shot.id, selectIfPasses: true, ...(startFrame ? { startFrame } : {}) },
              { dedupeKey: `shot:${shot.id}` },
            ),
          );
        }
        await ctx.waitFor(jobs.map((j) => j.id));
      }
      ctx.progress(1, 1, `${passed}/${shots.length} shots passed`);
      return { shots: shots.length, passed, remade: remake.length, tasks: taskIds.length };
    });
  } catch (err) {
    await markShots(
      deps,
      ctx,
      clipId,
      shotIds,
      ctx.signal.aborted ? 'planned' : 'failed',
      ctx.signal.aborted ? 'cancelled' : err instanceof Error ? err.message.slice(0, 2000) : String(err),
    ).catch(() => undefined);
    throw err;
  }
}

async function markShots(
  deps: HandlerDeps,
  ctx: JobContext,
  clipId: string,
  shotIds: string[],
  status: Shot['status'],
  error: string | null,
) {
  await commitAs(
    deps,
    ctx,
    (tx) => {
      const c = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
      for (const s of c.shots) {
        if (!shotIds.includes(s.id)) continue;
        if (status !== 'generating' && s.takes.some((t) => t.jobId === ctx.job.id)) continue;
        s.status = status === 'planned' && s.takes.length ? 'needs_review' : status;
        s.lastError = error;
      }
      c.status = clipStatusOf(c);
      tx.set(docPath.clip(clipId), c);
    },
    `${status === 'generating' ? 'Generate' : 'Stop'} shots ${shotIds.map((id) => id.slice(-4)).join(', ')} of clip ${clipId.slice(-4)} as one sequence`,
  );
}

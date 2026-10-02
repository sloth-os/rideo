import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  boardState,
  type Clip,
  type ConsistencyReport,
  compileKeyframeRequest,
  compileVideoRequest,
  docPath,
  isAcceptable,
  type MediaRef,
  orderedShotCharacters,
  orderedShotElements,
  type Shot,
  type ShotContext,
  type Take,
  type TakeAudio,
  takeState,
} from '@rideo/shared';
import { verifyFrames } from '../../consistency/gate';
import { verifyVoices } from '../../consistency/voice';
import {
  assertCastReady,
  assertDirectingResources,
  assertVoicesReady,
  clipStatusOf,
} from '../../domain/clips';
import { performanceModel } from '../../domain/performance';
import { notFound } from '../../errors';
import { sampleFrames } from '../../media/frames';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, gatewayOptions, type HandlerDeps } from './common';
import { lipSyncPass, prepareDialogue, takeAudio, takeAudioWav } from './dialogue';
import { generateKeyframe, prepareShotReferences } from './keyframe';
import { type PreparedPerformance, preparePerformance, withPerformanceSound } from './performance';
import { commitTake, finishTake } from './take-finish';

interface Candidate {
  local: string;
  report: ConsistencyReport;
  frames: string[];
  model: string;
  taskId: string;
}

function label(clip: Clip, shot: Shot): string {
  return `c${clip.index + 1}-s${shot.index + 1}`;
}

/**
 * The shot pipeline (docs/design/generation-pipeline.md#shot-pipeline) enforcing the consistency rules
 * R1 (locks), R3 (deterministic conditioning), R4 (judge gate with retries), R5 (continuity) and R9.
 */
export async function shotGenerate(deps: HandlerDeps, ctx: JobContext) {
  const {
    clipId,
    shotId,
    variation = 0,
  } = ctx.job.params as {
    clipId: string;
    shotId: string;
    variation?: number;
  };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  const shot = clip.shots.find((s) => s.id === shotId);
  if (!shot) throw notFound(`shot ${shotId}`);
  const existing = shot.takes.find((t) => t.jobId === ctx.job.id);
  if (existing) return { takeId: existing.id, status: existing.consistency.status, reused: true };
  // Directing controls (docs/design/directing.md): frames and motion references are project resources.
  assertDirectingResources(shot, (id) => (id ? (docs.resources[id] ?? null) : null));
  assertCastReady([shot], docs.characters, docs.elements);
  assertVoicesReady(deps, [shot], docs.characters, docs.project.settings);

  const characters = orderedShotCharacters(shot, docs.characters);
  // The shot's location, props and styles (docs/design/elements.md): conditioned always, judged when configured.
  const elements = orderedShotElements(shot, docs.elements);
  const settings = docs.project.settings;
  const judgedElements = settings.consistency.judgeElements ? elements : [];
  const judge = settings.consistency.judge === 'off' ? deps.offJudge : deps.judge;
  const { threshold, maxAttempts } = settings.consistency;
  const name = label(clip, shot);

  await commitAs(
    deps,
    ctx,
    (tx) => {
      const c = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
      const s = c.shots.find((x) => x.id === shotId);
      if (!s) throw notFound(`shot ${shotId}`);
      s.status = 'generating';
      s.lastError = null;
      if (c.status === 'approved') {
        c.approvedAt = null;
        c.approvedBy = null;
        c.status = 'review';
      }
      c.status = clipStatusOf(c);
      tx.set(docPath.clip(clipId), c);
    },
    `Generate shot ${name}`,
  );

  try {
    return await deps.media.withTmpDir(async (dir) => {
      ctx.progress(0.02, 1, 'preparing references');
      // A performance (docs/design/performance.md): the performance model acts it from the shot's first frame.
      const performance = shot.motionReference?.mode === 'performance' ? shot.motionReference : null;
      const videoModel = performance
        ? await performanceModel(deps, settings.models.performance)
        : settings.models.video;
      const [imageLimits, videoLimits] = await Promise.all([
        deps.gateway.limitsFor('image', settings.models.image),
        deps.gateway.limitsFor('video', videoModel),
      ]);
      const refs = await prepareShotReferences(deps, ctx, {
        shot,
        characters,
        elements,
        judgedElements,
        maxInputImages: imageLimits.limits?.max_input_images,
        dir,
      });
      const { referenceUris, judgeRefs, elementJudgeRefs } = refs;
      const shotCtx: ShotContext = { shot, characters, elements, screenplay: docs.screenplay, settings };

      // R5: continuity chaining from the previous shot's passing take.
      let firstFrame: { uri: string; source: Take['request']['firstFrameSource'] } | null = null;
      if (shot.continuity === 'continuous') {
        const prev = clip.shots.find((s) => s.index === shot.index - 1);
        const prevTake = prev?.takes.find((t) => t.id === prev.selectedTakeId);
        if (
          prev &&
          prevTake?.lastFrame &&
          isAcceptable(takeState(prevTake, prev, docs.characters, docs.elements))
        ) {
          firstFrame = {
            uri: await deps.media.pngDataUri(projectId, prevTake.lastFrame, 1920),
            source: 'previous_shot',
          };
        }
      }

      let keyframeRef: MediaRef | null = null;
      let keyframeReport: ConsistencyReport | null = null;
      let imageModel: string | undefined;
      const taskIds: string[] = [];
      const resourceUri = async (id: string, image: boolean) => {
        const r = docs.resources[id]!;
        return image
          ? deps.media.pngDataUri(projectId, r.media, 1920)
          : deps.media.dataUri(projectId, r.media);
      };
      // A start frame chosen by the director wins over continuity, the board and the keyframe.
      if (shot.startFrame.mode === 'resource' && shot.startFrame.resourceId)
        firstFrame = { uri: await resourceUri(shot.startFrame.resourceId, true), source: 'resource' };
      // An approved, current storyboard frame is the first frame: no second image generation
      // (docs/design/storyboard.md#video-pass).
      if (!firstFrame && shot.board && boardState(shot, docs) === 'approved') {
        keyframeRef = shot.board.keyframe;
        keyframeReport = shot.board.consistency;
        imageModel = shot.board.request.imageModel;
        firstFrame = { uri: await deps.media.pngDataUri(projectId, keyframeRef, 1920), source: 'storyboard' };
      }
      if (!firstFrame && settings.generation.keyframes) {
        const kf = await generateKeyframe(deps, ctx, {
          shotCtx,
          refs,
          judge,
          judgedElements,
          threshold,
          maxAttempts,
          name,
          step: 'keyframe',
          variation,
          progress: (attempt) =>
            ctx.progress(
              0.05 + (0.3 * attempt) / maxAttempts,
              1,
              `keyframe attempt ${attempt + 1}/${maxAttempts}`,
            ),
        });
        keyframeRef = kf.keyframe;
        keyframeReport = kf.report;
        imageModel = kf.imageModel;
        taskIds.push(...kf.taskIds);
        if (keyframeReport?.status === 'failed') {
          // Never spend a video generation on an unverified identity: save the evidence for review.
          const kfRequest = compileKeyframeRequest(shotCtx, {
            referenceUris: [],
            attempt: maxAttempts - 1,
            variation,
          });
          const take = await commitTake(deps, ctx, clipId, shotId, {
            keyframe: keyframeRef,
            video: null,
            lastFrame: null,
            report: { ...keyframeReport, note: 'keyframe failed the consistency gate; no video generated' },
            request: {
              imageModel,
              prompt: (kfRequest.input[0] as { text: string }).text,
              seed: kfRequest.parameters?.seed ?? 0,
              durationSec: shot.durationSec,
              firstFrameSource: 'none',
              referenceCount: referenceUris.length,
              lastFrameSource: null,
              motionReference: null,
              multiShot: null,
            },
            taskIds,
            characters,
            elements,
            audio: null,
            variation,
          });
          return { takeId: take.id, status: 'failed', stage: 'keyframe' };
        }
        firstFrame = keyframeRef
          ? { uri: await deps.media.pngDataUri(projectId, keyframeRef, 1920), source: 'keyframe' }
          : null;
      }

      // The end frame (docs/design/directing.md): generated and verified like the start keyframe (R4), or a resource.
      let endFrameInput: { uri: string; source: 'generated' | 'resource' } | null = null;
      let endKeyframe: MediaRef | null = null;
      const lastFrameAccepted = videoLimits.limits?.supports_last_frame !== false;
      if (shot.endFrame.mode === 'resource' && shot.endFrame.resourceId && lastFrameAccepted)
        endFrameInput = { uri: await resourceUri(shot.endFrame.resourceId, true), source: 'resource' };
      if (shot.endFrame.mode === 'generate' && lastFrameAccepted) {
        const endCtx: ShotContext = {
          ...shotCtx,
          shot: { ...shot, description: shot.endFrame.description, promptOverride: null },
        };
        const end = await generateKeyframe(deps, ctx, {
          shotCtx: endCtx,
          refs,
          judge,
          judgedElements,
          threshold,
          maxAttempts,
          name: `${name}-end`,
          step: 'end-keyframe',
          variation: variation + 50,
          progress: (attempt) => ctx.progress(0.3, 1, `end frame attempt ${attempt + 1}/${maxAttempts}`),
        });
        taskIds.push(...end.taskIds);
        endKeyframe = end.keyframe;
        if (end.report?.status === 'failed') {
          const take = await commitTake(deps, ctx, clipId, shotId, {
            keyframe: keyframeRef,
            endKeyframe,
            video: null,
            lastFrame: null,
            report: { ...end.report, note: 'end frame failed the consistency gate; no video generated' },
            request: {
              imageModel: end.imageModel ?? imageModel,
              prompt: end.prompt,
              seed: end.seed,
              durationSec: shot.durationSec,
              firstFrameSource: firstFrame?.source ?? 'none',
              referenceCount: referenceUris.length,
              lastFrameSource: 'generated',
              motionReference: null,
              multiShot: null,
            },
            taskIds,
            characters,
            elements,
            audio: null,
            variation,
          });
          return { takeId: take.id, status: 'failed', stage: 'end-keyframe' };
        }
        if (endKeyframe)
          endFrameInput = {
            uri: await deps.media.pngDataUri(projectId, endKeyframe, 1920),
            source: 'generated',
          };
      }
      if (shot.endFrame.mode !== 'none' && !lastFrameAccepted)
        ctx.log.warn(
          { model: videoLimits.model },
          'the video model takes no last frame; the end frame is not used',
        );
      // The motion reference, when the model accepts reference videos.
      const motionReference =
        shot.motionReference && videoLimits.limits?.supports_reference_video !== false
          ? shot.motionReference
          : null;
      // A performance is normalized and trimmed to the shot; the performer speaks the lines (no dialogue voices).
      const performed: PreparedPerformance | null = performance
        ? await preparePerformance(deps, ctx, {
            resource: docs.resources[performance.resourceId]!,
            maxSec: shot.durationSec,
            fps: settings.fps,
            dir,
          })
        : null;
      const referenceVideoUri = performed
        ? performed.uri
        : motionReference
          ? await resourceUri(motionReference.resourceId, false)
          : undefined;

      // Dialogue (docs/design/dialogue.md): TTS lines and their mix, or the speakers' samples for native audio.
      const dialogue = performed
        ? null
        : await prepareDialogue(deps, ctx, {
            shot,
            characters: docs.characters,
            settings,
            videoLimits: videoLimits.limits,
            dir,
            name,
          });
      const videoOpts = (attempt: number) => ({
        firstFrameUri: firstFrame?.uri,
        lastFrameUri: endFrameInput?.uri,
        referenceVideoUri,
        variation,
        referenceUris,
        attempt,
        model: videoModel,
        limits: videoLimits.limits,
        ...(dialogue
          ? {
              referenceAudioUris: dialogue.referenceAudioUris,
              // TTS takes are heard through the mix; the model renders sound only when the mix drives it.
              includeAudio: dialogue.mode === 'native' || dialogue.conditioned,
              durationSec: dialogue.durationSec,
            }
          : {}),
        // The take lasts the performance when it is shorter than the shot; its sound is muxed on afterwards
        ...(performed
          ? {
              includeAudio: false,
              durationSec: Math.max(1, Math.min(shot.durationSec, performed.durationSec)),
            }
          : {}),
      });
      const judgeVoices = dialogue?.mode === 'native' && settings.consistency.judgeVoices;

      let best: Candidate | null = null;
      let videoReq = compileVideoRequest(shotCtx, videoOpts(0));
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        throwIfAborted(ctx.signal);
        ctx.progress(0.35 + (0.45 * attempt) / maxAttempts, 1, `video attempt ${attempt + 1}/${maxAttempts}`);
        videoReq = compileVideoRequest(shotCtx, videoOpts(attempt));
        const task = await deps.gateway.generateVideo(
          videoReq,
          gatewayOptions(ctx, 'video', 'video', attempt),
        );
        taskIds.push(task.id);
        // The raw (unwatermarked) generation stays in the temp dir; only the watermarked take is stored.
        const raw = join(dir, `raw-${attempt}.mp4`);
        await deps.media.downloadTo(task.outputs![0]!.uri, raw, ctx.signal);
        const probe = await deps.ff.probe(raw);
        ctx.progress(0.8, 1, 'verifying identity');
        const framePaths = await sampleFrames(
          deps.ff,
          raw,
          probe.durationSec || shot.durationSec,
          dir,
          `f${attempt}`,
          { maxWidth: 512, signal: ctx.signal },
        );
        const frameBufs = await Promise.all(framePaths.map((p) => readFile(p)));
        let report = await verifyFrames({
          judge,
          shot,
          characters,
          references: judgeRefs,
          elements: judgedElements,
          elementReferences: elementJudgeRefs,
          frames: frameBufs,
          frameRefs: [],
          threshold,
          attempts: attempt + 1,
          metrics: deps.metrics,
          log: ctx.log,
          signal: ctx.signal,
        });
        if (judgeVoices && dialogue) {
          // Rule V4: the speakers must sound like their locked voices.
          ctx.progress(0.82, 1, 'checking the voices');
          report = await verifyVoices({
            judge: deps.voiceJudge,
            report,
            speakers: dialogue.speakers,
            audio: await takeAudioWav(deps, raw, dir, `a${attempt}`, ctx.signal),
            lines: dialogue.judgeLines,
            threshold,
            metrics: deps.metrics,
            log: ctx.log,
            signal: ctx.signal,
          });
        }
        const candidate: Candidate = {
          local: raw,
          report,
          frames: framePaths,
          model: task.model,
          taskId: task.id,
        };
        if (!best || report.score > best.report.score || report.status !== 'failed') best = candidate;
        if (report.status !== 'failed') break;
        ctx.log.info({ attempt, score: report.score }, 'video failed the consistency gate');
      }
      let final = best!;
      let lipSync: TakeAudio['lipSync'] = dialogue?.conditioned ? 'conditioned' : 'none';
      if (
        dialogue?.mode === 'tts' &&
        dialogue.mix &&
        !dialogue.conditioned &&
        settings.dialogue.lipSync &&
        final.report.status !== 'failed' &&
        shot.characterIds.some((id) => dialogue.voiceLocks[id] !== undefined)
      ) {
        // The model could not take the mix: a lip-sync pass re-renders the take, judged again (R4).
        ctx.progress(0.86, 1, 'lip sync');
        const synced = await lipSyncPass(deps, ctx, {
          video: final.local,
          mixUri: dialogue.mix.uri,
          settings,
          dir,
          attempt: 0,
        });
        if (synced) {
          taskIds.push(synced.taskId);
          const probe = await deps.ff.probe(synced.path);
          const framePaths = await sampleFrames(
            deps.ff,
            synced.path,
            probe.durationSec || shot.durationSec,
            dir,
            'lipsync',
            { maxWidth: 512, signal: ctx.signal },
          );
          const report = await verifyFrames({
            judge,
            shot,
            characters,
            references: judgeRefs,
            elements: judgedElements,
            elementReferences: elementJudgeRefs,
            frames: await Promise.all(framePaths.map((p) => readFile(p))),
            frameRefs: [],
            threshold,
            attempts: final.report.attempts,
            metrics: deps.metrics,
            log: ctx.log,
            signal: ctx.signal,
          });
          if (report.status !== 'failed') {
            final = { ...final, local: synced.path, report, frames: framePaths };
            lipSync = 'pass';
          } else {
            ctx.log.info(
              { score: report.score },
              'lip-synced take failed the consistency gate; keeping the first render',
            );
          }
        }
      }

      if (performed) {
        if (performed.hasAudio)
          final = {
            ...final,
            local: await withPerformanceSound(deps, ctx, { video: final.local, performance: performed, dir }),
          };
        deps.metrics.performanceTakes.inc({
          outcome: final.report.status === 'failed' ? 'failed' : 'passed',
        });
        ctx.log.info({ model: final.model, score: final.report.score }, 'performance take');
      }

      // Watermark (single re-encode), poster, last frame, evidence frames, provenance.
      const done = await finishTake(deps, ctx, {
        local: final.local,
        frames: final.frames,
        dir,
        name,
        title: docs.project.title,
        clipId,
        shotId,
        models: { imageModel, videoModel: final.model || undefined },
        report: final.report,
        keyframe: keyframeRef,
        fallbackDurationSec: shot.durationSec,
      });
      const { takeId, video, lastFrame, frames, watermarkId, contentCredentials } = done;
      const prompt = videoReq.input[0]?.type === 'text' ? (videoReq.input[0] as { text: string }).text : '';
      const take = await commitTake(deps, ctx, clipId, shotId, {
        id: takeId,
        keyframe: keyframeRef,
        video,
        lastFrame,
        report: { ...final.report, frames: keyframeReport ? [...keyframeReport.frames, ...frames] : frames },
        request: {
          imageModel,
          videoModel: final.model || undefined,
          prompt,
          seed: videoReq.parameters?.seed ?? 0,
          durationSec: videoReq.parameters?.duration_seconds ?? shot.durationSec,
          firstFrameSource: firstFrame?.source ?? 'none',
          referenceCount: referenceUris.length,
          lastFrameSource: endFrameInput?.source ?? null,
          motionReference,
          multiShot: null,
        },
        taskIds,
        watermarkId,
        contentCredentials,
        characters,
        elements,
        audio: dialogue ? takeAudio(dialogue, lipSync) : null,
        endKeyframe,
        variation,
      });
      ctx.progress(1, 1, `take ${final.report.status}`);
      return { takeId: take.id, status: final.report.status, score: final.report.score };
    });
  } catch (err) {
    if (shot.motionReference?.mode === 'performance' && !ctx.signal.aborted)
      deps.metrics.performanceTakes.inc({ outcome: 'error' });
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const c = structuredClone(tx.get<Clip>(docPath.clip(clipId)));
        const s = c?.shots.find((x) => x.id === shotId);
        if (!c || !s) return;
        s.status = ctx.signal.aborted ? (s.takes.length ? 'needs_review' : 'planned') : 'failed';
        s.lastError = ctx.signal.aborted
          ? 'cancelled'
          : err instanceof Error
            ? err.message.slice(0, 2000)
            : String(err);
        c.status = clipStatusOf(c);
        tx.set(docPath.clip(clipId), c);
      },
      `Shot ${name} ${ctx.signal.aborted ? 'cancelled' : 'failed'}`,
    ).catch(() => undefined);
    throw err;
  }
}

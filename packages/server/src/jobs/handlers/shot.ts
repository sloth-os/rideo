import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  boardState,
  type Character,
  type Clip,
  type ConsistencyReport,
  type ContentCredentialsStamp,
  compileKeyframeRequest,
  compileVideoRequest,
  docPath,
  type Element,
  isAcceptable,
  type MediaRef,
  newId,
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
import { assertCastReady, assertVoicesReady, clipStatusOf } from '../../domain/clips';
import { notFound } from '../../errors';
import { extractLastFrame, sampleFrames } from '../../media/frames';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, gatewayOptions, type HandlerDeps, withPoster } from './common';
import { lipSyncPass, prepareDialogue, takeAudio, takeAudioWav } from './dialogue';
import { generateKeyframe, prepareShotReferences } from './keyframe';

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
  const { clipId, shotId } = ctx.job.params as { clipId: string; shotId: string };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  const shot = clip.shots.find((s) => s.id === shotId);
  if (!shot) throw notFound(`shot ${shotId}`);
  const existing = shot.takes.find((t) => t.jobId === ctx.job.id);
  if (existing) return { takeId: existing.id, status: existing.consistency.status, reused: true };
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
      const [imageLimits, videoLimits] = await Promise.all([
        deps.gateway.limitsFor('image', settings.models.image),
        deps.gateway.limitsFor('video', settings.models.video),
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

      // An approved, current storyboard frame is the first frame: no second image generation
      // (docs/design/storyboard.md#video-pass).
      let keyframeRef: MediaRef | null = null;
      let keyframeReport: ConsistencyReport | null = null;
      let imageModel: string | undefined;
      const taskIds: string[] = [];
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
          const kfRequest = compileKeyframeRequest(shotCtx, { referenceUris: [], attempt: maxAttempts - 1 });
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
            },
            taskIds,
            characters,
            elements,
            audio: null,
          });
          return { takeId: take.id, status: 'failed', stage: 'keyframe' };
        }
        firstFrame = keyframeRef
          ? { uri: await deps.media.pngDataUri(projectId, keyframeRef, 1920), source: 'keyframe' }
          : null;
      }

      // Dialogue (docs/design/dialogue.md): TTS lines and their mix, or the speakers' samples for native audio.
      const dialogue = await prepareDialogue(deps, ctx, {
        shot,
        characters: docs.characters,
        settings,
        videoLimits: videoLimits.limits,
        dir,
        name,
      });
      const videoOpts = (attempt: number) => ({
        firstFrameUri: firstFrame?.uri,
        referenceUris,
        attempt,
        model: settings.models.video,
        limits: videoLimits.limits,
        ...(dialogue
          ? {
              referenceAudioUris: dialogue.referenceAudioUris,
              // TTS takes are heard through the mix; the model renders sound only when the mix drives it.
              includeAudio: dialogue.mode === 'native' || dialogue.conditioned,
              durationSec: dialogue.durationSec,
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

      // Watermark (single re-encode), proxy, last frame, evidence frames, provenance.
      throwIfAborted(ctx.signal);
      ctx.progress(0.9, 1, 'watermarking');
      const takeId = newId('take');
      const watermarkId = settings.watermark.enabled ? await deps.watermark.allocateId() : null;
      const marked = join(dir, 'take.mp4');
      if (watermarkId) {
        await deps.watermark.embedVideo(final.local, marked, {
          id: watermarkId,
          title: `${docs.project.title} · ${name}`,
          crf: 18,
          preset: 'veryfast',
          signal: ctx.signal,
        });
      } else {
        await copyFile(final.local, marked);
      }
      // C2PA Content Credentials (docs/design/provenance.md#takes): signed after the watermark, before storing.
      let stored = marked;
      let contentCredentials: ContentCredentialsStamp | null = null;
      if (deps.c2pa.enabled) {
        ctx.progress(0.93, 1, 'signing Content Credentials');
        stored = join(dir, 'take-signed.mp4');
        contentCredentials = await deps.c2pa.signTake({
          input: marked,
          output: stored,
          title: `${docs.project.title} · ${name}`,
          projectId,
          asset: { clipId, shotId, takeId },
          watermarkId,
          models: { imageModel, videoModel: final.model || undefined },
          consistency: {
            status: final.report.status,
            score: final.report.score,
            judge: final.report.judge,
          },
          keyframe: keyframeRef ? await deps.media.localPath(projectId, keyframeRef) : null,
        });
      }
      let video = await deps.media.putFile(projectId, stored, { kind: 'takes', name, mime: 'video/mp4' });
      ctx.progress(0.96, 1, 'making the poster');
      video = await withPoster(deps, projectId, stored, video, ctx.signal);
      const lastPath = await extractLastFrame(
        deps.ff,
        stored,
        video.durationSec ?? shot.durationSec,
        video.fps ?? 24,
        join(dir, 'last.png'),
        ctx.signal,
      );
      const lastFrame = await deps.media.putFile(projectId, lastPath, {
        kind: 'frames',
        name: `${name}-last`,
        mime: 'image/png',
      });
      const frames: MediaRef[] = [];
      for (const [i, p] of final.frames.entries())
        frames.push(
          await deps.media.putFile(projectId, p, {
            kind: 'frames',
            name: `${name}-judge-${i}`,
            mime: 'image/png',
          }),
        );
      if (watermarkId) {
        await deps.watermark.register({
          id: watermarkId,
          projectId,
          asset: { kind: 'take', id: takeId, clipId, shotId },
          media: { path: video.path, hash: video.hash },
          embed: {
            width: video.width ?? 0,
            height: video.height ?? 0,
            strength: deps.watermark.params.strength,
            pair: deps.watermark.params.pair,
          },
        });
      }
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
        },
        taskIds,
        watermarkId,
        contentCredentials,
        characters,
        elements,
        audio: dialogue ? takeAudio(dialogue, lipSync) : null,
      });
      ctx.progress(1, 1, `take ${final.report.status}`);
      return { takeId: take.id, status: final.report.status, score: final.report.score };
    });
  } catch (err) {
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

async function commitTake(
  deps: HandlerDeps,
  ctx: JobContext,
  clipId: string,
  shotId: string,
  t: {
    id?: string;
    keyframe: MediaRef | null;
    video: MediaRef | null;
    lastFrame: MediaRef | null;
    report: ConsistencyReport;
    request: Take['request'];
    taskIds: string[];
    watermarkId?: string | null;
    contentCredentials?: ContentCredentialsStamp | null;
    characters: Character[];
    elements: Element[];
    audio: TakeAudio | null;
  },
): Promise<Take> {
  const take: Take = {
    id: t.id ?? newId('take'),
    createdAt: new Date().toISOString(),
    jobId: ctx.job.id,
    keyframe: t.keyframe,
    video: t.video,
    lastFrame: t.lastFrame,
    request: t.request,
    gatewayTaskIds: t.taskIds,
    consistency: t.report,
    characterLocks: Object.fromEntries(t.characters.map((c) => [c.id, c.lock.version])),
    elementLocks: Object.fromEntries(t.elements.map((e) => [e.id, e.lock.version])),
    audio: t.audio,
    watermarkId: t.watermarkId ?? null,
    contentCredentials: t.contentCredentials ?? null,
    override: null,
    ...(t.video?.durationSec ? { durationSec: t.video.durationSec } : {}),
  };
  await commitAs(
    deps,
    ctx,
    (tx) => {
      const clip = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
      const shot = clip.shots.find((s) => s.id === shotId);
      if (!shot) throw notFound(`shot ${shotId}`);
      shot.takes.push(take);
      const selectable = !!take.video && take.consistency.status !== 'failed';
      if (selectable || (!shot.selectedTakeId && take.video)) shot.selectedTakeId = take.id;
      shot.status = take.video && take.consistency.status === 'passed' ? 'ready' : 'needs_review';
      shot.lastError = null;
      clip.status = clipStatusOf(clip);
      tx.set(docPath.clip(clipId), clip);
    },
    `Add take ${take.id.slice(-4)} to shot ${clipId.slice(-4)}/${shotId.slice(-4)} (${t.report.status}${t.report.characters.length ? ` ${t.report.score.toFixed(2)}` : ''})`,
    { takeId: take.id },
  );
  return take;
}

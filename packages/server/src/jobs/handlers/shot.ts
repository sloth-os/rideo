import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Character,
  type Clip,
  type ConsistencyReport,
  compileKeyframeRequest,
  compileVideoRequest,
  docPath,
  isAcceptable,
  type MediaRef,
  newId,
  orderedShotCharacters,
  type Shot,
  type ShotContext,
  selectReferences,
  type Take,
  takeState,
} from '@rideo/shared';
import { verifyFrames } from '../../consistency/gate';
import { assertCastReady, clipStatusOf } from '../../domain/clips';
import { notFound } from '../../errors';
import { extractLastFrame, sampleFrames } from '../../media/frames';
import { makeCastSheet } from '../../media/sheet';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, gatewayOptions, type HandlerDeps, withProxy } from './common';

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
  assertCastReady([shot], docs.characters);

  const characters = orderedShotCharacters(shot, docs.characters);
  const settings = docs.project.settings;
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
      // R3: deterministic references, bounded by the model; a cast sheet when the cast exceeds the budget.
      const selection = selectReferences(characters, shot, imageLimits.limits?.max_input_images);
      const judgeRefs = new Map<string, Buffer[]>();
      const refPngs: Buffer[] = [];
      for (const pc of selection.perCharacter) {
        const bufs: Buffer[] = [];
        for (const r of pc.refs) bufs.push(await deps.media.pngBuffer(projectId, r.media, 1024));
        judgeRefs.set(
          pc.characterId,
          await Promise.all(pc.refs.slice(0, 2).map((r) => deps.media.pngBuffer(projectId, r.media, 512))),
        );
        refPngs.push(...bufs);
      }
      let referenceUris = refPngs.map((b) => `data:image/png;base64,${b.toString('base64')}`);
      if (selection.needsSheet && refPngs.length > 1) {
        const parts = await Promise.all(
          refPngs.map(async (b, i) => {
            const p = join(dir, `sheet-${i}.png`);
            await writeFile(p, b);
            return p;
          }),
        );
        const sheet = await makeCastSheet(deps.ff, parts, join(dir, 'cast-sheet.png'), 512, ctx.signal);
        referenceUris = [`data:image/png;base64,${(await readFile(sheet)).toString('base64')}`];
      }
      const shotCtx: ShotContext = { shot, characters, screenplay: docs.screenplay, settings };

      // R5: continuity chaining from the previous shot's passing take.
      let firstFrame: { uri: string; source: Take['request']['firstFrameSource'] } | null = null;
      if (shot.continuity === 'continuous') {
        const prev = clip.shots.find((s) => s.index === shot.index - 1);
        const prevTake = prev?.takes.find((t) => t.id === prev.selectedTakeId);
        if (prev && prevTake?.lastFrame && isAcceptable(takeState(prevTake, prev, docs.characters))) {
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
      if (!firstFrame && settings.generation.keyframes) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          throwIfAborted(ctx.signal);
          ctx.progress(
            0.05 + (0.3 * attempt) / maxAttempts,
            1,
            `keyframe attempt ${attempt + 1}/${maxAttempts}`,
          );
          const req = compileKeyframeRequest(shotCtx, {
            referenceUris,
            attempt,
            model: settings.models.image,
          });
          const task = await deps.gateway.generateImage(
            req,
            gatewayOptions(ctx, 'image', 'keyframe', attempt),
          );
          taskIds.push(task.id);
          imageModel = task.model || imageModel;
          keyframeRef = await deps.media.importUri(projectId, task.outputs![0]!.uri, {
            kind: 'keyframes',
            name: `${name}-a${attempt + 1}`,
            signal: ctx.signal,
          });
          const png = await deps.media.pngBuffer(projectId, keyframeRef, 512);
          keyframeReport = await verifyFrames({
            judge,
            shot,
            characters,
            references: judgeRefs,
            frames: [png],
            frameRefs: [keyframeRef],
            threshold,
            attempts: attempt + 1,
            metrics: deps.metrics,
            log: ctx.log,
            signal: ctx.signal,
          });
          if (keyframeReport.status !== 'failed') break;
          ctx.log.info({ attempt, score: keyframeReport.score }, 'keyframe failed the consistency gate');
        }
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
          });
          return { takeId: take.id, status: 'failed', stage: 'keyframe' };
        }
        firstFrame = keyframeRef
          ? { uri: await deps.media.pngDataUri(projectId, keyframeRef, 1920), source: 'keyframe' }
          : null;
      }

      let best: Candidate | null = null;
      let videoReq = compileVideoRequest(shotCtx, {
        firstFrameUri: firstFrame?.uri,
        referenceUris,
        attempt: 0,
        model: settings.models.video,
        limits: videoLimits.limits,
      });
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        throwIfAborted(ctx.signal);
        ctx.progress(0.35 + (0.45 * attempt) / maxAttempts, 1, `video attempt ${attempt + 1}/${maxAttempts}`);
        videoReq = compileVideoRequest(shotCtx, {
          firstFrameUri: firstFrame?.uri,
          referenceUris,
          attempt,
          model: settings.models.video,
          limits: videoLimits.limits,
        });
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
        const report = await verifyFrames({
          judge,
          shot,
          characters,
          references: judgeRefs,
          frames: frameBufs,
          frameRefs: [],
          threshold,
          attempts: attempt + 1,
          metrics: deps.metrics,
          log: ctx.log,
          signal: ctx.signal,
        });
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
      const final = best!;

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
      let video = await deps.media.putFile(projectId, marked, { kind: 'takes', name, mime: 'video/mp4' });
      ctx.progress(0.96, 1, 'building preview proxy');
      video = await withProxy(deps, projectId, marked, video, ctx.signal);
      const lastPath = await extractLastFrame(
        deps.ff,
        marked,
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
        characters,
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
    characters: Character[];
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
    watermarkId: t.watermarkId ?? null,
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

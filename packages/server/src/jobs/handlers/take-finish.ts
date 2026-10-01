import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Character,
  type Clip,
  type ConsistencyReport,
  type ContentCredentialsStamp,
  docPath,
  type Element,
  type MediaRef,
  newId,
  type Take,
  type TakeAudio,
  type TakeDerivation,
} from '@rideo/shared';
import { clipStatusOf } from '../../domain/clips';
import { notFound } from '../../errors';
import { extractLastFrame } from '../../media/frames';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, type HandlerDeps, withPoster } from './common';

export interface FinishedTake {
  takeId: string;
  video: MediaRef;
  lastFrame: MediaRef;
  frames: MediaRef[];
  watermarkId: string | null;
  contentCredentials: ContentCredentialsStamp | null;
}

/**
 * The end of every take (docs/design/generation-pipeline.md#shot-pipeline): the invisible watermark (one
 * re-encode), C2PA Content Credentials (a derived take names its parent, docs/design/take-editing.md#provenance),
 * the poster, the last frame for continuity, the judged frames as evidence, the provenance registry.
 */
export async function finishTake(
  deps: HandlerDeps,
  ctx: JobContext,
  input: {
    local: string;
    frames: string[];
    dir: string;
    name: string;
    title: string;
    clipId: string;
    shotId: string;
    models: { imageModel?: string; videoModel?: string };
    report: ConsistencyReport;
    keyframe: MediaRef | null;
    fallbackDurationSec: number;
    parent?: { video: MediaRef; derivation: TakeDerivation };
  },
): Promise<FinishedTake> {
  const projectId = ctx.job.projectId;
  const { dir, name, clipId, shotId } = input;
  const settings = (await deps.projects.docs(projectId)).project.settings;
  throwIfAborted(ctx.signal);
  ctx.progress(0.9, 1, 'watermarking');
  const takeId = newId('take');
  const watermarkId = settings.watermark.enabled ? await deps.watermark.allocateId() : null;
  const marked = join(dir, `${name}-take.mp4`);
  if (watermarkId) {
    await deps.watermark.embedVideo(input.local, marked, {
      id: watermarkId,
      title: `${input.title} · ${name}`,
      crf: 18,
      preset: 'veryfast',
      signal: ctx.signal,
    });
  } else {
    await copyFile(input.local, marked);
  }
  // C2PA Content Credentials (docs/design/provenance.md#takes): signed after the watermark, before storing.
  let stored = marked;
  let contentCredentials: ContentCredentialsStamp | null = null;
  if (deps.c2pa.enabled) {
    ctx.progress(0.93, 1, 'signing Content Credentials');
    stored = join(dir, `${name}-take-signed.mp4`);
    contentCredentials = await deps.c2pa.signTake({
      input: marked,
      output: stored,
      title: `${input.title} · ${name}`,
      projectId,
      asset: { clipId, shotId, takeId },
      watermarkId,
      models: input.models,
      consistency: { status: input.report.status, score: input.report.score, judge: input.report.judge },
      keyframe: input.keyframe ? await deps.media.localPath(projectId, input.keyframe) : null,
      ...(input.parent
        ? {
            parent: {
              path: await deps.media.localPath(projectId, input.parent.video),
              ...input.parent.derivation,
            },
          }
        : {}),
    });
  }
  let video = await deps.media.putFile(projectId, stored, { kind: 'takes', name, mime: 'video/mp4' });
  ctx.progress(0.96, 1, 'making the poster');
  video = await withPoster(deps, projectId, stored, video, ctx.signal);
  const lastPath = await extractLastFrame(
    deps.ff,
    stored,
    video.durationSec ?? input.fallbackDurationSec,
    video.fps ?? 24,
    join(dir, `${name}-last.png`),
    ctx.signal,
  );
  const lastFrame = await deps.media.putFile(projectId, lastPath, {
    kind: 'frames',
    name: `${name}-last`,
    mime: 'image/png',
  });
  const frames: MediaRef[] = [];
  for (const [i, p] of input.frames.entries())
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
  return { takeId, video, lastFrame, frames, watermarkId, contentCredentials };
}

/** Appends a take to its shot; a take that passed (or the first with a video) is selected. */
export async function commitTake(
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
    endKeyframe?: MediaRef | null;
    variation: number;
    derivedFrom?: TakeDerivation | null;
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
    endKeyframe: t.endKeyframe ?? null,
    variation: t.variation,
    derivedFrom: t.derivedFrom ?? null,
    consistency: t.report,
    characterLocks: Object.fromEntries(t.characters.map((c) => [c.id, c.lock.version])),
    elementLocks: Object.fromEntries(t.elements.map((e) => [e.id, e.lock.version])),
    audio: t.audio,
    watermarkId: t.watermarkId ?? null,
    contentCredentials: t.contentCredentials ?? null,
    override: null,
    focus: null,
    ...(t.video?.durationSec ? { durationSec: t.video.durationSec } : {}),
  };
  const derived = t.derivedFrom
    ? ` (${t.derivedFrom.op}${t.derivedFrom.kind ? ` ${t.derivedFrom.kind}` : ''})`
    : '';
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
    `Add take ${take.id.slice(-4)}${derived} to shot ${clipId.slice(-4)}/${shotId.slice(-4)} (${t.report.status}${t.report.characters.length ? ` ${t.report.score.toFixed(2)}` : ''})`,
    { takeId: take.id },
  );
  return take;
}

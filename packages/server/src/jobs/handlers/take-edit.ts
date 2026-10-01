import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ConsistencyReport,
  compileEditRequest,
  compileExtendRequest,
  docPath,
  type EditKind,
  isStillMedia,
  newId,
  orderedShotCharacters,
  orderedShotElements,
  type Resource,
  type ShotContext,
  type Take,
  type TakeDerivation,
  type Timeline,
  type VideoItem,
} from '@rideo/shared';
import { verifyFrames } from '../../consistency/gate';
import { assertCastReady } from '../../domain/clips';
import { invalid, notFound } from '../../errors';
import { extractFrameNear, sampleFrames } from '../../media/frames';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, gatewayOptions, type HandlerDeps } from './common';
import { prepareShotReferences } from './keyframe';
import { commitTake, finishTake } from './take-finish';

interface Attempt {
  local: string;
  frames: string[];
  report: ConsistencyReport;
  model: string;
  prompt: string;
  seed: number;
}

/** The shot of a take with everything a derived generation needs (R1: the cast must still be locked). */
async function shotOf(deps: HandlerDeps, ctx: JobContext, clipId: string, shotId: string, takeId: string) {
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  const shot = clip.shots.find((s) => s.id === shotId);
  if (!shot) throw notFound(`shot ${shotId}`);
  const parent = shot.takes.find((t) => t.id === takeId);
  if (!parent) throw notFound(`take ${takeId}`);
  if (!parent.video) throw invalid('the take has no video to derive from');
  assertCastReady([shot], docs.characters, docs.elements);
  const settings = docs.project.settings;
  const characters = orderedShotCharacters(shot, docs.characters);
  const elements = orderedShotElements(shot, docs.elements);
  const judgedElements = settings.consistency.judgeElements ? elements : [];
  const shotCtx: ShotContext = { shot, characters, elements, screenplay: docs.screenplay, settings };
  return {
    docs,
    clip,
    shot,
    parent,
    settings,
    characters,
    elements,
    judgedElements,
    shotCtx,
    judge: settings.consistency.judge === 'off' ? deps.offJudge : deps.judge,
    name: `c${clip.index + 1}-s${shot.index + 1}`,
  };
}

/** Generate → download → sample → judge, with retries (R4); the best attempt is kept. */
async function generateJudged(
  deps: HandlerDeps,
  ctx: JobContext,
  s: Awaited<ReturnType<typeof shotOf>>,
  refs: { judgeRefs: Map<string, Buffer[]>; elementJudgeRefs: Map<string, Buffer[]> },
  dir: string,
  step: string,
  compile: (attempt: number) => import('@rideo/shared').GatewayVideoRequest,
  taskIds: string[],
): Promise<Attempt> {
  const { threshold, maxAttempts } = s.settings.consistency;
  let best: Attempt | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    throwIfAborted(ctx.signal);
    ctx.progress(0.1 + (0.6 * attempt) / maxAttempts, 1, `${step} attempt ${attempt + 1}/${maxAttempts}`);
    const req = compile(attempt);
    const task = await deps.gateway.generateVideo(req, gatewayOptions(ctx, 'video', step, attempt));
    taskIds.push(task.id);
    const local = join(dir, `${step}-${attempt}.mp4`);
    await deps.media.downloadTo(task.outputs![0]!.uri, local, ctx.signal);
    const probe = await deps.ff.probe(local);
    const frames = await sampleFrames(deps.ff, local, probe.durationSec || 2, dir, `${step}-f${attempt}`, {
      maxWidth: 512,
      signal: ctx.signal,
    });
    const report = await verifyFrames({
      judge: s.judge,
      shot: s.shot,
      characters: s.characters,
      references: refs.judgeRefs,
      elements: s.judgedElements,
      elementReferences: refs.elementJudgeRefs,
      frames: await Promise.all(frames.map((f) => readFile(f))),
      frameRefs: [],
      threshold,
      attempts: attempt + 1,
      metrics: deps.metrics,
      log: ctx.log,
      signal: ctx.signal,
    });
    const text = req.input[0]?.type === 'text' ? (req.input[0] as { text: string }).text : '';
    const candidate = {
      local,
      frames,
      report,
      model: task.model,
      prompt: text,
      seed: req.parameters?.seed ?? 0,
    };
    if (!best || report.score > best.report.score || report.status !== 'failed') best = candidate;
    if (report.status !== 'failed') break;
    ctx.log.info({ attempt, score: report.score, step }, 'derived take failed the consistency gate');
  }
  return best!;
}

/** Commits a derived take after the shared finishing (watermark, C2PA with its parent, poster, frames). */
async function commitDerived(
  deps: HandlerDeps,
  ctx: JobContext,
  s: Awaited<ReturnType<typeof shotOf>>,
  dir: string,
  local: string,
  best: Attempt,
  derivedFrom: TakeDerivation,
  taskIds: string[],
  referenceCount: number,
): Promise<Take> {
  const name = `${s.name}-${derivedFrom.op}`;
  const done = await finishTake(deps, ctx, {
    local,
    frames: best.frames,
    dir,
    name,
    title: s.docs.project.title,
    clipId: s.clip.id,
    shotId: s.shot.id,
    models: { videoModel: best.model || undefined },
    report: best.report,
    keyframe: null,
    fallbackDurationSec: s.parent.durationSec ?? s.shot.durationSec,
    parent: { video: s.parent.video!, derivation: derivedFrom },
  });
  const take = await commitTake(deps, ctx, s.clip.id, s.shot.id, {
    id: done.takeId,
    keyframe: s.parent.keyframe,
    video: done.video,
    lastFrame: done.lastFrame,
    report: { ...best.report, frames: done.frames },
    request: {
      videoModel: best.model || undefined,
      prompt: best.prompt,
      seed: best.seed,
      durationSec: done.video.durationSec ?? s.shot.durationSec,
      firstFrameSource: derivedFrom.op === 'extend' ? 'previous_shot' : 'none',
      referenceCount,
      lastFrameSource: null,
      motionReference: null,
      multiShot: null,
    },
    taskIds,
    watermarkId: done.watermarkId,
    contentCredentials: done.contentCredentials,
    characters: s.characters,
    elements: s.elements,
    // the parent's dialogue: same timing for edits, the lines still start at 0 for extensions
    audio: s.parent.audio,
    variation: s.parent.variation,
    derivedFrom,
  });
  ctx.progress(1, 1, `${derivedFrom.op} ${take.consistency.status}`);
  return take;
}

/** `take.edit` (docs/design/take-editing.md#edits-takeedit): a video-to-video edit of a take. */
export async function takeEdit(deps: HandlerDeps, ctx: JobContext) {
  const { clipId, shotId, takeId, kind, instruction } = ctx.job.params as {
    clipId: string;
    shotId: string;
    takeId: string;
    kind: EditKind;
    instruction: string;
  };
  const s = await shotOf(deps, ctx, clipId, shotId, takeId);
  const existing = s.shot.takes.find((t) => t.jobId === ctx.job.id);
  if (existing) return { takeId: existing.id, status: existing.consistency.status, reused: true };
  const projectId = ctx.job.projectId;
  return deps.media.withTmpDir(async (dir) => {
    const limits = (await deps.gateway.limitsFor('video', s.settings.models.edit)).limits;
    const refs = await prepareShotReferences(deps, ctx, {
      shot: s.shot,
      characters: s.characters,
      elements: s.elements,
      judgedElements: s.judgedElements,
      maxInputImages: limits?.max_input_images,
      dir,
    });
    const takeUri = await deps.media.dataUri(projectId, s.parent.video!);
    const taskIds: string[] = [];
    const best = await generateJudged(
      deps,
      ctx,
      s,
      refs,
      dir,
      'edit',
      (attempt) =>
        compileEditRequest(s.shotCtx, {
          kind,
          instruction,
          takeUri,
          referenceUris: refs.referenceUris,
          durationSec: s.parent.durationSec ?? s.shot.durationSec,
          attempt,
          model: s.settings.models.edit,
          limits,
        }),
      taskIds,
    );
    // The edit keeps the parent's sound.
    const parentLocal = await deps.media.localPath(projectId, s.parent.video!);
    const local = join(dir, 'edited.mp4');
    if (s.parent.video!.hasAudio !== false && (await deps.ff.probe(parentLocal)).hasAudio)
      await deps.ff.run(
        [
          '-i',
          best.local,
          '-i',
          parentLocal,
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-c:v',
          'copy',
          '-c:a',
          'copy',
          '-shortest',
          local,
        ],
        { signal: ctx.signal },
      );
    else await deps.ff.run(['-i', best.local, '-map', '0:v', '-c:v', 'copy', local], { signal: ctx.signal });
    const take = await commitDerived(
      deps,
      ctx,
      s,
      dir,
      local,
      best,
      { takeId, op: 'edit', kind, instruction },
      taskIds,
      refs.referenceUris.length,
    );
    return { takeId: take.id, status: take.consistency.status, score: take.consistency.score };
  });
}

/**
 * `take.extend` (docs/design/take-editing.md#extensions-takeextend): the parent's last frame starts a continuation;
 * the derived take is the parent followed by it.
 */
export async function takeExtend(deps: HandlerDeps, ctx: JobContext) {
  const { clipId, shotId, takeId, seconds, prompt } = ctx.job.params as {
    clipId: string;
    shotId: string;
    takeId: string;
    seconds: number;
    prompt?: string;
  };
  const s = await shotOf(deps, ctx, clipId, shotId, takeId);
  const existing = s.shot.takes.find((t) => t.jobId === ctx.job.id);
  if (existing) return { takeId: existing.id, status: existing.consistency.status, reused: true };
  if (!s.parent.lastFrame) throw invalid('the take has no last frame to continue from');
  const projectId = ctx.job.projectId;
  return deps.media.withTmpDir(async (dir) => {
    const limits = (await deps.gateway.limitsFor('video', s.settings.models.video)).limits;
    const refs = await prepareShotReferences(deps, ctx, {
      shot: s.shot,
      characters: s.characters,
      elements: s.elements,
      judgedElements: s.judgedElements,
      maxInputImages: limits?.max_input_images,
      dir,
    });
    const firstFrameUri = await deps.media.pngDataUri(projectId, s.parent.lastFrame!, 1920);
    const taskIds: string[] = [];
    const best = await generateJudged(
      deps,
      ctx,
      s,
      refs,
      dir,
      'extend',
      (attempt) =>
        compileExtendRequest(s.shotCtx, {
          seconds,
          prompt,
          firstFrameUri,
          referenceUris: refs.referenceUris,
          attempt,
          model: s.settings.models.video,
          limits,
        }),
      taskIds,
    );
    const local = await concatenate(
      deps,
      ctx,
      dir,
      await deps.media.localPath(projectId, s.parent.video!),
      best.local,
      seconds,
    );
    const take = await commitDerived(
      deps,
      ctx,
      s,
      dir,
      local,
      best,
      { takeId, op: 'extend', seconds, ...(prompt ? { instruction: prompt } : {}) },
      taskIds,
      refs.referenceUris.length,
    );
    return { takeId: take.id, status: take.consistency.status, durationSec: take.durationSec };
  });
}

/** `a` then `b` at `a`'s size and frame rate, one re-encode; each keeps its sound or gets silence. */
async function concatenate(
  deps: HandlerDeps,
  ctx: JobContext,
  dir: string,
  a: string,
  b: string,
  seconds: number,
): Promise<string> {
  // Models have a minimum length: only the first `seconds` of the continuation are used.
  const [pa, probeB] = await Promise.all([deps.ff.probe(a), deps.ff.probe(b)]);
  const pb = { ...probeB, durationSec: Math.min(probeB.durationSec || seconds, seconds) };
  const w = pa.width ?? 1280;
  const h = pa.height ?? 720;
  const fps = Math.round(pa.fps ?? 24);
  const out = join(dir, 'extended.mp4');
  const audio = (k: number, has: boolean, dur: number) =>
    has
      ? `[${k}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${dur},atrim=0:${dur}[a${k}]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${dur}[a${k}]`;
  const filter = [
    `[0:v]setpts=PTS-STARTPTS,scale=${w}:${h},setsar=1,fps=${fps},format=yuv420p[v0]`,
    `[1:v]trim=end=${pb.durationSec},setpts=PTS-STARTPTS,scale=${w}:${h},setsar=1,fps=${fps},format=yuv420p[v1]`,
    audio(0, pa.hasAudio, pa.durationSec),
    audio(1, pb.hasAudio, pb.durationSec),
    '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
  ].join(';');
  await deps.ff.run(
    [
      '-i',
      a,
      '-i',
      b,
      '-filter_complex',
      filter,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      out,
    ],
    { signal: ctx.signal },
  );
  return out;
}

/**
 * `timeline.extend` (docs/design/take-editing.md#generative-extend-in-the-editor): frames generated from an item's
 * edge frame, stored as a resource and inserted next to the item.
 */
export async function timelineExtend(deps: HandlerDeps, ctx: JobContext) {
  const { itemId, edge, seconds, prompt } = ctx.job.params as {
    itemId: string;
    edge: 'start' | 'end';
    seconds: number;
    prompt?: string;
  };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const timeline = docs.timeline;
  const track = timeline?.tracks.find((t) => t.kind === 'video');
  const index = track?.items.findIndex((i) => i.id === itemId) ?? -1;
  const item = index >= 0 ? (track!.items[index] as VideoItem) : null;
  if (!timeline || !track || !item) throw notFound(`timeline item ${itemId}`);
  if (isStillMedia(item.source.media)) throw invalid('stills cannot be extended');
  const settings = docs.project.settings;
  const limits = (await deps.gateway.limitsFor('video', settings.models.video)).limits;
  if (edge === 'start' && limits?.supports_last_frame === false)
    throw invalid('the video model takes no last frame, so it cannot generate what leads into an item');
  // A take extends with its shot's prompt, references and judge; footage with a generic continuation.
  const source = item.source.type === 'take' ? item.source : null;
  const clip = source ? docs.clips[source.clipId] : undefined;
  const shot = clip?.shots.find((s) => s.id === source!.shotId);
  return deps.media.withTmpDir(async (dir) => {
    const local = await deps.media.localPath(projectId, item.source.media);
    const at = edge === 'end' ? Math.max(0, item.out - 1 / timeline.fps) : item.in;
    const edgeFrame = await extractFrameNear(
      deps.ff,
      local,
      at,
      join(dir, 'edge.png'),
      undefined,
      ctx.signal,
    );
    const edgeUri = `data:image/png;base64,${(await readFile(edgeFrame)).toString('base64')}`;
    const taskIds: string[] = [];
    let generated: Attempt;
    if (shot && clip) {
      const s = await shotOf(deps, ctx, clip.id, shot.id, source!.takeId);
      const refs = await prepareShotReferences(deps, ctx, {
        shot: s.shot,
        characters: s.characters,
        elements: s.elements,
        judgedElements: s.judgedElements,
        maxInputImages: limits?.max_input_images,
        dir,
      });
      generated = await generateJudged(
        deps,
        ctx,
        s,
        refs,
        dir,
        `extend-${edge}`,
        (attempt) =>
          compileExtendRequest(s.shotCtx, {
            seconds,
            prompt,
            ...(edge === 'end' ? { firstFrameUri: edgeUri } : { lastFrameUri: edgeUri }),
            referenceUris: refs.referenceUris,
            attempt,
            model: settings.models.video,
            limits,
          }),
        taskIds,
      );
    } else {
      const what = prompt?.trim() ? `: ${prompt.trim()}` : '';
      const task = await deps.gateway.generateVideo(
        {
          ...(settings.models.video !== 'auto' ? { model: settings.models.video } : {}),
          input: [
            {
              type: 'text',
              text:
                edge === 'end'
                  ? `Continue the shot seamlessly from the first frame${what}.`
                  : `Lead into the last frame seamlessly${what}.`,
            },
            { type: 'image', uri: edgeUri, role: edge === 'end' ? 'first_frame' : 'last_frame' },
          ],
          parameters: {
            duration_seconds: seconds,
            dimensions: { width: timeline.width, height: timeline.height },
            include_audio: false,
          },
        },
        gatewayOptions(ctx, 'video', `extend-${edge}`, 0),
      );
      taskIds.push(task.id);
      const out = join(dir, 'extension-raw.mp4');
      await deps.media.downloadTo(task.outputs![0]!.uri, out, ctx.signal);
      generated = {
        local: out,
        frames: [],
        report: {} as ConsistencyReport,
        model: task.model,
        prompt: '',
        seed: 0,
      };
    }
    // Exactly `seconds` long, at the cut's size.
    const trimmed = join(dir, 'extension.mp4');
    await deps.ff.run(
      [
        '-i',
        generated.local,
        '-t',
        String(seconds),
        '-vf',
        `scale=${timeline.width}:${timeline.height}:force_original_aspect_ratio=decrease,pad=${timeline.width}:${timeline.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        trimmed,
      ],
      { signal: ctx.signal },
    );
    const resourceId = newId('resource');
    const watermarkId = settings.watermark.enabled ? await deps.watermark.allocateId() : null;
    const marked = join(dir, 'extension-marked.mp4');
    if (watermarkId)
      await deps.watermark.embedVideo(trimmed, marked, {
        id: watermarkId,
        title: `${docs.project.title} · extension`,
        crf: 18,
        preset: 'veryfast',
        signal: ctx.signal,
      });
    let stored = watermarkId ? marked : trimmed;
    if (deps.c2pa.enabled) {
      const signed = join(dir, 'extension-signed.mp4');
      await deps.c2pa.signExtension({
        input: stored,
        output: signed,
        title: `${docs.project.title} · extension`,
        projectId,
        resourceId,
        watermarkId,
        videoModel: generated.model || undefined,
        edgeFrame,
      });
      stored = signed;
    }
    const media = await deps.media.putFile(projectId, stored, {
      kind: 'uploads',
      name: 'extension',
      mime: 'video/mp4',
    });
    if (watermarkId)
      await deps.watermark.register({
        id: watermarkId,
        projectId,
        asset: { kind: 'resource', id: resourceId },
        media: { path: media.path, hash: media.hash },
        embed: {
          width: media.width ?? 0,
          height: media.height ?? 0,
          strength: deps.watermark.params.strength,
          pair: deps.watermark.params.pair,
        },
      });
    const resource: Resource = {
      id: resourceId,
      kind: 'video',
      role: 'extension',
      name: `${edge === 'end' ? 'After' : 'Before'} ${item.label ?? 'item'} (+${seconds}s)`,
      media,
      createdAt: new Date().toISOString(),
      origin: 'generated',
      status: 'ready',
      generation: {
        prompt: generated.prompt || (prompt ?? ''),
        model: generated.model || undefined,
        taskId: taskIds.at(-1),
      },
    };
    await commitAs(
      deps,
      ctx,
      (tx) => tx.set(docPath.resource(resourceId), resource),
      `Generate ${resource.name}`,
    );
    const { timeline: next } = await deps.services.edit.applyOps(ctx.actor, projectId, [
      {
        op: 'insert',
        trackId: track.id,
        index: edge === 'end' ? index + 1 : index,
        item: {
          kind: 'video',
          source: { type: 'media', media, resourceId },
          in: 0,
          out: seconds,
          label: `${item.label ?? 'item'} ${edge === 'end' ? '+' : '−'}${seconds}s`,
        },
      },
    ]);
    const inserted = (next.tracks.find((t) => t.id === track.id)!.items as VideoItem[])[
      edge === 'end' ? index + 1 : index
    ];
    return {
      resourceId,
      itemId: inserted?.id,
      status: generated.report.status ?? 'unverified',
    };
  });
}

export type { Timeline };

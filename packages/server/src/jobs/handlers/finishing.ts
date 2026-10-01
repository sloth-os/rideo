import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Clip,
  type Delivery,
  type DeliveryAspect,
  docPath,
  type Export,
  type FocusPoint,
  type MediaRef,
  type ProjectSettings,
  type Timeline,
  thumbnailTimes,
} from '@rideo/shared';
import { invalid, notFound } from '../../errors';
import { extractFrame } from '../../media/frames';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, gatewayOptions, type HandlerDeps } from './common';

/** Final encode of an export (the browser's chunks are intermediates). */
export const FINISH_QUALITY: Record<Export['quality'], { preset: string; crf: number }> = {
  draft: { preset: 'veryfast', crf: 26 },
  standard: { preset: 'medium', crf: 20 },
  high: { preset: 'slow', crf: 17 },
};

/** Points of a take where the subject is looked for (docs/design/finishing.md#auto-reframe-and-cut-downs). */
const FOCUS_AT = [0.15, 0.5, 0.85];

/**
 * `export.prepare`: the focus track of every take a reframed export needs, stored on the takes, then the render
 * timeline reframed and handed to the tab (docs/design/finishing.md#auto-reframe-and-cut-downs).
 */
export async function exportPrepare(deps: HandlerDeps, ctx: JobContext) {
  const { exportId, aspect, render } = ctx.job.params as {
    exportId: string;
    aspect: DeliveryAspect;
    render: Record<string, unknown> & { exportId: string };
  };
  const projectId = ctx.job.projectId;
  const log = deps.log.child({ projectId, jobId: ctx.job.id, exportId });
  let docs = await docsFor(deps, ctx);
  if (!docs.exports[exportId]) throw notFound(`export ${exportId}`);
  const t = (await deps.services.projects.getDoc(projectId, docPath.render(exportId))) as Timeline | null;
  if (!t) throw invalid(`export ${exportId} has no render timeline`);
  const missing = deps.services.edit.takesWithoutFocus(t, docs);
  for (const [k, m] of missing.entries()) {
    throwIfAborted(ctx.signal);
    ctx.progress(k, missing.length + 1, `finding the subject of take ${k + 1}/${missing.length}`);
    const shot = docs.clips[m.clipId]!.shots.find((s) => s.id === m.shotId)!;
    const take = shot.takes.find((x) => x.id === m.takeId)!;
    const focus = await deps.media.withTmpDir(async (dir) => {
      const local = await deps.media.localPath(projectId, take.video!);
      const duration = take.video!.durationSec ?? take.durationSec ?? shot.durationSec;
      const times = FOCUS_AT.map((f) => Math.round(f * duration * 1000) / 1000);
      const frames: Buffer[] = [];
      for (const [i, at] of times.entries()) {
        const out = join(dir, `focus-${i}.png`);
        await extractFrame(deps.ff, local, at, out, 512, ctx.signal);
        frames.push(await readFile(out));
      }
      const answer = await deps.llm.focus(
        {
          shot: shot.description,
          characters: shot.characterIds.map((id) => docs.characters[id]?.name ?? '').filter(Boolean),
          frames: times.map((at, index) => ({ index, t: at })),
        },
        frames,
        ctx.signal,
      );
      return times.map((at, index): FocusPoint => {
        const f = answer.frames.find((x) => x.index === index);
        return { t: at, x: f?.x ?? 0.5, y: f?.y ?? 0.5 };
      });
    });
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const clip = structuredClone(tx.require<Clip>(docPath.clip(m.clipId), `clip ${m.clipId}`));
        const target = clip.shots.find((s) => s.id === m.shotId)?.takes.find((x) => x.id === m.takeId);
        if (target) target.focus = focus;
        tx.set(docPath.clip(m.clipId), clip);
      },
      `Find the subject of C${docs.clips[m.clipId]!.index + 1}·S${shot.index + 1} for reframing`,
    );
    deps.metrics.finishing.inc({ op: 'focus', outcome: 'ok' });
  }
  docs = await docsFor(deps, ctx);
  const reframed = deps.services.edit.reframe(t, aspect, docs);
  await commitAs(
    deps,
    ctx,
    (tx) => tx.set(docPath.render(exportId), reframed),
    `Reframe export ${exportId.slice(-6)} to ${aspect}`,
  );
  const job = await deps.services.edit.startRender(ctx.actor, projectId, ctx.job.branch, render);
  log.info({ focused: missing.length, aspect }, 'prepared a reframed export');
  return { exportId, focused: missing.length, next: job.id };
}

export interface EnhancePlan {
  upscale: boolean;
  interpolate: boolean;
  /** The gateway model, or null for ffmpeg. */
  model: string | null;
}

/**
 * Upscale and interpolation (docs/design/finishing.md#enhancement-upscale-and-frame-interpolation): what is needed,
 * and the gateway model that can do all of it (`settings.models.enhance`), else ffmpeg.
 */
export async function planEnhance(
  deps: HandlerDeps,
  settings: ProjectSettings,
  from: { width: number; height: number; fps: number },
  to: { width: number; height: number; fps: number },
): Promise<EnhancePlan> {
  const upscale = to.width > from.width * 1.01 || to.height > from.height * 1.01;
  const interpolate = to.fps > from.fps;
  if (!upscale && !interpolate) return { upscale, interpolate, model: null };
  const wanted = settings.models.enhance;
  if (wanted === 'off') return { upscale, interpolate, model: null };
  const entries = await deps.gateway.modelLimits('video').catch(() => []);
  const able = entries.filter(
    (e) =>
      (!upscale || e.limits?.supports_upscale === true) &&
      (!interpolate ||
        (e.limits?.supports_frame_interpolation === true && (e.limits.max_fps ?? 0) >= to.fps)),
  );
  const chosen = wanted === 'auto' ? able[0] : able.find((e) => e.id === wanted);
  return { upscale, interpolate, model: chosen?.id ?? null };
}

const ENHANCE_PROMPT =
  'Enhance: keep the picture exactly as it is (framing, people, motion, colours); only raise the resolution and the frame rate.';

/** Every rendered part through the enhancement model, in order (one gateway request per part). */
export async function enhanceParts(
  deps: HandlerDeps,
  ctx: JobContext,
  input: {
    parts: string[];
    plan: EnhancePlan;
    to: { width: number; height: number; fps: number };
    dir: string;
  },
): Promise<string[]> {
  const out: string[] = [];
  for (const [k, part] of input.parts.entries()) {
    throwIfAborted(ctx.signal);
    ctx.progress(
      k,
      input.parts.length,
      `enhancing part ${k + 1}/${input.parts.length} (${input.plan.model})`,
    );
    const uri = `data:video/mp4;base64,${(await readFile(part)).toString('base64')}`;
    const task = await deps.gateway.generateVideo(
      {
        model: input.plan.model!,
        input: [
          { type: 'text', text: ENHANCE_PROMPT },
          { type: 'video', uri, role: 'reference_video' },
        ],
        parameters: {
          dimensions: { width: input.to.width, height: input.to.height },
          ...(input.plan.interpolate ? { fps: input.to.fps } : {}),
          include_audio: false,
        },
      },
      gatewayOptions(ctx, 'video', `enhance-${k}`),
    );
    const local = join(input.dir, `enhanced-${String(k + 1).padStart(4, '0')}.mp4`);
    await deps.media.downloadTo(task.outputs![0]!.uri, local, ctx.signal);
    if (input.plan.upscale) deps.metrics.finishing.inc({ op: 'upscale_model', outcome: 'ok' });
    if (input.plan.interpolate) deps.metrics.finishing.inc({ op: 'interpolate_model', outcome: 'ok' });
    out.push(local);
  }
  return out;
}

/** The decode filter of the finishing pass: the size and rate of the delivery (ffmpeg enhancement when no model). */
export function finishFilter(to: { width: number; height: number; fps: number }, plan: EnhancePlan): string {
  const ffmpeg = !plan.model;
  const scale = `scale=${to.width}:${to.height}${ffmpeg && plan.upscale ? ':flags=lanczos' : ''}`;
  const rate = ffmpeg && plan.interpolate ? `framerate=fps=${to.fps}` : `fps=${to.fps}`;
  return `${scale},setsar=1,${rate},format=yuv420p`;
}

/** The picture encoder of a delivery format (docs/design/finishing.md#formats). */
export function videoEncodeArgs(
  delivery: Pick<Delivery, 'format' | 'preset'>,
  quality: Export['quality'],
): string[] {
  if (delivery.format === 'prores')
    return ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
  const q = FINISH_QUALITY[quality];
  return [
    '-c:v',
    'libx264',
    '-preset',
    q.preset,
    '-crf',
    String(q.crf),
    ...(delivery.preset === 'youtube' ? ['-profile:v', 'high'] : []),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
  ];
}

/** The sound encoder of a delivery format. */
export function audioEncodeArgs(delivery: Pick<Delivery, 'format' | 'preset'>): string[] {
  if (delivery.format === 'prores') return ['-c:a', 'pcm_s24le', '-ar', '48000'];
  return ['-c:a', 'aac', '-b:a', delivery.preset === 'youtube' ? '320k' : '192k', '-ar', '48000'];
}

export const DELIVERY_FILE: Record<Delivery['format'], { ext: string; mime: string }> = {
  mp4: { ext: 'mp4', mime: 'video/mp4' },
  prores: { ext: 'mov', mime: 'video/quicktime' },
  frames: { ext: 'tar', mime: 'application/x-tar' },
};

/**
 * Thumbnails (docs/design/finishing.md#thumbnails): six candidate frames of the finished film, ranked by the vision
 * LLM, the best three as signed JPEGs.
 */
export async function makeThumbnails(
  deps: HandlerDeps,
  ctx: JobContext,
  input: {
    exp: Export;
    timeline: Timeline;
    /** A frame of the finished film at a time. */
    frameAt: (sec: number, out: string) => Promise<void>;
    parent: { path: string; mime: string };
    title: string;
    dir: string;
  },
): Promise<MediaRef[]> {
  const times = thumbnailTimes(input.timeline, 6);
  if (!times.length) return [];
  const frames: string[] = [];
  for (const [i, at] of times.entries()) {
    const out = join(input.dir, `candidate-${i}.png`);
    await input.frameAt(at, out);
    frames.push(out);
  }
  const ranked = await deps.llm.pickThumbnails(
    {
      title: input.title,
      count: Math.min(3, frames.length),
      frames: times.map((t, index) => ({ index, t })),
    },
    await Promise.all(frames.map((f) => readFile(f))),
    ctx.signal,
  );
  const picks = [...new Set(ranked.picks.map((p) => p.index).filter((i) => i < frames.length))].slice(0, 3);
  const out: MediaRef[] = [];
  for (const [k, index] of picks.entries()) {
    const jpg = join(input.dir, `thumbnail-${k + 1}.jpg`);
    await deps.ff.run(
      [
        '-i',
        frames[index]!,
        '-vf',
        "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
        '-q:v',
        '2',
        jpg,
      ],
      { signal: ctx.signal },
    );
    let stored = jpg;
    if (deps.c2pa.enabled) {
      stored = join(input.dir, `thumbnail-${k + 1}-signed.jpg`);
      await deps.c2pa.signThumbnail({
        input: jpg,
        output: stored,
        title: `${input.title} thumbnail ${k + 1}.jpg`,
        projectId: ctx.job.projectId,
        exportId: input.exp.id,
        parent: input.parent,
      });
    }
    out.push(
      await deps.media.putFile(ctx.job.projectId, stored, {
        kind: 'thumbs',
        name: `${input.exp.id}-thumbnail-${k + 1}`,
        mime: 'image/jpeg',
      }),
    );
    deps.metrics.finishing.inc({ op: 'thumbnail', outcome: 'ok' });
  }
  return out;
}

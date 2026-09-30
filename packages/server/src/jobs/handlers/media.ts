import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Analysis,
  docPath,
  type EditSuggestion,
  type Export,
  type MediaRef,
  type Resource,
  referencedMedia,
  ruleSuggestions,
  suggestionFromLlm,
  type Timeline,
} from '@rideo/shared';
import type { LabelledImage } from '../../ai/tasks';
import { AppError, notFound } from '../../errors';
import { analyzeMedia } from '../../media/analyze';
import { extractFrame } from '../../media/frames';
import { buildRenderPlan, QUALITY, resolveFont } from '../../media/render';
import { runFramePipeline } from '../../watermark/pipeline';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps, withProxy } from './common';

export async function resourceProcess(deps: HandlerDeps, ctx: JobContext) {
  const { resourceId } = ctx.job.params as { resourceId: string };
  const docs = await docsFor(deps, ctx);
  const r = docs.resources[resourceId];
  if (!r) throw notFound(`resource ${resourceId}`);
  const projectId = ctx.job.projectId;
  try {
    const local = await deps.media.localPath(projectId, r.media);
    const probe = await deps.ff.probe(local);
    if (r.kind === 'video' && !probe.hasVideo)
      throw new AppError('validation_error', `${r.name} has no video stream`);
    ctx.progress(0.3, 1, 'building preview proxy');
    const media: MediaRef = await withProxy(
      deps,
      projectId,
      local,
      { ...r.media, ...(probe.fps ? { fps: probe.fps } : {}) },
      ctx.signal,
    );
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const cur = tx.require<Resource>(docPath.resource(resourceId), `resource ${resourceId}`);
        tx.set(docPath.resource(resourceId), { ...cur, media, status: 'ready' });
      },
      `Process ${r.kind} ${r.name}`,
    );
    return { resourceId };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const cur = tx.get<Resource>(docPath.resource(resourceId));
        if (cur)
          tx.set(docPath.resource(resourceId), {
            ...cur,
            status: 'failed',
            error: (err as Error).message.slice(0, 2000),
          });
      },
      `Processing ${r.name} failed`,
    );
    throw new AppError('media_error', (err as Error).message);
  }
}

export async function analysisRun(deps: HandlerDeps, ctx: JobContext) {
  const { analysisId } = ctx.job.params as { analysisId: string };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const analysis = docs.analyses[analysisId];
  if (!analysis) throw notFound(`analysis ${analysisId}`);
  const resource = docs.resources[analysis.resourceId];
  if (!resource) throw notFound(`resource ${analysis.resourceId}`);
  try {
    return await deps.media.withTmpDir(async (dir) => {
      const local = await deps.media.localPath(projectId, resource.media);
      const probe = await deps.ff.probe(local);
      ctx.progress(0.1, 1, 'detecting scenes, silences and black frames');
      const signals = await analyzeMedia(deps.ff, local, probe, { signal: ctx.signal });
      ctx.progress(0.4, 1, 'extracting scene thumbnails');
      const pick =
        signals.scenes.length <= 12
          ? signals.scenes
          : Array.from(
              { length: 12 },
              (_, i) => signals.scenes[Math.floor((i * signals.scenes.length) / 12)]!,
            );
      const thumbs: LabelledImage[] = [];
      const scenes: Analysis['scenes'] = [];
      for (const [i, s] of signals.scenes.entries()) {
        const entry: Analysis['scenes'][number] = { start: s.start, end: s.end };
        if (pick.includes(s)) {
          const p = await extractFrame(
            deps.ff,
            local,
            (s.start + s.end) / 2,
            join(dir, `thumb-${i}.jpg`),
            320,
            ctx.signal,
          );
          entry.thumbnail = await deps.media.putFile(projectId, p, {
            kind: 'thumbs',
            name: `${analysisId}-scene-${i}`,
            mime: 'image/jpeg',
          });
          thumbs.push({
            label: `Scene ${i + 1} (${s.start.toFixed(1)}–${s.end.toFixed(1)}s):`,
            data: await deps.media.filePng(p, 320),
            mime: 'image/png',
          });
        }
        scenes.push(entry);
      }
      let transcript: Analysis['transcript'] = [];
      if (deps.stt && probe.hasAudio) {
        ctx.progress(0.55, 1, 'transcribing');
        try {
          const audio = join(dir, 'audio.mp3');
          await deps.ff.run(['-i', local, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audio], {
            signal: ctx.signal,
          });
          transcript = await deps.stt.transcribe(await readFile(audio), 'audio.mp3', ctx.signal);
        } catch (err) {
          ctx.log.warn(
            { err: (err as Error).message },
            'transcription failed; continuing without a transcript',
          );
        }
      }
      const rules = ruleSuggestions({
        durationSec: probe.durationSec,
        silences: signals.silences,
        blackSegments: signals.blackSegments,
      });
      let ai: EditSuggestion[] = [];
      let summary = `${probe.durationSec.toFixed(1)}s, ${signals.scenes.length} scene(s), ${signals.silences.length} silence(s), ${signals.blackSegments.length} black segment(s)${signals.loudnessLufs !== null ? `, ${signals.loudnessLufs.toFixed(1)} LUFS` : ''}.`;
      ctx.progress(0.7, 1, 'asking the editor model for suggestions');
      try {
        const out = await deps.llm.analyzeFootage(
          {
            durationSec: probe.durationSec,
            scenes: signals.scenes,
            silences: signals.silences,
            blackSegments: signals.blackSegments,
            loudnessLufs: signals.loudnessLufs,
            transcript,
            thumbnailCount: thumbs.length,
          },
          thumbs,
          ctx.signal,
        );
        ai = out.suggestions
          .map((s) => suggestionFromLlm(s, probe.durationSec))
          .filter((s): s is EditSuggestion => !!s);
        if (out.summary) summary = `${out.summary} (${summary})`;
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log.warn(
          { err: (err as Error).message },
          'AI footage analysis failed; keeping rule-based suggestions',
        );
      }
      await commitAs(
        deps,
        ctx,
        (tx) => {
          const cur = tx.require<Analysis>(docPath.analysis(analysisId), `analysis ${analysisId}`);
          tx.set(docPath.analysis(analysisId), {
            ...cur,
            status: 'completed',
            completedAt: new Date().toISOString(),
            probe: {
              durationSec: probe.durationSec,
              width: probe.width ?? 0,
              height: probe.height ?? 0,
              fps: probe.fps ?? 0,
              hasAudio: probe.hasAudio,
            },
            scenes,
            silences: signals.silences,
            blackSegments: signals.blackSegments,
            loudness: signals.loudnessLufs !== null ? { integratedLufs: signals.loudnessLufs } : null,
            transcript,
            summary,
            suggestions: [...rules, ...ai],
          });
        },
        `Analyze ${resource.name}: ${rules.length + ai.length} suggestion(s)`,
      );
      return { suggestions: rules.length + ai.length, scenes: scenes.length };
    });
  } catch (err) {
    if (!ctx.signal.aborted) {
      await commitAs(
        deps,
        ctx,
        (tx) => {
          const cur = tx.get<Analysis>(docPath.analysis(analysisId));
          if (cur)
            tx.set(docPath.analysis(analysisId), {
              ...cur,
              status: 'failed',
              error: (err as Error).message.slice(0, 2000),
            });
        },
        `Analysis of ${resource.name} failed`,
      ).catch(() => undefined);
    }
    throw err;
  }
}

async function setExport(
  deps: HandlerDeps,
  ctx: JobContext,
  exportId: string,
  patch: Partial<Export>,
  message: string,
) {
  await commitAs(
    deps,
    ctx,
    (tx) => {
      const cur = tx.require<Export>(docPath.export(exportId), `export ${exportId}`);
      tx.set(docPath.export(exportId), { ...cur, ...patch });
    },
    message,
  );
}

async function publishExport(
  deps: HandlerDeps,
  ctx: JobContext,
  exp: Export,
  file: string,
  watermarkId: string | null,
  codec: string,
) {
  const projectId = ctx.job.projectId;
  let media = await deps.media.putFile(projectId, file, { kind: 'exports', name: exp.id, mime: 'video/mp4' });
  ctx.progress(0.97, 1, 'building preview proxy');
  media = await withProxy(deps, projectId, file, media, ctx.signal);
  if (watermarkId) {
    await deps.watermark.register({
      id: watermarkId,
      projectId,
      asset: { kind: 'export', id: exp.id },
      media: { path: media.path, hash: media.hash },
      embed: {
        width: media.width ?? 0,
        height: media.height ?? 0,
        strength: deps.watermark.params.strength,
        pair: deps.watermark.params.pair,
      },
    });
  }
  await setExport(
    deps,
    ctx,
    exp.id,
    {
      status: 'succeeded',
      media,
      watermarkId,
      durationSec: media.durationSec,
      width: media.width,
      height: media.height,
      codec,
    },
    `Export ${exp.id.slice(-6)} ready${watermarkId ? ` (watermark ${watermarkId})` : ''}`,
  );
  const h = await deps.projects.existing(projectId);
  await h.repo
    .createTag({
      name: `export-${exp.id.slice(4).toLowerCase()}`,
      message: `Export ${exp.id}`,
      actor: ctx.actor,
      unique: true,
    })
    .catch(() => undefined);
  return media;
}

/** Server render: timeline → raw frames → watermark → H.264 (single encode) + AAC mix. */
export async function exportRender(deps: HandlerDeps, ctx: JobContext) {
  const { exportId } = ctx.job.params as { exportId: string };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const exp = docs.exports[exportId];
  if (!exp) throw notFound(`export ${exportId}`);
  const h = await deps.projects.existing(projectId);
  const timeline =
    (exp.timelineCommit ? await h.repo.readDoc<Timeline>('timeline.json', exp.timelineCommit) : null) ??
    docs.timeline;
  if (!timeline) throw new AppError('validation_error', 'nothing to render: the timeline is empty');
  await setExport(
    deps,
    ctx,
    exportId,
    { status: 'rendering', jobId: ctx.job.id },
    `Render export ${exportId.slice(-6)}`,
  );
  try {
    return await deps.media.withTmpDir(async (dir) => {
      const inputs = new Map<string, string>();
      for (const m of referencedMedia(timeline)) inputs.set(m.hash, await deps.media.localPath(projectId, m));
      const plan = buildRenderPlan({
        timeline,
        inputs,
        quality: exp.quality,
        textDir: dir,
        fontFile: resolveFont(deps.config.fontFile),
      });
      for (const f of plan.textFiles) await writeFile(f.path, f.content);
      ctx.progress(0.02, 1, 'mixing audio');
      const audio = join(dir, 'audio.m4a');
      await deps.ff.run(plan.audioArgs(audio), { signal: ctx.signal });
      const settings = docs.project.settings;
      const watermarkId = settings.watermark.enabled ? await deps.watermark.allocateId() : null;
      const embed = watermarkId ? deps.watermark.embedder(watermarkId, plan.width, plan.height) : null;
      const q = QUALITY[exp.quality];
      const out = join(dir, 'export.mp4');
      await runFramePipeline({
        ff: deps.ff,
        width: plan.width,
        height: plan.height,
        decodeArgs: plan.videoArgs,
        encodeArgs: [
          '-f',
          'rawvideo',
          '-pix_fmt',
          'yuv420p',
          '-s',
          `${plan.width}x${plan.height}`,
          '-r',
          String(plan.fps),
          '-i',
          '-',
          '-i',
          audio,
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-c:v',
          'libx264',
          '-preset',
          q.preset,
          '-crf',
          String(q.crf),
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'copy',
          '-shortest',
          '-movflags',
          '+faststart',
          ...(watermarkId ? deps.watermark.metadataArgs(watermarkId, docs.project.title) : []),
          out,
        ],
        transform: embed ? (y) => embed.transform(y) : () => undefined,
        signal: ctx.signal,
        onProgress: (frames) =>
          ctx.progress(
            0.05 + (0.9 * frames) / Math.max(1, plan.totalFrames),
            1,
            `rendering ${frames}/${plan.totalFrames} frames`,
          ),
      });
      if (watermarkId) deps.metrics.watermark.inc({ op: 'embed' });
      const media = await publishExport(deps, ctx, exp, out, watermarkId, 'h264/aac');
      return { exportId, path: media.path, watermarkId, psnr: embed?.stats().psnr };
    });
  } catch (err) {
    if (!ctx.signal.aborted)
      await setExport(
        deps,
        ctx,
        exportId,
        { status: 'failed', error: (err as Error).message.slice(0, 4000) },
        `Export ${exportId.slice(-6)} failed`,
      ).catch(() => undefined);
    throw err;
  }
}

/** Finishing pass for a WebCodecs-rendered upload: watermark (server-side key) and publish. */
export async function exportFinish(deps: HandlerDeps, ctx: JobContext) {
  const { exportId, uploadPath } = ctx.job.params as { exportId: string; uploadPath: string };
  const docs = await docsFor(deps, ctx);
  const exp = docs.exports[exportId];
  if (!exp) throw notFound(`export ${exportId}`);
  try {
    return await deps.media.withTmpDir(async (dir) => {
      const probe = await deps.ff.probe(uploadPath);
      if (!probe.hasVideo) throw new AppError('validation_error', 'the uploaded export has no video stream');
      const settings = docs.project.settings;
      const watermarkId = settings.watermark.enabled ? await deps.watermark.allocateId() : null;
      const out = join(dir, 'export.mp4');
      if (watermarkId) {
        await deps.watermark.embedVideo(uploadPath, out, {
          id: watermarkId,
          title: docs.project.title,
          crf: 18,
          signal: ctx.signal,
          onProgress: (f, total) => ctx.progress(f, total, 'watermarking'),
        });
      } else {
        await deps.ff.run(
          ['-i', uploadPath, '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', out],
          { signal: ctx.signal },
        );
      }
      const media = await publishExport(
        deps,
        ctx,
        { ...exp },
        out,
        watermarkId,
        `h264 (browser ${exp.codec ?? 'webcodecs'})`,
      );
      return { exportId, path: media.path, watermarkId };
    });
  } catch (err) {
    if (!ctx.signal.aborted)
      await setExport(
        deps,
        ctx,
        exportId,
        { status: 'failed', error: (err as Error).message.slice(0, 4000) },
        `Export ${exportId.slice(-6)} failed`,
      ).catch(() => undefined);
    throw err;
  } finally {
    await rm(uploadPath, { force: true });
  }
}

export async function editAuto(deps: HandlerDeps, ctx: JobContext) {
  const { analysisId } = ctx.job.params as { analysisId: string };
  const { commit } = await deps.services.edit.autoEdit(ctx.actor, ctx.job.projectId, analysisId);
  return { commit: commit?.id ?? null };
}

export async function timelineAssemble(deps: HandlerDeps, ctx: JobContext) {
  const { captions, musicResourceId } = ctx.job.params as { captions?: boolean; musicResourceId?: string };
  const { commit } = await deps.services.edit.assemble(ctx.actor, ctx.job.projectId, {
    captions,
    musicResourceId,
  });
  return { commit: commit?.id ?? null };
}

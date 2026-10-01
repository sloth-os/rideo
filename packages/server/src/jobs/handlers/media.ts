import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Analysis,
  type AudioRole,
  audioSegments,
  type ContentCredentialsStamp,
  type Delivery,
  DeliverySchema,
  docPath,
  type EditSuggestion,
  type Export,
  ExportRenderResultSchema,
  type ProjectDocs,
  ruleSuggestions,
  suggestionFromLlm,
  type Timeline,
} from '@rideo/shared';
import { z } from 'zod';
import type { LabelledImage } from '../../ai/tasks';
import { AppError, notFound } from '../../errors';
import { extractFrame } from '../../media/frames';
import { normalizeSoundtrack } from '../../media/loudness';
import { writeTar } from '../../media/tar';
import type { ExportIngredient } from '../../provenance/c2pa';
import { runFramePipeline } from '../../watermark/pipeline';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps } from './common';
import {
  audioEncodeArgs,
  DELIVERY_FILE,
  enhanceParts,
  finishFilter,
  makeThumbnails,
  planEnhance,
  videoEncodeArgs,
} from './finishing';

/**
 * The AI half of a footage analysis: the browser has uploaded the signals and thumbnails
 * (docs/design/editor.md#footage-analysis); this adds the transcript, the vision LLM's summary and suggestions,
 * and the rule-based suggestions.
 */
export async function analysisSuggest(deps: HandlerDeps, ctx: JobContext) {
  const { analysisId, speech } = ctx.job.params as {
    analysisId: string;
    speech?: { jobId: string; name: string };
  };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const analysis = docs.analyses[analysisId];
  if (!analysis) throw notFound(`analysis ${analysisId}`);
  const resource = docs.resources[analysis.resourceId];
  if (!resource) throw notFound(`resource ${analysis.resourceId}`);
  const probe = analysis.probe;
  if (!probe) throw new AppError('validation_error', 'the analysis has no signals yet');
  try {
    let transcript: Analysis['transcript'] = [];
    if (deps.stt && speech) {
      ctx.progress(0.1, 1, 'transcribing');
      try {
        const audio = await readFile(deps.staging.path(speech.jobId, speech.name));
        transcript = await deps.stt.transcribe(audio, speech.name, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log.warn(
          { err: (err as Error).message },
          'transcription failed; continuing without a transcript',
        );
      }
    }
    const thumbs: LabelledImage[] = [];
    for (const [i, s] of analysis.scenes.entries()) {
      if (!s.thumbnail) continue;
      thumbs.push({
        label: `Scene ${i + 1} (${s.start.toFixed(1)}–${s.end.toFixed(1)}s):`,
        data: await deps.media.readBuffer(projectId, s.thumbnail),
        mime: 'image/jpeg',
      });
    }
    const loudnessLufs = analysis.loudness?.integratedLufs ?? null;
    const rules = ruleSuggestions({
      durationSec: probe.durationSec,
      silences: analysis.silences,
      blackSegments: analysis.blackSegments,
    });
    let ai: EditSuggestion[] = [];
    let summary = `${probe.durationSec.toFixed(1)}s, ${analysis.scenes.length} scene(s), ${analysis.silences.length} silence(s), ${analysis.blackSegments.length} black segment(s)${loudnessLufs !== null ? `, ${loudnessLufs.toFixed(1)} LUFS` : ''}.`;
    ctx.progress(0.4, 1, 'asking the editor model for suggestions');
    try {
      const out = await deps.llm.analyzeFootage(
        {
          durationSec: probe.durationSec,
          scenes: analysis.scenes.map(({ start, end }) => ({ start, end })),
          silences: analysis.silences,
          blackSegments: analysis.blackSegments,
          loudnessLufs,
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
          transcript,
          summary,
          suggestions: [...rules, ...ai],
        });
      },
      `Analyze ${resource.name}: ${rules.length + ai.length} suggestion(s)`,
    );
    if (speech) await deps.staging.remove(speech.jobId);
    return { suggestions: rules.length + ai.length, scenes: analysis.scenes.length };
  } catch (err) {
    if (!ctx.signal.aborted && ctx.job.attempts >= ctx.job.maxAttempts) {
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

/**
 * The C2PA ingredients of an export (docs/design/provenance.md#exports): every distinct take and resource on the
 * rendered timeline, as local files so their own manifests are carried over.
 */
/** The timeline an export rendered: its derived timeline (a language variant), else the cut or the animatic. */
async function renderedTimeline(deps: HandlerDeps, projectId: string, exp: Export): Promise<Timeline> {
  if (exp.language || exp.captions === 'sidecar')
    return (await deps.services.projects.getDoc(projectId, docPath.render(exp.id))) as Timeline;
  return (await deps.services.projects.getDoc(
    projectId,
    exp.source === 'animatic' ? 'animatic.json' : 'timeline.json',
    exp.timelineCommit ?? undefined,
  )) as Timeline;
}

async function exportIngredients(
  deps: HandlerDeps,
  projectId: string,
  docs: ProjectDocs,
  timeline: Timeline,
  only?: Set<string>,
): Promise<ExportIngredient[]> {
  const seen = new Set<string>();
  const out: ExportIngredient[] = [];
  for (const track of timeline.tracks) {
    for (const item of track.items) {
      if (item.kind === 'text' || seen.has(item.source.media.hash)) continue;
      if (only && !only.has(item.source.media.hash)) continue;
      seen.add(item.source.media.hash);
      const media = item.source.media;
      const resource =
        item.source.type === 'media' && item.source.resourceId
          ? docs.resources[item.source.resourceId]
          : undefined;
      out.push({
        path: await deps.media.localPath(projectId, media),
        mime: media.mime,
        title: media.path.split('/').pop() ?? media.path,
        // Takes, generated resources and the TTS dialogue of takes (docs/design/dialogue.md) are AI-generated.
        generated:
          item.source.type === 'take' ||
          resource?.origin === 'generated' ||
          media.path.startsWith('media/dialogue/') ||
          media.path.startsWith('media/keyframes/'),
      });
    }
  }
  return out;
}

async function publishExport(
  deps: HandlerDeps,
  ctx: JobContext,
  exp: Export,
  file: string,
  watermarkId: string | null,
  codec: string,
  contentCredentials: ContentCredentialsStamp | null = null,
  audio: Partial<Pick<Export, 'loudness' | 'stems' | 'delivery' | 'thumbnails'>> | null = null,
  container: { mime: string; width?: number; height?: number } = { mime: 'video/mp4' },
) {
  const projectId = ctx.job.projectId;
  const media = await deps.media.putFile(projectId, file, {
    kind: 'exports',
    name: exp.id,
    mime: container.mime,
    // An archive has no media fields to probe.
    ...(container.mime === 'application/x-tar' ? { probe: false } : {}),
  });
  if (watermarkId) {
    await deps.watermark.register({
      id: watermarkId,
      projectId,
      asset: { kind: 'export', id: exp.id },
      media: { path: media.path, hash: media.hash },
      embed: {
        width: media.width ?? container.width ?? 0,
        height: media.height ?? container.height ?? 0,
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
      contentCredentials,
      durationSec: media.durationSec ?? exp.durationSec,
      width: media.width ?? container.width,
      height: media.height ?? container.height,
      codec,
      ...(audio ?? {}),
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

const FinishParamsSchema = ExportRenderResultSchema.extend({ exportId: z.string(), renderJobId: z.string() });

/**
 * Finishing pass of a browser render (docs/design/watermark.md#pipelines): the staged chunks are decoded in order,
 * watermarked with the server-side key, encoded once at the export quality and muxed with the soundtrack.
 */
export async function exportFinish(deps: HandlerDeps, ctx: JobContext) {
  const p = FinishParamsSchema.parse(ctx.job.params);
  const docs = await docsFor(deps, ctx);
  const exp = docs.exports[p.exportId];
  if (!exp) throw notFound(`export ${p.exportId}`);
  try {
    return await deps.media.withTmpDir(async (dir) => {
      const staged = p.soundtrack ? deps.staging.path(p.renderJobId, p.soundtrack) : null;
      // Loudness (docs/design/post-audio.md#loudness): normalized lossless audio and stems, encoded below.
      const target = exp.loudness?.target ?? 'off';
      const finished = staged
        ? await normalizeSoundtrack(deps, {
            soundtrack: staged,
            stems:
              p.stems && exp.stemsRequested
                ? {
                    dialogue: deps.staging.path(p.renderJobId, p.stems.dialogue),
                    music: deps.staging.path(p.renderJobId, p.stems.music),
                    effects: deps.staging.path(p.renderJobId, p.stems.effects),
                  }
                : null,
            target,
            dir,
            signal: ctx.signal,
          })
        : null;
      const soundtrack = finished?.audio ?? null;
      // The delivery (docs/design/finishing.md); exports from before deliveries are the rendered picture as MP4.
      const delivery: Delivery =
        exp.delivery ??
        DeliverySchema.parse({
          preset: 'web',
          format: 'mp4',
          width: p.width,
          height: p.height,
          fps: Math.round(p.fps),
          aspect: 'source',
        });
      const to = { width: delivery.width, height: delivery.height, fps: delivery.fps };
      const plan = await planEnhance(
        deps,
        docs.project.settings,
        { width: p.width, height: p.height, fps: p.fps },
        to,
      );
      let parts = p.parts.map((name) => deps.staging.path(p.renderJobId, name));
      if (plan.model) parts = await enhanceParts(deps, ctx, { parts, plan, to, dir });
      else {
        if (plan.upscale) deps.metrics.finishing.inc({ op: 'upscale_ffmpeg', outcome: 'ok' });
        if (plan.interpolate) deps.metrics.finishing.inc({ op: 'interpolate_ffmpeg', outcome: 'ok' });
      }
      const list = join(dir, 'parts.txt');
      await writeFile(list, parts.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n'));
      const { width, height, fps } = to;
      const total = Math.max(1, Math.round(p.durationSec * fps));
      const watermarkId = docs.project.settings.watermark.enabled ? await deps.watermark.allocateId() : null;
      const embed = watermarkId ? deps.watermark.embedder(watermarkId, width, height) : null;
      const file = DELIVERY_FILE[delivery.format];
      const out = join(dir, `export.${file.ext}`);
      const framesDir = join(dir, 'frames');
      if (delivery.format === 'frames') await mkdir(framesDir);
      const raw = [
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-s',
        `${width}x${height}`,
        '-r',
        String(fps),
        '-i',
        '-',
      ];
      await runFramePipeline({
        ff: deps.ff,
        width,
        height,
        decodeArgs: [
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          list,
          '-map',
          '0:v:0',
          '-vf',
          finishFilter(to, plan),
          '-f',
          'rawvideo',
          '-pix_fmt',
          'yuv420p',
          '-',
        ],
        encodeArgs:
          delivery.format === 'frames'
            ? [
                ...raw,
                '-c:v',
                'png',
                '-pix_fmt',
                'rgb24',
                '-start_number',
                '1',
                join(framesDir, 'frame-%06d.png'),
              ]
            : [
                ...raw,
                // The film's length bounds the mux: `-shortest` ends the file when the sound runs out first and
                // drops the frames still in the encoder's lookahead.
                ...(soundtrack
                  ? [
                      '-i',
                      soundtrack,
                      '-map',
                      '0:v',
                      '-map',
                      '1:a',
                      ...audioEncodeArgs(delivery),
                      '-t',
                      String(total / fps),
                    ]
                  : ['-map', '0:v']),
                ...videoEncodeArgs(delivery, exp.quality),
                ...(watermarkId ? deps.watermark.metadataArgs(watermarkId, docs.project.title) : []),
                out,
              ],
        transform: embed ? (y) => embed.transform(y) : () => undefined,
        signal: ctx.signal,
        onProgress: (frames) => ctx.progress(frames, total, `watermarking ${frames}/${total} frames`),
      });
      if (watermarkId) deps.metrics.watermark.inc({ op: 'embed' });
      if (delivery.format === 'frames') {
        // The image-sequence master: every frame, the sound and the subtitles in one archive.
        const frames = (await readdir(framesDir)).filter((f) => f.endsWith('.png')).sort();
        const entries = frames.map((f) => ({ name: `frames/${f}`, path: join(framesDir, f) }));
        if (soundtrack) entries.push({ name: 'soundtrack.wav', path: soundtrack });
        for (const fmt of ['srt', 'vtt'] as const)
          if (exp.subtitles)
            entries.push({
              name: `subtitles.${fmt}`,
              path: await deps.media.localPath(ctx.job.projectId, exp.subtitles[fmt]),
            });
        await writeTar(out, entries);
      }
      // C2PA Content Credentials: a composite of its takes and resources (docs/design/provenance.md#exports).
      let published = out;
      let contentCredentials: ContentCredentialsStamp | null = null;
      if (deps.c2pa.enabled && delivery.format !== 'frames') {
        ctx.progress(total, total, 'signing Content Credentials');
        const timeline = await renderedTimeline(deps, ctx.job.projectId, exp);
        published = join(dir, `export-signed.${file.ext}`);
        contentCredentials = await deps.c2pa.signExport({
          input: out,
          output: published,
          title: `${docs.project.title}.${file.ext}`,
          projectId: ctx.job.projectId,
          exportId: exp.id,
          timelineCommit: exp.timelineCommit,
          watermarkId,
          ingredients: await exportIngredients(deps, ctx.job.projectId, docs, timeline),
          disclosure: exp.disclosure,
          mime: file.mime,
          enhancements: plan.model
            ? [
                ...(plan.upscale ? [{ operation: 'upscale', model: plan.model }] : []),
                ...(plan.interpolate ? [{ operation: 'frame_interpolation', model: plan.model }] : []),
              ]
            : [],
        });
      }
      // Thumbnails (docs/design/finishing.md#thumbnails): frames of the finished film.
      const thumbnails = delivery.thumbnails
        ? await makeThumbnails(deps, ctx, {
            exp,
            timeline: await renderedTimeline(deps, ctx.job.projectId, exp),
            frameAt: async (sec, png) => {
              if (delivery.format === 'frames') {
                const n = Math.min(total, Math.max(1, Math.round(sec * fps) + 1));
                await copyFile(join(framesDir, `frame-${String(n).padStart(6, '0')}.png`), png);
              } else await extractFrame(deps.ff, published, sec, png, undefined, ctx.signal);
            },
            parent: { path: published, mime: file.mime },
            title: docs.project.title,
            dir,
          })
        : [];
      const enhance = {
        upscale: plan.upscale ? (plan.model ? ('model' as const) : ('ffmpeg' as const)) : null,
        interpolate: plan.interpolate ? (plan.model ? ('model' as const) : ('ffmpeg' as const)) : null,
        model: plan.model,
      };
      let stems: Export['stems'] = null;
      if (finished?.stems) {
        // Each stem carries Content Credentials placing its own sources (docs/design/post-audio.md#stems).
        const timeline = deps.c2pa.enabled ? await renderedTimeline(deps, ctx.job.projectId, exp) : null;
        const put = async (role: AudioRole) => {
          let file = finished.stems![role];
          if (timeline) {
            const signed = join(dir, `stem-${role}-signed.wav`);
            const sources = new Set(
              audioSegments(timeline).flatMap((a) => (a.role === role ? [a.media.hash] : [])),
            );
            await deps.c2pa.signStem({
              input: file,
              output: signed,
              title: `${docs.project.title} — ${role} stem.wav`,
              projectId: ctx.job.projectId,
              exportId: exp.id,
              role,
              timelineCommit: exp.timelineCommit,
              ingredients: await exportIngredients(deps, ctx.job.projectId, docs, timeline, sources),
            });
            file = signed;
          }
          return deps.media.putFile(ctx.job.projectId, file, {
            kind: 'stems',
            name: `${exp.id}-${role}`,
            mime: 'audio/wav',
          });
        };
        stems = { dialogue: await put('dialogue'), music: await put('music'), effects: await put('effects') };
      }
      const codec = { mp4: 'h264/aac', prores: 'prores 422 hq/pcm', frames: 'png sequence/wav' }[
        delivery.format
      ];
      const media = await publishExport(
        deps,
        ctx,
        exp,
        published,
        watermarkId,
        `${codec} (browser ${p.engine})`,
        contentCredentials,
        {
          loudness: finished?.loudness ?? exp.loudness,
          stems,
          delivery: { ...delivery, enhance },
          thumbnails,
        },
        { mime: file.mime, width, height },
      );
      await deps.staging.remove(p.renderJobId);
      return { exportId: p.exportId, path: media.path, watermarkId, psnr: embed?.stats().psnr };
    });
  } catch (err) {
    if (!ctx.signal.aborted && ctx.job.attempts >= ctx.job.maxAttempts)
      await setExport(
        deps,
        ctx,
        p.exportId,
        { status: 'failed', error: (err as Error).message.slice(0, 4000) },
        `Export ${p.exportId.slice(-6)} failed`,
      ).catch(() => undefined);
    throw err;
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

import {
  type Actor,
  type Analysis,
  applyOps,
  applySuggestions,
  assembleStoryTimeline,
  type Character,
  type Clip,
  type CommitSummary,
  checkRequirement,
  cutDown,
  type DeliveryAspect,
  type DeliveryInput,
  DeliverySchema,
  disclosureFor,
  docPath,
  docsFromEntries,
  type EditSuggestion,
  type Export,
  ExportLoudnessSchema,
  type ExportQuality,
  emptyTimeline,
  type FocusPoint,
  isStillMedia,
  type Job,
  type LoudnessTarget,
  type MediaRef,
  newId,
  type Project,
  type ProjectDocs,
  type RenderEngineChoice,
  type Resource,
  reframeTimeline,
  resolveDelivery,
  sortedClips,
  subtitleCues,
  type Timeline,
  type TimelineOp,
  toSrt,
  toVtt,
  withoutCaptions,
} from '@rideo/shared';
import { AppError, invalid, notFound } from '../errors';
import { Service } from './base';
import type { Deps } from './deps';
import { cutVariant } from './variants';

function opSummary(ops: TimelineOp[]): string {
  const counts = new Map<string, number>();
  for (const o of ops) counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  return [...counts].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(', ');
}

/** The longest source range a matte is asked for (it travels to the gateway as one video). */
export const MASK_MAX_SEC = 120;

/** The gateway model that returns mattes (`supports_segmentation`), or `segmentation_unavailable`. */
export async function segmentationModel(deps: Pick<Deps, 'gateway'>, wanted: string): Promise<string> {
  if (wanted === 'off')
    throw new AppError('segmentation_unavailable', 'Remove the background is off for this project');
  const entries = await deps.gateway.modelLimits('video').catch(() => []);
  const able = entries.filter((e) => e.limits?.supports_segmentation === true);
  const chosen = wanted === 'auto' ? able[0] : able.find((e) => e.id === wanted);
  if (!chosen)
    throw new AppError(
      'segmentation_unavailable',
      wanted === 'auto'
        ? 'No segmentation model on the gateway (models with supports_segmentation)'
        : `${wanted} does not return mattes (supports_segmentation)`,
    );
  return chosen.id;
}

export class EditService extends Service {
  async timeline(projectId: string): Promise<Timeline> {
    const docs = await this.deps.projects.docs(projectId);
    const s = docs.project.settings;
    return (
      docs.timeline ?? emptyTimeline({ fps: s.fps, width: s.resolution.width, height: s.resolution.height })
    );
  }

  async applyOps(
    actor: Actor,
    projectId: string,
    ops: TimelineOp[],
    coalesce?: string,
  ): Promise<{ timeline: Timeline; commit: CommitSummary | null }> {
    const { result, commit } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const p = tx.require<Project>('project.json', 'project');
        const current =
          tx.get<Timeline>('timeline.json') ??
          emptyTimeline({
            fps: p.settings.fps,
            width: p.settings.resolution.width,
            height: p.settings.resolution.height,
          });
        const next = applyOps(current, ops);
        tx.set('timeline.json', next);
        return next;
      },
      {
        message: `Edit timeline (${opSummary(ops)})`,
        meta: { ops },
        coalesce: coalesce ? { key: coalesce } : undefined,
      },
    );
    return { timeline: result, commit };
  }

  async assemble(
    actor: Actor,
    projectId: string,
    opts: { captions?: boolean; musicResourceId?: string } = {},
  ): Promise<{ timeline: Timeline; commit: CommitSummary | null }> {
    const { result, commit } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const docs = docsFromEntries(tx.entries());
        if (docs.project.kind !== 'story')
          throw invalid('assembly builds story timelines; use auto edit for footage');
        const clips = sortedClips(docs).filter((c) => c.status === 'approved');
        if (!clips.length) throw invalid('approve at least one clip before assembling');
        const music = opts.musicResourceId ? docs.resources[opts.musicResourceId] : undefined;
        if (opts.musicResourceId && music?.kind !== 'audio')
          throw notFound(`audio resource ${opts.musicResourceId}`);
        const s = docs.project.settings;
        const t = assembleStoryTimeline({
          clips,
          fps: s.fps,
          width: s.resolution.width,
          height: s.resolution.height,
          characters: docs.characters,
          captions: opts.captions,
          ...(music ? { music: { media: music.media, resourceId: music.id } } : {}),
        });
        tx.set('timeline.json', t);
        return t;
      },
      { message: 'Assemble timeline from approved clips' },
    );
    return { timeline: result, commit };
  }

  async analyze(
    actor: Actor,
    projectId: string,
    resourceId: string,
  ): Promise<{ analysis: Analysis; job: Job }> {
    const { result: analysis } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const r = tx.require<Resource>(docPath.resource(resourceId), `resource ${resourceId}`);
        if (r.kind !== 'video') throw invalid('analysis needs a video resource');
        if (r.status !== 'ready') throw new AppError('conflict', 'the video is still being processed');
        const a: Analysis = {
          id: newId('analysis'),
          resourceId,
          status: 'running',
          createdAt: new Date().toISOString(),
          completedAt: null,
          probe: null,
          scenes: [],
          silences: [],
          blackSegments: [],
          loudness: null,
          transcript: [],
          summary: '',
          suggestions: [],
        };
        tx.set(docPath.analysis(a.id), a);
        return a;
      },
      { message: 'Start footage analysis' },
    );
    // The signals are computed by a studio tab with ffmpeg.wasm (docs/design/editor.md#footage-analysis).
    const job = await this.deps.jobs.enqueue({
      projectId,
      kind: 'analysis.signals',
      params: { analysisId: analysis.id, resourceId, speech: !!this.deps.stt, maxThumbnails: 12 },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `analysis:${analysis.id}`,
      priority: 5,
      maxAttempts: 5,
    });
    return { analysis, job };
  }

  async reviewSuggestions(
    actor: Actor,
    projectId: string,
    analysisId: string,
    decisions: { id: string; status: EditSuggestion['status'] }[],
  ): Promise<Analysis> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const a = structuredClone(
          tx.require<Analysis>(docPath.analysis(analysisId), `analysis ${analysisId}`),
        );
        for (const d of decisions) {
          const s = a.suggestions.find((x) => x.id === d.id);
          if (!s) throw notFound(`suggestion ${d.id}`);
          s.status = d.status;
        }
        tx.set(docPath.analysis(analysisId), a);
        return a;
      },
      {
        message: `Review ${decisions.length} edit suggestion(s)`,
        coalesce: { key: `suggestions:${analysisId}` },
      },
    );
    return result;
  }

  /** Builds the timeline from accepted suggestions and moves the edit workflow to its edit stage. */
  async autoEdit(
    actor: Actor,
    projectId: string,
    analysisId: string,
  ): Promise<{ timeline: Timeline; commit: CommitSummary | null }> {
    const { result, commit } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const docs = docsFromEntries(tx.entries());
        const a = docs.analyses[analysisId];
        if (!a) throw notFound(`analysis ${analysisId}`);
        if (a.status !== 'completed' || !a.probe)
          throw new AppError('conflict', 'the analysis has not completed');
        const r = docs.resources[a.resourceId];
        if (!r) throw notFound(`resource ${a.resourceId}`);
        const music = Object.fromEntries(
          Object.values(docs.resources)
            .filter((x) => x.kind === 'audio')
            .map((x) => [x.id, x.media]),
        );
        const s = docs.project.settings;
        const t = applySuggestions({
          source: { media: r.media, resourceId: r.id },
          durationSec: a.probe.durationSec,
          suggestions: a.suggestions,
          fps: s.fps,
          width: s.resolution.width,
          height: s.resolution.height,
          music,
          speech: a.transcript.map((seg) => ({ start: seg.start, end: seg.end })),
        });
        tx.set('timeline.json', t);
        if (docs.project.kind === 'edit' && docs.project.workflow.stage === 'analysis') {
          tx.set('project.json', {
            ...docs.project,
            workflow: {
              stage: 'edit',
              approvals: {
                ...docs.project.workflow.approvals,
                suggestions_reviewed: { at: new Date().toISOString(), actor },
              },
            },
          });
        }
        return t;
      },
      { message: `Auto edit from ${analysisId.slice(-6)} (${'accepted'} suggestions)` },
    );
    return { timeline: result, commit };
  }

  private async exportPrecheck(projectId: string, source: 'timeline' | 'animatic'): Promise<void> {
    const docs = await this.deps.projects.docs(projectId);
    if (source === 'animatic') {
      // A previz of verified storyboard frames (docs/design/storyboard.md#animatic): no take gate.
      if (!docs.animatic?.tracks.some((t) => t.kind === 'video' && t.items.length))
        throw invalid('build the animatic first');
      return;
    }
    if (!checkRequirement('timeline.nonEmpty', docs).ok) throw invalid('the timeline is empty');
    const verified = checkRequirement('timeline.consistencyVerified', docs);
    if (docs.project.kind === 'story' && !verified.ok) {
      throw new AppError('consistency_gate', `Export blocked: ${verified.message}`, verified.details ?? []);
    }
  }

  /**
   * Generative extend (docs/design/take-editing.md#generative-extend-in-the-editor): frames generated from the edge
   * of a video item, inserted next to it.
   */
  async extendItem(
    actor: Actor,
    projectId: string,
    itemId: string,
    input: { edge: 'start' | 'end'; seconds: number; prompt?: string },
  ): Promise<Job> {
    const docs = await this.deps.projects.docs(projectId);
    const item = docs.timeline?.tracks.find((t) => t.kind === 'video')?.items.find((i) => i.id === itemId);
    if (item?.kind !== 'video') throw notFound(`video item ${itemId} on the primary track`);
    if (isStillMedia(item.source.media)) throw invalid('stills cannot be extended');
    if (input.edge === 'start') {
      const limits = (await this.deps.gateway.limitsFor('video', docs.project.settings.models.video)).limits;
      if (limits?.supports_last_frame === false)
        throw invalid('the video model takes no last frame, so it cannot generate what leads into an item');
    }
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'timeline.extend',
      params: { itemId, ...input },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `extend:${itemId}:${input.edge}`,
      priority: 10,
    });
  }

  /**
   * Remove the background (docs/design/editor.md#segmentation-masks-remove-the-background): a segmentation model's
   * matte of the subject becomes the item's mask.
   */
  async removeBackground(
    actor: Actor,
    projectId: string,
    itemId: string,
    input: { subject?: string; invert?: boolean } = {},
  ): Promise<Job> {
    const docs = await this.deps.projects.docs(projectId);
    const item = docs.timeline?.tracks
      .filter((t) => t.kind === 'video')
      .flatMap((t) => t.items)
      .find((i) => i.id === itemId);
    if (item?.kind !== 'video') throw notFound(`video item ${itemId}`);
    if (isStillMedia(item.source.media))
      throw invalid('stills have no motion to segment; use an image editor');
    if (item.out - item.in > MASK_MAX_SEC)
      throw invalid(
        `Remove the background works on up to ${MASK_MAX_SEC / 60} minutes of source; split the item`,
      );
    const model = await segmentationModel(this.deps, docs.project.settings.models.segment);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'mask.generate',
      params: { itemId, subject: input.subject?.trim() || 'the person', invert: !!input.invert, model },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `mask:${itemId}`,
      priority: 10,
    });
  }

  /**
   * Scores the cut: one generated music cue per scene on the Music track (docs/design/post-audio.md#score-one-cue-per-scene).
   */
  async scoreCut(actor: Actor, projectId: string, input: { direction?: string } = {}): Promise<Job> {
    await this.requirePicture(projectId);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'score.generate',
      params: { direction: input.direction?.trim() ?? '' },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `score:${projectId}`,
      priority: 10,
    });
  }

  /** Sound effects from the shots' action lines on the Effects track (docs/design/post-audio.md). */
  async effectsForCut(actor: Actor, projectId: string): Promise<Job> {
    if (!this.deps.sfx)
      throw new AppError(
        'sfx_unavailable',
        'no sound-effects provider is configured on the server (RIDEO_SFX_PROVIDER)',
      );
    await this.requirePicture(projectId);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'sfx.generate',
      params: {},
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `sfx:${projectId}`,
      priority: 10,
    });
  }

  private async requirePicture(projectId: string): Promise<void> {
    const docs = await this.deps.projects.docs(projectId);
    if (!docs.timeline?.tracks.some((t) => t.kind === 'video' && t.items.length))
      throw invalid('the cut has no picture yet: assemble it or add items first');
  }

  /** Queues an export; a studio tab renders it (`export.render` editor job) and the server watermarks it. */
  async createExport(
    actor: Actor,
    projectId: string,
    opts: {
      quality?: ExportQuality;
      engine?: RenderEngineChoice;
      source?: 'timeline' | 'animatic';
      loudness?: LoudnessTarget;
      stems?: boolean;
      language?: string;
      dubbed?: boolean;
      captions?: 'burn' | 'sidecar';
    } & Omit<DeliveryInput, 'loudness' | 'captions' | 'stems'> = {},
  ): Promise<{ export: Export; job: Job }> {
    const source = opts.source ?? 'timeline';
    const quality = opts.quality ?? 'standard';
    const engine = opts.engine ?? 'auto';
    const language = opts.language ?? null;
    const dubbed = !!opts.dubbed;
    await this.exportPrecheck(projectId, source);
    const h = await this.deps.projects.existing(projectId);
    const timelineCommit = (await h.repo.snapshot()).commit;
    const docs = await this.deps.projects.docs(projectId);
    const base = source === 'animatic' ? docs.animatic! : docs.timeline!;
    // The delivery: a preset, then explicit options (docs/design/finishing.md#delivery-presets).
    const delivery = resolveDelivery(
      { width: base.width, height: base.height, fps: base.fps },
      opts,
      quality,
    );
    const { loudness, captions, stems } = delivery;
    const reframed = delivery.aspect !== 'source';
    if (
      source === 'animatic' &&
      (language || dubbed || captions === 'sidecar' || reframed || delivery.maxDurationSec)
    )
      throw invalid('language variants, sidecar captions, reframes and cut-downs are made from the cut');
    // The visible disclosure label (docs/design/provenance.md#disclosure-label): resolved here, drawn by the tab.
    const disclosure = disclosureFor(docs);
    // A language variant (docs/design/localization.md), then the delivered length.
    let shown = source === 'animatic' ? base : cutVariant(docs, { language, dubbed });
    if (delivery.maxDurationSec) shown = cutDown(shown, delivery.maxDurationSec);
    const derived = !!(language || captions === 'sidecar' || reframed || delivery.maxDurationSec);
    let render = derived ? (captions === 'sidecar' ? withoutCaptions(shown) : shown) : null;
    // Reframing needs every take's focus; missing ones are prepared by `export.prepare` first.
    const missingFocus = render && reframed ? this.takesWithoutFocus(render, docs) : [];
    if (render && reframed && !missingFocus.length) render = this.reframe(render, delivery.aspect, docs);
    const exportId = newId('export');
    const subtitles = await this.subtitleFiles(
      projectId,
      shown,
      `${exportId}${language ? `-${language}` : ''}`,
    );
    const exp: Export = {
      id: exportId,
      createdAt: new Date().toISOString(),
      method: 'browser',
      status: 'queued',
      quality,
      source,
      media: null,
      watermarkId: null,
      contentCredentials: null,
      disclosure,
      timelineCommit,
      loudness: ExportLoudnessSchema.parse({
        target: loudness,
        mode: loudness === 'off' ? 'off' : 'pending',
      }),
      stemsRequested: stems,
      stems: null,
      language,
      dubbed,
      captions,
      subtitles: subtitles ? { language, ...subtitles } : null,
      delivery: DeliverySchema.parse({
        preset: delivery.preset,
        format: delivery.format,
        width: delivery.width,
        height: delivery.height,
        fps: delivery.fps,
        aspect: delivery.aspect,
        maxDurationSec: delivery.maxDurationSec,
        thumbnails: delivery.thumbnails,
      }),
      thumbnails: [],
    };
    await this.mutate(
      actor,
      projectId,
      (tx) => {
        tx.set(docPath.export(exp.id), exp);
        if (render) tx.set(docPath.render(exp.id), render);
      },
      {
        message: `Queue ${quality} ${source === 'animatic' ? 'animatic ' : ''}${delivery.preset} export${language ? ` (${language}${dubbed ? ', dubbed' : ''})` : ''}`,
      },
    );
    const renderParams = {
      exportId: exp.id,
      quality,
      engine,
      chunkSec: 30,
      // A derived timeline is the tab's to read as it is when the render starts.
      timelineCommit: render ? null : timelineCommit,
      timelinePath: render
        ? docPath.render(exp.id)
        : source === 'animatic'
          ? 'animatic.json'
          : 'timeline.json',
      disclosure: disclosure.label ? { text: disclosure.text, position: disclosure.position } : null,
      stems,
    };
    const branch = await this.branchOf(projectId);
    const job = missingFocus.length
      ? await this.deps.jobs.enqueue({
          projectId,
          kind: 'export.prepare',
          params: { exportId: exp.id, aspect: delivery.aspect, render: renderParams },
          actor,
          branch,
          dedupeKey: `prepare:${exp.id}`,
          maxAttempts: 3,
        })
      : await this.startRender(actor, projectId, branch, renderParams);
    return { export: exp, job };
  }

  /** Queues the tab's render of an export (docs/design/editor.md#editor-jobs). */
  async startRender(
    actor: Actor,
    projectId: string,
    branch: string,
    params: Record<string, unknown> & { exportId: string },
  ): Promise<Job> {
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'export.render',
      params,
      actor,
      branch,
      dedupeKey: `export:${params.exportId}`,
      maxAttempts: 5,
    });
  }

  /** The takes of a timeline that have no focus track yet (docs/design/finishing.md#auto-reframe-and-cut-downs). */
  takesWithoutFocus(
    t: Timeline,
    docs: Pick<ProjectDocs, 'clips'>,
  ): { clipId: string; shotId: string; takeId: string }[] {
    const out = new Map<string, { clipId: string; shotId: string; takeId: string }>();
    for (const item of t.tracks.find((x) => x.kind === 'video')?.items ?? []) {
      if (item.kind !== 'video' || item.source.type !== 'take') continue;
      const { clipId, shotId, takeId } = item.source;
      const take = docs.clips[clipId]?.shots.find((s) => s.id === shotId)?.takes.find((x) => x.id === takeId);
      if (take && !take.focus?.length && !isStillMedia(item.source.media))
        out.set(takeId, { clipId, shotId, takeId });
    }
    return [...out.values()];
  }

  /** The timeline reframed to the aspect with the takes' focus tracks. */
  reframe(t: Timeline, aspect: DeliveryAspect, docs: Pick<ProjectDocs, 'clips'>): Timeline {
    if (aspect === 'source') return t;
    const focusByTake: Record<string, FocusPoint[] | null> = {};
    for (const clip of Object.values(docs.clips))
      for (const shot of clip.shots) for (const take of shot.takes) focusByTake[take.id] = take.focus;
    return reframeTimeline(t, { aspect, focusByTake });
  }

  /** SRT and WebVTT of a timeline's captions as project media (null without captions). */
  async subtitleFiles(
    projectId: string,
    t: Timeline,
    name: string,
  ): Promise<{ srt: MediaRef; vtt: MediaRef } | null> {
    const cues = subtitleCues(t);
    if (!cues.length) return null;
    const put = (text: string, mime: string) =>
      this.deps.media.putBuffer(projectId, Buffer.from(text, 'utf8'), {
        kind: 'subtitles',
        name,
        mime,
        probe: false,
      });
    return { srt: await put(toSrt(cues), 'application/x-subrip'), vtt: await put(toVtt(cues), 'text/vtt') };
  }

  async exports(projectId: string): Promise<Export[]> {
    const docs = await this.deps.projects.docs(projectId);
    return Object.values(docs.exports).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Resolves characters for the timeline (used by exports and the UI). */
  async characters(projectId: string): Promise<Record<string, Character>> {
    return (await this.deps.projects.docs(projectId)).characters;
  }

  async clips(projectId: string): Promise<Clip[]> {
    return sortedClips(await this.deps.projects.docs(projectId));
  }
}

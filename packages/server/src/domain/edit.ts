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
  disclosureFor,
  docPath,
  docsFromEntries,
  type EditSuggestion,
  type Export,
  ExportLoudnessSchema,
  type ExportQuality,
  emptyTimeline,
  isStillMedia,
  type Job,
  type LoudnessTarget,
  newId,
  type Project,
  type RenderEngineChoice,
  type Resource,
  sortedClips,
  type Timeline,
  type TimelineOp,
} from '@rideo/shared';
import { AppError, invalid, notFound } from '../errors';
import { Service } from './base';

function opSummary(ops: TimelineOp[]): string {
  const counts = new Map<string, number>();
  for (const o of ops) counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  return [...counts].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(', ');
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
    } = {},
  ): Promise<{ export: Export; job: Job }> {
    const source = opts.source ?? 'timeline';
    const loudness = opts.loudness ?? 'streaming';
    const stems = !!opts.stems;
    await this.exportPrecheck(projectId, source);
    const quality = opts.quality ?? 'standard';
    const engine = opts.engine ?? 'auto';
    const h = await this.deps.projects.existing(projectId);
    const timelineCommit = (await h.repo.snapshot()).commit;
    // The visible disclosure label (docs/design/provenance.md#disclosure-label): resolved here, drawn by the tab.
    const disclosure = disclosureFor(await this.deps.projects.docs(projectId));
    const exp: Export = {
      id: newId('export'),
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
    };
    await this.mutate(actor, projectId, (tx) => tx.set(docPath.export(exp.id), exp), {
      message: `Queue ${quality} ${source === 'animatic' ? 'animatic ' : ''}export`,
    });
    const job = await this.deps.jobs.enqueue({
      projectId,
      kind: 'export.render',
      params: {
        exportId: exp.id,
        quality,
        engine,
        chunkSec: 30,
        timelineCommit,
        timelinePath: source === 'animatic' ? 'animatic.json' : 'timeline.json',
        disclosure: disclosure.label ? { text: disclosure.text, position: disclosure.position } : null,
        stems,
      },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `export:${exp.id}`,
      maxAttempts: 5,
    });
    return { export: exp, job };
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

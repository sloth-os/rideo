import {
  type Actor,
  type Analysis,
  AnalysisSignalsParamsSchema,
  AnalysisSignalsResultSchema,
  docPath,
  EditorClaimInputSchema,
  EditorFailInputSchema,
  EditorHeartbeatInputSchema,
  type Export,
  ExportRenderParamsSchema,
  ExportRenderResultSchema,
  isEditorJob,
  isTerminalJob,
  type Job,
  MediaProcessParamsSchema,
  MediaProcessResultSchema,
  type MediaRef,
  type Resource,
} from '@rideo/shared';
import type { z } from 'zod';
import { AppError, invalid, notFound } from '../errors';
import { mediaFields } from '../media/store';
import { Service } from './base';

type Parsed<S extends z.ZodType> = z.infer<S>;

/**
 * Editor jobs (docs/design/editor.md#editor-jobs): studio tabs claim `client`-lane jobs, run them with their
 * editor engine, stage the outputs here and complete them; this service validates and applies the results
 * and starts the follow-up server jobs.
 */
export class EditorService extends Service {
  private actorFor(job: Job): Actor {
    return {
      kind: 'system',
      id: 'rideo',
      name: 'Rideo',
      onBehalfOf: { kind: job.actor.kind, id: job.actor.id, name: job.actor.name },
    };
  }

  private get staging() {
    return this.deps.staging;
  }

  job(jobId: string): Job {
    const job = this.deps.jobs.find(jobId);
    if (!job || !isEditorJob(job)) throw notFound(`editor job ${jobId}`);
    return job;
  }

  async claim(projectId: string, raw: unknown): Promise<Job | null> {
    const input = EditorClaimInputSchema.parse({ ...(raw as object), projectId });
    await this.deps.projects.existing(projectId);
    if (!this.deps.hub.isSubscribed(input.sessionId, projectId))
      throw new AppError('conflict', 'this live session does not follow the project; subscribe first');
    const job = await this.deps.jobs.claim(projectId, input.sessionId, input.kinds);
    if (job?.kind === 'export.render') await this.markRendering(job);
    return job;
  }

  heartbeat(jobId: string, raw: unknown) {
    const input = EditorHeartbeatInputSchema.parse(raw);
    return this.deps.jobs.heartbeat(jobId, input.sessionId, input.progress);
  }

  async stageFile(jobId: string, sessionId: string, name: string, body: NodeJS.ReadableStream) {
    const job = this.deps.jobs.assertLease(jobId, sessionId);
    const size = await this.staging.write(jobId, name, body, this.deps.config.editor.fileMaxBytes);
    this.deps.metrics.editorStagedBytes.inc({ kind: job.kind }, size);
    await this.deps.jobs.staged(jobId, sessionId, name);
    return { name, size };
  }

  async complete(jobId: string, raw: unknown): Promise<Job> {
    const { sessionId, result } = raw as { sessionId?: unknown; result?: unknown };
    if (typeof sessionId !== 'string') throw invalid('sessionId is required');
    const job = this.deps.jobs.assertLease(jobId, sessionId);
    let applied: unknown;
    switch (job.kind) {
      case 'media.process':
        applied = await this.applyMediaProcess(job, MediaProcessResultSchema.parse(result));
        break;
      case 'analysis.signals':
        applied = await this.applySignals(job, AnalysisSignalsResultSchema.parse(result));
        break;
      case 'export.render':
        applied = await this.applyRender(job, ExportRenderResultSchema.parse(result));
        break;
      default:
        throw invalid(`${job.kind} is not an editor job`);
    }
    return this.deps.jobs.completeEditor(jobId, sessionId, applied);
  }

  async fail(jobId: string, raw: unknown): Promise<Job> {
    const input = EditorFailInputSchema.parse(raw);
    return this.deps.jobs.failEditor(jobId, input.sessionId, input.error);
  }

  private async requireStaged(job: Job, names: string[]): Promise<void> {
    for (const name of names) {
      if (!job.staged.includes(name) || !(await this.staging.exists(job.id, name)))
        throw invalid(`file ${name} was not uploaded for job ${job.id}`);
    }
  }

  private async applyMediaProcess(job: Job, result: Parsed<typeof MediaProcessResultSchema>) {
    const { resourceId } = MediaProcessParamsSchema.parse(job.params);
    const docs = await this.deps.projects.docs(job.projectId, job.branch);
    const r = docs.resources[resourceId];
    if (!r) throw notFound(`resource ${resourceId}`);
    let poster: MediaRef | undefined;
    if (result.poster) {
      await this.requireStaged(job, [result.poster]);
      poster = await this.deps.media.putFile(job.projectId, this.staging.path(job.id, result.poster), {
        kind: 'posters',
        name: 'poster',
        stem: r.media.hash.slice(0, 12),
        mime: 'image/jpeg',
        probe: false,
      });
    }
    const mismatch =
      (r.kind === 'video' && !result.probe.hasVideo) || (r.kind === 'audio' && !result.probe.hasAudio);
    await this.mutate(
      this.actorFor(job),
      job.projectId,
      (tx) => {
        const cur = tx.require<Resource>(docPath.resource(resourceId), `resource ${resourceId}`);
        const next: Resource = {
          ...cur,
          media: {
            ...cur.media,
            ...mediaFields(result.probe, cur.media.mime),
            ...(poster ? { poster: { path: poster.path, mime: poster.mime } } : {}),
          },
          status: mismatch ? 'failed' : 'ready',
        };
        if (mismatch) next.error = `the file has no ${r.kind} stream`;
        else delete next.error;
        tx.set(docPath.resource(resourceId), next);
      },
      { message: `Process ${r.name}`, branch: job.branch },
    );
    await this.staging.remove(job.id);
    return { resourceId, ready: !mismatch };
  }

  private async applySignals(job: Job, result: Parsed<typeof AnalysisSignalsResultSchema>) {
    const params = AnalysisSignalsParamsSchema.parse(job.params);
    await this.requireStaged(job, [
      ...result.thumbnails.map((t) => t.file),
      ...(result.speech ? [result.speech] : []),
    ]);
    const thumbs = new Map<number, MediaRef>();
    for (const t of result.thumbnails) {
      if (t.sceneIndex >= result.signals.scenes.length)
        throw invalid(`thumbnail for unknown scene ${t.sceneIndex}`);
      thumbs.set(
        t.sceneIndex,
        await this.deps.media.putFile(job.projectId, this.staging.path(job.id, t.file), {
          kind: 'thumbs',
          name: `${params.analysisId}-scene-${t.sceneIndex}`,
          mime: 'image/jpeg',
          probe: false,
        }),
      );
    }
    const p = result.probe;
    await this.mutate(
      this.actorFor(job),
      job.projectId,
      (tx) => {
        const cur = tx.require<Analysis>(
          docPath.analysis(params.analysisId),
          `analysis ${params.analysisId}`,
        );
        tx.set(docPath.analysis(params.analysisId), {
          ...cur,
          probe: {
            durationSec: p.durationSec,
            width: p.width ?? 0,
            height: p.height ?? 0,
            fps: p.fps ?? 0,
            hasAudio: p.hasAudio,
          },
          scenes: result.signals.scenes.map((s, i) => ({
            ...s,
            ...(thumbs.has(i) ? { thumbnail: thumbs.get(i)! } : {}),
          })),
          silences: result.signals.silences,
          blackSegments: result.signals.blackSegments,
          loudness: result.signals.loudness,
        });
      },
      {
        message: `Footage signals: ${result.signals.scenes.length} scene(s), ${result.signals.silences.length} silence(s)`,
        branch: job.branch,
      },
    );
    const next = await this.deps.jobs.enqueue({
      projectId: job.projectId,
      kind: 'analysis.suggest',
      params: {
        analysisId: params.analysisId,
        ...(result.speech ? { speech: { jobId: job.id, name: result.speech } } : {}),
      },
      actor: job.actor,
      branch: job.branch,
      priority: job.priority,
      dedupeKey: `suggest:${params.analysisId}`,
    });
    return { analysisId: params.analysisId, next: next.id };
  }

  private async applyRender(job: Job, result: Parsed<typeof ExportRenderResultSchema>) {
    const params = ExportRenderParamsSchema.parse(job.params);
    if (result.width % 2 || result.height % 2 || result.width > 8192 || result.height > 8192)
      throw invalid('render size must be even and at most 8192 px');
    await this.requireStaged(job, [...result.parts, ...(result.soundtrack ? [result.soundtrack] : [])]);
    await this.setExport(
      job,
      params.exportId,
      {
        status: 'finishing',
        engine: result.engine,
        width: result.width,
        height: result.height,
        durationSec: result.durationSec,
      },
      `Rendered export ${params.exportId.slice(-6)} in the browser (${result.engine}, ${result.parts.length} part(s))`,
    );
    const next = await this.deps.jobs.enqueue({
      projectId: job.projectId,
      kind: 'export.finish',
      params: { exportId: params.exportId, renderJobId: job.id, ...result },
      actor: job.actor,
      branch: job.branch,
      priority: job.priority,
      dedupeKey: `finish:${params.exportId}`,
      maxAttempts: 2,
    });
    return { exportId: params.exportId, next: next.id };
  }

  private async setExport(
    job: Job,
    exportId: string,
    patch: Partial<Export>,
    message: string,
  ): Promise<void> {
    await this.mutate(
      this.actorFor(job),
      job.projectId,
      (tx) => {
        const cur = tx.require<Export>(docPath.export(exportId), `export ${exportId}`);
        tx.set(docPath.export(exportId), { ...cur, ...patch });
      },
      { message, branch: job.branch },
    );
  }

  private async markRendering(job: Job): Promise<void> {
    const { exportId } = ExportRenderParamsSchema.parse(job.params);
    const exp = (await this.deps.projects.docs(job.projectId, job.branch)).exports[exportId];
    if (exp && exp.status === 'queued')
      await this.setExport(
        job,
        exportId,
        { status: 'rendering', jobId: job.id },
        `Rendering export ${exportId.slice(-6)} in a studio tab`,
      );
  }

  /** An editor job gave up (failed or cancelled): record it on its document and drop its staged files. */
  async ended(job: Job): Promise<void> {
    if (!isTerminalJob(job) || job.status === 'succeeded') return;
    const reason = job.error?.message ?? job.status;
    try {
      if (job.kind === 'media.process') {
        const { resourceId } = MediaProcessParamsSchema.parse(job.params);
        await this.mutate(
          this.actorFor(job),
          job.projectId,
          (tx) => {
            const cur = tx.get<Resource>(docPath.resource(resourceId));
            if (cur && cur.status === 'processing')
              tx.set(docPath.resource(resourceId), {
                ...cur,
                status: 'failed',
                error: reason.slice(0, 2000),
              });
          },
          { message: `Processing failed: ${reason.slice(0, 120)}`, branch: job.branch },
        );
      } else if (job.kind === 'analysis.signals') {
        const { analysisId } = AnalysisSignalsParamsSchema.parse(job.params);
        await this.mutate(
          this.actorFor(job),
          job.projectId,
          (tx) => {
            const cur = tx.get<Analysis>(docPath.analysis(analysisId));
            if (cur && cur.status === 'running')
              tx.set(docPath.analysis(analysisId), {
                ...cur,
                status: 'failed',
                error: reason.slice(0, 2000),
              });
          },
          { message: `Analysis failed: ${reason.slice(0, 120)}`, branch: job.branch },
        );
      } else if (job.kind === 'export.render') {
        const { exportId } = ExportRenderParamsSchema.parse(job.params);
        const exp = (await this.deps.projects.docs(job.projectId, job.branch)).exports[exportId];
        if (exp && exp.status !== 'succeeded' && exp.status !== 'failed')
          await this.setExport(
            job,
            exportId,
            { status: 'failed', error: reason.slice(0, 4000) },
            `Export ${exportId.slice(-6)} failed`,
          );
      }
    } finally {
      await this.staging.remove(job.id);
    }
  }

  /** Tabs that follow the project (they claim its editor jobs). */
  editorSessions(projectId: string) {
    return this.deps.hub.sessionsFor(projectId).map((s) => ({
      sessionId: s.sessionId,
      engine: s.presence?.engine ?? null,
      route: s.presence?.route ?? null,
    }));
  }

  /** The hint MCP tools add to editor-job results. */
  editorHint(projectId: string): { editorSessions: number; waitingFor?: 'editor' } {
    const n = this.editorSessions(projectId).length;
    return n > 0 ? { editorSessions: n } : { editorSessions: 0, waitingFor: 'editor' };
  }
}

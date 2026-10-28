import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GatewayTask, MediaRef, ProjectDocs } from '@rideo/shared';
import type { AiReviewService } from '../../domain/ai-review';
import type { ClipService } from '../../domain/clips';
import type { Deps } from '../../domain/deps';
import type { EditService } from '../../domain/edit';
import type { ElementService } from '../../domain/elements';
import type { FeedbackService } from '../../domain/feedback';
import type { ProjectService } from '../../domain/projects';
import type { RecipeService } from '../../domain/recipes';
import type { SearchService } from '../../domain/search';
import type { StoryService } from '../../domain/story';
import type { StoryboardService } from '../../domain/storyboard';
import type { VoiceService } from '../../domain/voices';
import type { WorkflowService } from '../../domain/workflow';
import type { GenerateOptions } from '../../gateway/gateway-client';
import { LANE_PEAKS_PER_SEC, makePeaks, makeStrip } from '../../media/lanes';
import { makePoster } from '../../media/poster';
import type { Tx } from '../../vcs/repo';
import type { JobContext } from '../queue';

export interface HandlerDeps extends Deps {
  services: {
    projects: ProjectService;
    workflow: WorkflowService;
    story: StoryService;
    elements: ElementService;
    voices: VoiceService;
    storyboard: StoryboardService;
    clips: ClipService;
    edit: EditService;
    recipes: RecipeService;
    search: SearchService;
    feedback: FeedbackService;
    aiReviews: AiReviewService;
  };
}

/** Commits as the job's system actor on the job's branch, tagged with meta.jobId (idempotent re-runs). */
export async function commitAs<R>(
  deps: HandlerDeps,
  ctx: JobContext,
  fn: (tx: Tx) => R | Promise<R>,
  message: string | ((r: R) => string),
  meta: Record<string, unknown> = {},
) {
  const h = await deps.projects.existing(ctx.job.projectId);
  const out = await h.repo.transact(fn, {
    actor: ctx.actor,
    message,
    branch: ctx.job.branch,
    meta: { jobId: ctx.job.id, ...meta },
  });
  if (out.commit) deps.hub.activity(ctx.job.projectId, ctx.actor, ctx.job.kind, out.commit.message);
  return out;
}

export function docsFor(deps: HandlerDeps, ctx: JobContext): Promise<ProjectDocs> {
  return deps.projects.docs(ctx.job.projectId, ctx.job.branch);
}

export function gatewayOptions(
  ctx: JobContext,
  modality: 'image' | 'video' | 'music',
  step: string,
  attempt = 0,
): GenerateOptions {
  const idempotencyKey = `${ctx.job.id}:${step}:${attempt}`;
  return {
    idempotencyKey,
    signal: ctx.signal,
    metadata: { rideo_project: ctx.job.projectId, rideo_job: ctx.job.id, rideo_step: step },
    onTask: (t: GatewayTask) =>
      ctx.gatewayTask({ modality, id: t.id, status: t.status, idempotencyKey, model: t.model || undefined }),
  };
}

/**
 * Adds the editor's lane files to stored media (docs/design/editor.md#waveforms-and-filmstrips): its waveform peaks
 * and its filmstrip, so the tab does not decode the whole file to draw its lanes. Best effort: media without them is
 * drawn by the tab, as before.
 */
export async function withLanes(
  deps: Deps,
  projectId: string,
  local: string,
  ref: MediaRef,
  signal?: AbortSignal,
): Promise<MediaRef> {
  if (!/^(video|audio)\//.test(ref.mime)) return ref;
  const stem = ref.hash.slice(0, 12);
  try {
    return await deps.media.withTmpDir(async (dir) => {
      const lanes: NonNullable<MediaRef['lanes']> = {};
      const peaks =
        ref.hasAudio === false ? null : await makePeaks(deps.ff, local, dir, signal).catch(() => null);
      if (peaks?.length) {
        const file = join(dir, 'peaks.json');
        await writeFile(file, JSON.stringify({ perSec: LANE_PEAKS_PER_SEC, peaks }));
        const stored = await deps.media.putFile(projectId, file, {
          kind: 'lanes',
          name: 'peaks',
          stem: `${stem}-peaks`,
          mime: 'application/json',
          probe: false,
        });
        lanes.peaks = { path: stored.path, perSec: LANE_PEAKS_PER_SEC };
      }
      const strip = ref.mime.startsWith('video/') ? await makeStrip(deps.ff, local, dir, ref, signal) : null;
      if (strip) {
        const stored = await deps.media.putFile(projectId, strip.file, {
          kind: 'lanes',
          name: 'strip',
          stem: `${stem}-strip`,
          mime: 'image/jpeg',
          probe: false,
        });
        const { file: _, ...shape } = strip;
        lanes.strip = { path: stored.path, ...shape };
      }
      return lanes.peaks || lanes.strip ? { ...ref, lanes } : ref;
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    deps.log?.warn?.(
      { projectId, path: ref.path, err: (err as Error).message },
      'could not make the lane files',
    );
    return ref;
  }
}

/** Adds the JPEG poster to a stored video (generated takes; there are no server-side proxies). */
export async function withPoster(
  deps: Deps,
  projectId: string,
  local: string,
  ref: MediaRef,
  signal?: AbortSignal,
): Promise<MediaRef> {
  if (!ref.mime.startsWith('video/')) return ref;
  const posterTmp = deps.media.tmp('jpg');
  try {
    await makePoster(deps.ff, local, Math.min(1, (ref.durationSec ?? 2) / 2), posterTmp, signal);
    const poster = await deps.media.putFile(projectId, posterTmp, {
      kind: 'posters',
      name: 'poster',
      stem: ref.hash.slice(0, 12),
      mime: 'image/jpeg',
      probe: false,
    });
    return { ...ref, poster: { path: poster.path, mime: poster.mime } };
  } finally {
    await rm(posterTmp, { force: true });
  }
}

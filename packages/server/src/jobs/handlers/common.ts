import { rm } from 'node:fs/promises';
import type { GatewayTask, MediaRef, ProjectDocs } from '@rideo/shared';
import type { ClipService } from '../../domain/clips';
import type { Deps } from '../../domain/deps';
import type { EditService } from '../../domain/edit';
import type { ElementService } from '../../domain/elements';
import type { ProjectService } from '../../domain/projects';
import type { StoryService } from '../../domain/story';
import type { VoiceService } from '../../domain/voices';
import type { WorkflowService } from '../../domain/workflow';
import type { GenerateOptions } from '../../gateway/gateway-client';
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
    clips: ClipService;
    edit: EditService;
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

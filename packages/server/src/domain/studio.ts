import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Actor, AutoActionId, ProjectDocs } from '@rideo/shared';
import { sortedClips } from '@rideo/shared';
import { createAdapter, SttClient } from '../ai/llm';
import { LlmTasks } from '../ai/tasks';
import type { Config } from '../config';
import { OffJudge, VisionLlmJudge } from '../consistency/judge';
import { AppError } from '../errors';
import { GatewayClient } from '../gateway/gateway-client';
import { ProxyClient } from '../gateway/proxy-client';
import { batchGenerate, clipGenerate, clipPlan } from '../jobs/handlers/clips';
import type { HandlerDeps } from '../jobs/handlers/common';
import { analysisSuggest, editAuto, exportFinish, timelineAssemble } from '../jobs/handlers/media';
import { shotGenerate } from '../jobs/handlers/shot';
import {
  characterDescribe,
  characterRefs,
  musicGenerate,
  screenplayExtend,
  screenplayGenerate,
} from '../jobs/handlers/story';
import { JobQueue } from '../jobs/queue';
import { LiveHub } from '../live/hub';
import { Ffmpeg } from '../media/ffmpeg';
import { Staging } from '../media/staging';
import { MediaStore } from '../media/store';
import { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import { Layout } from '../storage/layout';
import { WatermarkService } from '../watermark/service';
import { ClipService } from './clips';
import type { Deps, Logger } from './deps';
import { EditService } from './edit';
import { EditorService } from './editor';
import { HistoryService } from './history';
import { ProjectService } from './projects';
import { ProjectRegistry } from './registry';
import { StoryService } from './story';
import { UiService } from './ui';
import { WorkflowService } from './workflow';

export interface Studio {
  config: Config;
  deps: HandlerDeps;
  projects: ProjectService;
  workflow: WorkflowService;
  story: StoryService;
  clips: ClipService;
  edit: EditService;
  editor: EditorService;
  history: HistoryService;
  ui: UiService;
  start(): Promise<void>;
  stop(): Promise<void>;
  userActor(): Actor;
  detectWatermark(file: string): ReturnType<WatermarkService['detectVideo']>;
}

/** Composition root: builds every service, registers job handlers and autopilot actions. */
export function createStudio(
  config: Config,
  opts: { log: Logger; storage: StorageBackend; metrics?: Metrics },
): Studio {
  const metrics = opts.metrics ?? new Metrics();
  const log = opts.log;
  const layout = new Layout(config.webdav.root);
  const storage = opts.storage;
  const hub = new LiveHub({ metrics, log });
  const ff = new Ffmpeg({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath });
  const media = new MediaStore({
    storage,
    layout,
    ff,
    dataDir: config.dataDir,
    maxCacheBytes: config.cacheMaxBytes,
    log,
  });
  const proxy = new ProxyClient({ baseUrl: config.gateway.url, apiKey: config.gateway.apiKey });
  const llm = new LlmTasks(createAdapter(proxy, config.llm), createAdapter(proxy, config.vision), {
    metrics,
    log: log.child({ component: 'llm' }),
  });
  const gateway = new GatewayClient({
    url: config.gateway.url,
    apiKey: config.gateway.apiKey,
    routingProfile: config.gateway.routingProfile,
    pollMs: config.gateway.pollMs,
    timeoutsSec: config.gateway.timeoutsSec,
    metrics,
    log: log.child({ component: 'gateway' }),
  });
  const watermark = new WatermarkService({
    ff,
    storage,
    layout,
    metrics,
    dataDir: config.dataDir,
    key: config.watermark.key,
    oldKeys: config.watermark.oldKeys,
    strength: config.watermark.strength,
    brand: config.brand,
    log,
  });
  const jobs = new JobQueue({
    storage,
    layout,
    hub,
    metrics,
    log: log.child({ component: 'jobs' }),
    lanes: config.lanes,
    editorLeaseMs: config.editor.leaseSec * 1000,
  });
  const staging = new Staging(config.dataDir);
  const projectsRegistry = new ProjectRegistry({
    storage,
    layout,
    hub,
    metrics,
    coalesceWindowMs: config.coalesceWindowSec * 1000,
    log,
  });
  const deps: Deps = {
    config,
    log,
    metrics,
    storage,
    layout,
    projects: projectsRegistry,
    media,
    ff,
    gateway,
    llm,
    judge: config.consistency.judge === 'off' ? new OffJudge() : new VisionLlmJudge(llm),
    offJudge: new OffJudge(),
    watermark,
    hub,
    jobs,
    staging,
    ...(config.stt ? { stt: new SttClient(proxy, config.stt.domain, config.stt.model) } : {}),
  };
  const services = {
    projects: new ProjectService(deps),
    workflow: new WorkflowService(deps),
    story: new StoryService(deps),
    clips: new ClipService(deps),
    edit: new EditService(deps),
    editor: new EditorService(deps),
  };
  // Editor jobs: failures and cancellations are recorded on their documents; a closed tab releases its jobs.
  jobs.onEditorJobEnded = (job) => services.editor.ended(job);
  hub.onSessionClosed((sessionId) => void jobs.releaseSession(sessionId));
  const handlerDeps: HandlerDeps = { ...deps, services };
  const reg = (
    kind: Parameters<JobQueue['register']>[0],
    fn: (d: HandlerDeps, ctx: Parameters<Parameters<JobQueue['register']>[1]>[0]) => Promise<unknown>,
  ) => jobs.register(kind, (ctx) => fn(handlerDeps, ctx));
  reg('screenplay.generate', screenplayGenerate);
  reg('screenplay.extend', screenplayExtend);
  reg('character.refs', characterRefs);
  reg('character.describe', characterDescribe);
  reg('music.generate', musicGenerate);
  reg('clip.plan', clipPlan);
  reg('clip.generate', clipGenerate);
  reg('shot.generate', shotGenerate);
  reg('batch.generate', batchGenerate);
  reg('analysis.suggest', analysisSuggest);
  reg('export.finish', exportFinish);
  reg('edit.auto', editAuto);
  reg('timeline.assemble', timelineAssemble);

  services.workflow.autoActions = {
    async run(action: AutoActionId, projectId: string, docs: ProjectDocs, actor: Actor) {
      const branch = await projectsRegistry.handle(projectId).repo.currentBranch();
      switch (action) {
        case 'screenplay.generate':
          if (!docs.screenplay) await services.story.generateScreenplay(actor, projectId);
          return;
        case 'characters.generateRefs':
          for (const c of Object.values(docs.characters)) {
            if (!c.lock.locked && c.references.length === 0)
              await services.story.generateReferences(actor, projectId, c.id);
          }
          return;
        case 'clip.pilot': {
          const scene = docs.screenplay?.scenes.slice().sort((a, b) => a.index - b.index)[0];
          if (!scene) return;
          const clip = sortedClips(docs).find((c) => c.sceneId === scene.id);
          if (!clip) await services.clips.planClip(actor, projectId, scene.id, { thenGenerate: true });
          else if (clip.shots.some((s) => s.takes.length === 0))
            await services.clips.generateClip(actor, projectId, clip.id);
          return;
        }
        case 'batch.generate':
          await services.clips.startBatch(actor, projectId);
          return;
        case 'timeline.assemble':
          if (!docs.timeline?.tracks.some((t) => t.kind === 'video' && t.items.length)) {
            await jobs.enqueue({
              projectId,
              kind: 'timeline.assemble',
              params: {},
              actor,
              branch,
              dedupeKey: 'assemble',
            });
          }
          return;
        case 'analysis.start': {
          const video = Object.values(docs.resources)
            .filter((r) => r.kind === 'video' && r.role === 'source' && r.status === 'ready')
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .find((r) => !Object.values(docs.analyses).some((a) => a.resourceId === r.id));
          if (video) await services.edit.analyze(actor, projectId, video.id);
          return;
        }
        case 'edit.auto': {
          const analysis = Object.values(docs.analyses)
            .filter((a) => a.status === 'completed')
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          if (analysis && !docs.timeline?.tracks.some((t) => t.kind === 'video' && t.items.length)) {
            await jobs.enqueue({
              projectId,
              kind: 'edit.auto',
              params: { analysisId: analysis.id },
              actor,
              branch,
              dedupeKey: 'edit.auto',
            });
          }
          return;
        }
      }
    },
  };

  let syncTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  const sweepStaging = () =>
    staging
      .sweep((jobId) => {
        const job = jobs.find(jobId);
        return !!job && (job.status === 'queued' || job.status === 'running');
      })
      .then((n) => n && log.info({ removed: n }, 'removed stale editor-job staging folders'))
      .catch((err) => log.warn({ err }, 'staging sweep failed'));
  const syncing = new Set<string>();
  return {
    config,
    deps: handlerDeps,
    ...services,
    history: new HistoryService(deps),
    ui: new UiService(hub),
    userActor: () => ({ kind: 'user', id: config.user.id, name: config.user.name }),
    detectWatermark: (file) => watermark.detectVideo(file),
    async start() {
      await mkdir(join(config.dataDir), { recursive: true });
      await media.init();
      await watermark.init();
      let recovered = 0;
      for (const id of await projectsRegistry.listIds()) {
        try {
          recovered += await jobs.loadProject(id, config.jobRecovery);
        } catch (err) {
          log.warn({ err, projectId: id }, 'could not load job records');
        }
      }
      if (recovered) log.info({ recovered }, 'recovered interrupted jobs');
      await sweepStaging();
      sweepTimer = setInterval(sweepStaging, 3600_000);
      sweepTimer.unref();
      if (config.webdav.syncIntervalSec > 0) {
        syncTimer = setInterval(() => {
          for (const projectId of hub.subscribedProjects()) {
            if (syncing.has(projectId)) continue;
            syncing.add(projectId);
            services.projects
              .sync(projectId)
              .catch((err) => {
                if (!(err instanceof AppError && err.code === 'not_found'))
                  log.warn({ err: (err as Error).message, projectId }, 'WebDAV sync failed');
              })
              .finally(() => syncing.delete(projectId));
          }
        }, config.webdav.syncIntervalSec * 1000);
        syncTimer.unref();
      }
    },
    async stop() {
      if (syncTimer) clearInterval(syncTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      await jobs.shutdown();
      hub.close();
    },
  };
}

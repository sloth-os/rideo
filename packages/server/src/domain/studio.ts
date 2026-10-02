import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Actor, AutoActionId, ProjectDocs } from '@rideo/shared';
import {
  checkRequirement,
  dialogueMode,
  elementsInUse,
  sortedClips,
  speakingCharacters,
  voiceOf,
} from '@rideo/shared';
import { createAdapter, SttClient } from '../ai/llm';
import { SfxClient } from '../ai/sfx';
import { LlmTasks } from '../ai/tasks';
import { createTts } from '../ai/tts';
import { AccountsService } from '../auth/accounts';
import { currentPrincipal } from '../auth/context';
import { NotificationService } from '../auth/notifications';
import type { Config } from '../config';
import { OffJudge, VisionLlmJudge } from '../consistency/judge';
import { LlmVoiceJudge } from '../consistency/voice';
import { AppError } from '../errors';
import { GatewayClient } from '../gateway/gateway-client';
import { ProxyClient } from '../gateway/proxy-client';
import { batchGenerate, clipGenerate, clipPlan } from '../jobs/handlers/clips';
import type { HandlerDeps } from '../jobs/handlers/common';
import { exportPrepare } from '../jobs/handlers/finishing';
import { localizeGenerate } from '../jobs/handlers/localize';
import { maskGenerate } from '../jobs/handlers/mask';
import { analysisSuggest, editAuto, exportFinish, timelineAssemble } from '../jobs/handlers/media';
import { scoreGenerate, sfxGenerate } from '../jobs/handlers/post-audio';
import { recipeRun } from '../jobs/handlers/recipe';
import { shotGenerate } from '../jobs/handlers/shot';
import { shotGroup } from '../jobs/handlers/shot-group';
import {
  characterDescribe,
  characterRefs,
  elementRefs,
  musicGenerate,
  screenplayExtend,
  screenplayGenerate,
} from '../jobs/handlers/story';
import { shotBoard, storyboardGenerate } from '../jobs/handlers/storyboard';
import { takeEdit, takeExtend, timelineExtend } from '../jobs/handlers/take-edit';
import { voiceDesign } from '../jobs/handlers/voice';
import { voicesCast } from '../jobs/handlers/voices-cast';
import { JobQueue } from '../jobs/queue';
import { LiveHub } from '../live/hub';
import { Ffmpeg } from '../media/ffmpeg';
import { Staging } from '../media/staging';
import { MediaStore } from '../media/store';
import { Metrics } from '../metrics';
import { C2paService } from '../provenance/c2pa';
import type { StorageBackend } from '../storage/backend';
import { Layout } from '../storage/layout';
import { VERSION } from '../version';
import { WatermarkService } from '../watermark/service';
import { BrandService } from './brand';
import { ClipService } from './clips';
import type { Deps, Logger } from './deps';
import { EditService } from './edit';
import { EditorService } from './editor';
import { ElementService } from './elements';
import { HistoryService } from './history';
import { InterchangeService } from './interchange';
import { LocalizationService } from './localization';
import { ProjectService } from './projects';
import { RecipeService } from './recipes';
import { ProjectRegistry } from './registry';
import { ReviewService } from './review';
import { StoryService } from './story';
import { StoryboardService } from './storyboard';
import { UiService } from './ui';
import { VoiceService } from './voices';
import { WorkflowService } from './workflow';

export interface Studio {
  config: Config;
  deps: HandlerDeps;
  projects: ProjectService;
  workflow: WorkflowService;
  story: StoryService;
  elements: ElementService;
  voices: VoiceService;
  storyboard: StoryboardService;
  clips: ClipService;
  edit: EditService;
  localization: LocalizationService;
  review: ReviewService;
  interchange: InterchangeService;
  recipes: RecipeService;
  brand: BrandService;
  editor: EditorService;
  history: HistoryService;
  ui: UiService;
  start(): Promise<void>;
  stop(): Promise<void>;
  userActor(): Actor;
  /** Both detectors on a file: the invisible watermark and the C2PA manifest (docs/design/provenance.md#verification). */
  detectWatermark(file: string): Promise<Detection>;
}

export type Detection = Awaited<ReturnType<WatermarkService['detectVideo']>> & {
  contentCredentials: Awaited<ReturnType<C2paService['read']>> & { bound?: boolean };
};

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
    ...(config.voiceJudge ? { audio: createAdapter(proxy, config.voiceJudge) } : {}),
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
  const c2pa = new C2paService(
    {
      ...config.c2pa,
      dataDir: config.dataDir,
      generator: { name: config.brand.name || 'Rideo', version: VERSION },
    },
    { log: log.child({ component: 'c2pa' }), metrics },
  );
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
  const accounts = new AccountsService({
    config,
    storage,
    layout,
    projects: projectsRegistry,
    metrics,
    log: log.child({ component: 'accounts' }),
  });
  const notifications = new NotificationService(join(config.dataDir, 'notifications'), hub);
  const deps: Deps = {
    accounts,
    notifications,
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
    c2pa,
    hub,
    jobs,
    staging,
    ...(config.stt ? { stt: new SttClient(proxy, config.stt.domain, config.stt.model) } : {}),
    ...(config.tts ? { tts: createTts(proxy, config.tts, metrics) } : {}),
    ...(config.sfx ? { sfx: new SfxClient(proxy, config.sfx, metrics) } : {}),
    voiceJudge: config.voiceJudge ? new LlmVoiceJudge(llm) : null,
  };
  const workflow = new WorkflowService(deps);
  const services = {
    projects: new ProjectService(deps),
    workflow,
    story: new StoryService(deps),
    elements: new ElementService(deps),
    voices: new VoiceService(deps),
    storyboard: new StoryboardService(deps),
    clips: new ClipService(deps),
    edit: new EditService(deps),
    localization: new LocalizationService(deps),
    review: new ReviewService(deps, workflow),
    interchange: new InterchangeService(deps),
    recipes: new RecipeService(deps),
    brand: new BrandService(deps),
    editor: new EditorService(deps),
  } satisfies Record<string, unknown>;
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
  reg('element.refs', elementRefs);
  reg('voice.design', voiceDesign);
  reg('storyboard.generate', storyboardGenerate);
  reg('shot.board', shotBoard);
  reg('take.edit', takeEdit);
  reg('take.extend', takeExtend);
  reg('timeline.extend', timelineExtend);
  reg('mask.generate', maskGenerate);
  reg('recipe.run', recipeRun);
  reg('voices.cast', voicesCast);
  reg('music.generate', musicGenerate);
  reg('score.generate', scoreGenerate);
  reg('sfx.generate', sfxGenerate);
  reg('localize.generate', localizeGenerate);
  reg('export.prepare', exportPrepare);
  reg('clip.plan', clipPlan);
  reg('clip.generate', clipGenerate);
  reg('shot.generate', shotGenerate);
  reg('shot.group', shotGroup);
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
        case 'voices.design':
          // Speaking characters without a voice get previews to pick from (docs/design/dialogue.md#workflow).
          if (!config.tts || dialogueMode(docs.project.settings) === 'off') return;
          for (const c of speakingCharacters(docs)) {
            const v = voiceOf(c);
            if (!v.lock.locked && !v.voiceId && !v.sample && v.candidates.length === 0)
              await services.voices.design(actor, projectId, c.id);
          }
          return;
        case 'storyboard.generate':
          // Plan and draw the storyboarded scenes that still need frames (docs/design/storyboard.md).
          if (docs.project.settings.storyboard?.enabled === false || !docs.screenplay?.scenes.length) return;
          if (!checkRequirement('storyboard.approved', docs).ok)
            await services.storyboard.generate(actor, projectId);
          return;
        case 'elements.generateRefs':
          for (const e of elementsInUse(docs)) {
            if (!e.lock.locked && e.references.length === 0)
              await services.elements.generateReferences(actor, projectId, e.id);
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
    // The caller of the request being handled (docs/design/accounts.md), else the configured user.
    userActor: () =>
      currentPrincipal()?.actor ?? { kind: 'user', id: config.user.id, name: config.user.name },
    async detectWatermark(file) {
      const [mark, credentials] = await Promise.all([watermark.detectVideo(file), c2pa.read(file)]);
      return {
        ...mark,
        contentCredentials: {
          ...credentials,
          ...(credentials.present ? { bound: !!mark.id && credentials.watermarkId === mark.id } : {}),
        },
      };
    },
    async start() {
      await mkdir(join(config.dataDir), { recursive: true });
      await media.init();
      await watermark.init();
      await c2pa.init();
      await accounts.init();
      await notifications.init();
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

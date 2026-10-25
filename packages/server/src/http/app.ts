import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import {
  APERTURE_PRESETS,
  CAMERA_MOVES,
  LENS_PRESETS,
  routePermission,
  SettingsTestInputSchema,
  SettingsUpdateInputSchema,
} from '@rideo/shared';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { principalContext } from '../auth/context';
import type { Config } from '../config';
import type { Logger } from '../domain/deps';
import type { Studio } from '../domain/studio';
import { AppError, problemDetails, toAppError } from '../errors';
import { registerMcp, toolRegistry } from '../mcp/server';
import { Metrics } from '../metrics';
import { SettingsService } from '../settings/service';
import { SettingsStore } from '../settings/store';
import type { StorageBackend } from '../storage/backend';
import { DAV_PREFIX } from '../storage/embedded-dav';
import { RoutedStorage } from '../storage/routed';
import { workspaceContext } from '../storage/workspaces';
import { type RequestCounters, requestCounters } from '../util/request-context';
import { VERSION } from '../version';
import { type AuthedRequest, registerAuthRoutes } from './auth-routes';
import { applyBasePath, injectBase, requestBase } from './base-path';
import { registerBrandRoutes } from './brand-routes';
import { effectiveConfig, StudioHost } from './host';
import { registerPerformanceRoutes } from './performance-routes';
import { registerPushRoutes } from './push-routes';
import { registerReviewRoutes } from './review-routes';
import { registerRoutes } from './routes';
import { registerSearchRoutes } from './search-routes';
import { requestWorkspace } from './workspace-request';

export { VERSION };

export interface RideoServer {
  app: FastifyInstance;
  studio: Studio;
  url: () => string;
  start(): Promise<string>;
  stop(): Promise<void>;
}

/** Builds the Rideo HTTP server: REST, live WebSocket, MCP, embedded /dav and the web UI. */
/** pino-pretty is a dev dependency; production images log JSON without it. */
function prettyLogsAvailable(): boolean {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/** A browser request from the studio's own origin (Host or X-Forwarded-Host), or from an allowed embedding origin. */
export function sameSiteOrAllowed(
  req: { headers: Record<string, string | string[] | undefined> },
  allowed: readonly string[],
): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return true;
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  const hosts = [req.headers['x-forwarded-host'], req.headers.host]
    .flatMap((h) => (Array.isArray(h) ? h : [h]))
    .filter((h): h is string => typeof h === 'string')
    .flatMap((h) => h.split(',').map((x) => x.trim().toLowerCase()));
  try {
    return hosts.includes(new URL(origin).host.toLowerCase());
  } catch {
    return false;
  }
}

export async function buildServer(
  config: Config,
  opts: { storage?: StorageBackend; logger?: boolean | object } = {},
): Promise<RideoServer> {
  // Settings from the UI under the environment (docs/design/settings.md#where-values-come-from).
  const settingsStore = await new SettingsStore(join(config.dataDir, 'settings.json')).load();
  const effective = effectiveConfig(config, settingsStore.values);
  const basePath = config.basePath;
  let host: StudioHost | null = null;
  const app = Fastify({
    logger:
      opts.logger ??
      (config.production || !prettyLogsAvailable()
        ? { level: config.logLevel }
        : {
            level: config.logLevel,
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }),
    bodyLimit: 256 * 1024 * 1024,
    serverFactory: (handler) => {
      const server = createServer((req, res) => {
        // Under a subpath (docs/design/subpath.md), before Fastify and the embedded /dav.
        applyBasePath(req, basePath);
        const dav = host?.dav;
        if (dav?.matches(req.url)) return dav.handle(req, res, `${requestBase(req)}${DAV_PREFIX}/`);
        handler(req, res);
      });
      // WebSocket upgrades (the live channel) do not pass the request handler: the same rewrite, first.
      server.prependListener('upgrade', (req) => applyBasePath(req, basePath));
      return server;
    },
  });
  let port = config.port;
  const metrics = new Metrics();
  host = new StudioHost({
    log: app.log as unknown as Logger,
    metrics,
    storage: opts.storage,
    port: () => port,
  });
  const settings = new SettingsService({
    store: settingsStore,
    host,
    base: config,
    error: effective.error,
    log: app.log.child({ component: 'settings' }) as unknown as Logger,
    metrics,
  });
  if (effective.error)
    app.log.error({ err: effective.error }, 'settings_invalid: starting on the environment alone');
  // Every studio the host builds gets the recipes' tools and the settings service.
  const studio: Studio = host.studio;
  host.onBuilt = (s) => {
    // Recipes run their steps through the MCP tools (docs/design/agents.md#recipes)
    s.recipes.setTools(() => toolRegistry(studio));
    s.settings = settings;
  };
  host.init(effective.config);
  const current = () => host!.config;

  // two file parts: the upload and the poster the browser made for it
  await app.register(multipart, { limits: { fileSize: 4 * 1024 ** 3, files: 2 } });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // Pages on other origins that embed the studio (docs/design/embedding.md#talking-to-a-server-on-another-origin):
  // answered before authentication, since preflights carry no credentials.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const allowed = current().cors.origins;
    if (!origin || !allowed.length || !(allowed.includes('*') || allowed.includes(origin))) return;
    reply.header('access-control-allow-origin', allowed.includes('*') ? '*' : origin);
    reply.header('vary', 'Origin');
    reply.header(
      'access-control-expose-headers',
      'content-range, accept-ranges, content-length, content-disposition, x-rideo-source',
    );
    // media a cross-origin-isolated host may play
    reply.header('cross-origin-resource-policy', 'cross-origin');
    if (req.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      reply.header(
        'access-control-allow-headers',
        'authorization, content-type, range, x-rideo-workspace, x-rideo-coalesce, x-rideo-size, x-rideo-range',
      );
      reply.header('access-control-max-age', '600');
      return reply.code(204).send();
    }
  });

  // Who is calling (docs/design/accounts.md): every mode resolves a principal or answers 401.
  const accounts = () => studio.deps.accounts;
  const open = new Set([
    '/api/health',
    '/api/ready',
    '/api/auth/me',
    '/api/auth/login',
    '/api/auth/callback',
  ]);
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    const principal = await accounts().authenticate({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      token: (req.query as { token?: string } | undefined)?.token,
    });
    (req as AuthedRequest).principal = principal;
    // Guests of a review's share link (docs/design/review.md#reviews-and-share-links): the token is the access.
    const guest = url.startsWith('/api/review/');
    const guarded =
      (url.startsWith('/api/') && !open.has(url) && !guest) || url === '/mcp' || url === '/metrics';
    if (!guarded || principal) return;
    // The free detection tool (docs/design/provenance.md#public-detection-tool): file uploads need no token.
    const publicDetect =
      req.method === 'POST' &&
      url === '/api/watermark/detect' &&
      String(req.headers['content-type'] ?? '').startsWith('multipart/form-data');
    if (publicDetect) {
      (req as { publicCaller?: boolean }).publicCaller = true;
      return;
    }
    const err = new AppError(
      'unauthorized',
      accounts().mode === 'oidc' ? 'Sign in, or send an agent token' : 'Missing or invalid bearer token',
    );
    return reply.code(401).type('application/problem+json').send(problemDetails(err, url));
  });
  // The rest of the request runs as its principal: services and MCP tools read it (currentPrincipal).
  app.addHook('onRequest', (req, _reply, done) => {
    principalContext.run((req as AuthedRequest).principal ?? null, done);
  });
  // The browser workspace a request comes from (docs/design/browser-storage.md#routing-on-the-server).
  app.addHook('onRequest', (req, _reply, done) => {
    workspaceContext.run(requestWorkspace(req), done);
  });
  // What the request made the storage do, and how long it took (docs/design/observability.md#logs).
  app.addHook('onRequest', (req, _reply, done) => {
    const counters: RequestCounters = { storageOps: 0, storageMs: 0 };
    (req as { counters?: RequestCounters }).counters = counters;
    requestCounters.run(counters, done);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    const seconds = reply.elapsedTime / 1000;
    metrics.httpSeconds.observe(
      { method: req.method, route, status: `${Math.floor(reply.statusCode / 100)}xx` },
      seconds,
    );
    const counters = (req as { counters?: RequestCounters }).counters;
    if (!counters || !route.startsWith('/api/')) return;
    metrics.storageOpsPerRequest.observe({}, counters.storageOps);
    if (seconds > 2)
      req.log.warn(
        {
          route,
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
          storageOps: counters.storageOps,
          storageMs: Math.round(counters.storageMs),
        },
        'slow request',
      );
  });
  // Every project route needs its permission (ROUTE_PERMISSIONS, docs/design/accounts.md#users-roles-and-projects).
  app.addHook('preHandler', async (req) => {
    const principal = (req as AuthedRequest).principal;
    const m = /^\/api\/projects\/([a-z]{3}_[0-9a-z]{10,32})(\/[^?]*)?$/.exec(req.url.split('?')[0]!);
    if (!m || !principal) return;
    const permission = routePermission(req.method, m[2] ?? '');
    await accounts().authorize(principal, m[1]!, permission);
    if (permission === 'project.approve') (req as { approval?: string }).approval = m[1]!;
  });
  // Approvals that went through are audited (docs/design/accounts.md#audit-log).
  app.addHook('onResponse', async (req, reply) => {
    const projectId = (req as { approval?: string }).approval;
    if (projectId && reply.statusCode < 400)
      await accounts().record((req as AuthedRequest).principal ?? null, 'project.approval', {
        projectId,
        detail: { method: req.method, path: req.url.split('?')[0] },
      });
  });

  app.setErrorHandler((error: FastifyError, req, reply) => {
    let err: AppError;
    if (error instanceof AppError) err = error;
    else if (
      typeof error.statusCode === 'number' &&
      error.statusCode < 500 &&
      !(error as unknown as { issues?: unknown }).issues
    ) {
      err = new AppError(
        error.statusCode === 404
          ? 'not_found'
          : error.statusCode === 401
            ? 'unauthorized'
            : 'validation_error',
        error.message,
      );
      (err as { status: number }).status = error.statusCode;
    } else err = toAppError(error);
    if (err.status >= 500) req.log.error({ err: error }, 'request failed');
    return reply
      .code(err.status)
      .type('application/problem+json')
      .send(problemDetails(err, req.url.split('?')[0]));
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    version: VERSION,
    instanceId: studio.deps.hub.instanceId,
  }));
  app.get('/api/ready', async (_req, reply) => {
    const config = current();
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await host!.storage.list(config.webdav.root);
      checks.storage = { ok: true, detail: config.storage.mode };
    } catch (err) {
      checks.storage = { ok: false, detail: (err as Error).message };
    }
    // Without a gateway the studio is ready, without AI (docs/design/settings.md#without-mm-gateway).
    checks.gateway = config.gateway.configured
      ? { ok: await studio.deps.gateway.health() }
      : { ok: true, detail: 'not configured' };
    try {
      await studio.deps.ff.run(['-version']);
      checks.ffmpeg = { ok: true };
    } catch (err) {
      checks.ffmpeg = { ok: false, detail: (err as Error).message };
    }
    checks.llm = {
      ok: true,
      detail: config.gateway.configured
        ? `${config.llm.provider}:${config.llm.model} via /proxy/${config.llm.domain}`
        : 'not configured',
    };
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });
  app.get('/api/config', async (req) => {
    const config = current();
    const ai = config.gateway.configured;
    const [image, video, music] = ai
      ? await Promise.all(
          (['image', 'video', 'music'] as const).map((m) =>
            studio.deps.gateway.modelLimits(m).catch(() => []),
          ),
        )
      : [[], [], []];
    const dav = host!.dav;
    return {
      version: VERSION,
      brand: config.brand,
      user: config.user,
      /** The base path this page is served under (docs/design/subpath.md). */
      basePath: requestBase(req),
      /** The studio theme (docs/design/embedding.md#themes). */
      theme: config.theme,
      features: {
        mcp: true,
        /** mm-gateway is configured: AI features are on (docs/design/settings.md#without-mm-gateway). */
        gateway: ai,
        ai,
        /** Where projects are stored (docs/design/browser-storage.md). */
        storage: config.storage.mode,
        embeddedDav: !!dav,
        davUrl: dav ? `${config.publicUrl}${DAV_PREFIX}/` : null,
        webdavRoot: config.webdav.root,
        judge: config.consistency.judge,
        stt: !!config.stt,
        auth: !!config.apiToken,
        /** Dialogue voices (docs/design/dialogue.md): the TTS provider, whether it clones, the speaker check. */
        tts: config.tts
          ? { provider: config.tts.provider, clone: config.tts.provider === 'elevenlabs' }
          : null,
        voiceJudge: !!config.voiceJudge,
        /** The audio-visual model: the sound check of takes and feedback that listens. */
        omni: config.omni?.model ?? null,
        /** Telemetry from the studio (docs/design/observability.md#telemetry-from-the-studio). */
        telemetry: config.telemetry,
        /** Generated sound effects (docs/design/post-audio.md#effects-from-action-lines). */
        sfx: config.sfx ? { provider: config.sfx.provider } : null,
        /** NLE hand-off (docs/design/interchange.md#where-the-media-is): the WebDAV root clients reach. */
        interchange: { mediaBase: studio.interchange.defaultMediaBase() },
      },
      llm: ai
        ? { provider: config.llm.provider, model: config.llm.model, vision: config.vision.model }
        : null,
      defaults: studio.projects.defaultSettings(),
      // Directing controls (docs/design/directing.md).
      directing: { moves: CAMERA_MOVES, lenses: LENS_PRESETS, apertures: APERTURE_PRESETS },
      models: { image, video, music },
    };
  });

  // Browser storage: payloads too large for the live channel (docs/design/browser-storage.md#the-protocol)
  app.get('/api/workspace/transfers/:transferId', async (req, reply) => {
    const id = (req.params as { transferId: string }).transferId;
    const t = host!.workspaces?.take(id);
    if (!t) throw new AppError('not_found', 'transfer not found or expired');
    reply.type(t.contentType).header('cache-control', 'no-store');
    if (t.size !== undefined) reply.header('content-length', t.size);
    return reply.send(t.data);
  });
  app.put('/api/workspace/transfers/:transferId', { bodyLimit: 64 * 1024 ** 3 }, async (req, reply) => {
    const id = (req.params as { transferId: string }).transferId;
    const body = req.body as Readable | undefined;
    if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function')
      throw new AppError('validation_error', 'send the bytes as application/octet-stream');
    const num = (h: string) => Number(req.headers[h] ?? Number.NaN);
    const size = num('x-rideo-size');
    const [start, end] = String(req.headers['x-rideo-range'] ?? '')
      .split('-')
      .map(Number);
    if (![size, start, end].every((n) => Number.isInteger(n) && n! >= 0))
      throw new AppError('validation_error', 'x-rideo-size and x-rideo-range (start-end) are required');
    const accepted = await (host!.workspaces?.receive(id, requestWorkspace(req), body, {
      size,
      start: start!,
      end: end!,
    }) ?? Promise.resolve(false));
    if (!accepted) {
      body.resume();
      throw new AppError('not_found', 'no storage operation waits for this transfer');
    }
    return reply.code(204).send();
  });

  // Before the browser imports a project file by itself: is the id taken by a project the server knows elsewhere?
  app.get('/api/workspace/projects/:projectId', async (req) => {
    const projectId = (req.params as { projectId: string }).projectId;
    if (!/^prj_[0-9a-z]{10,32}$/.test(projectId)) throw new AppError('validation_error', 'not a project id');
    const storage = host!.storage;
    const holder = storage instanceof RoutedStorage ? await storage.holder(projectId) : null;
    return { elsewhere: holder !== null && holder !== requestWorkspace(req) };
  });

  // Studio settings (docs/design/settings.md#surfaces)
  app.get('/api/settings', async (req) => settings.view((req as AuthedRequest).principal ?? null));
  app.put('/api/settings', async (req) =>
    settings.update(
      (req as AuthedRequest).principal ?? null,
      SettingsUpdateInputSchema.parse(req.body ?? {}),
    ),
  );
  app.post('/api/settings/test', async (req) =>
    settings.test((req as AuthedRequest).principal ?? null, SettingsTestInputSchema.parse(req.body ?? {})),
  );
  app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(metrics.render()));

  app.get('/api/live', { websocket: true }, (socket, req) => {
    // Pages of other sites may not open it, unless they embed the studio (RIDEO_CORS_ORIGINS)
    if (!sameSiteOrAllowed(req, current().cors.origins)) {
      socket.close(4003, 'origin not allowed');
      return;
    }
    const projectId = (req.query as { projectId?: string }).projectId;
    const principal = (req as AuthedRequest).principal ?? null;
    studio.deps.hub.attach(
      socket as never,
      projectId && /^prj_[0-9a-z]{10,32}$/.test(projectId) ? projectId : undefined,
      {
        userId: principal?.user.id,
        // Live updates of a project need its read permission.
        authorize: async (pid) => {
          if (!principal) return false;
          try {
            await accounts().authorize(principal, pid, 'project.read');
            return true;
          } catch {
            return false;
          }
        },
      },
    );
  });

  registerAuthRoutes(app, studio);
  registerRoutes(app, studio);
  registerReviewRoutes(app, studio);
  registerBrandRoutes(app, studio);
  registerSearchRoutes(app, studio);
  registerPerformanceRoutes(app, studio);
  registerPushRoutes(app, studio);
  registerMcp(app, studio);

  // Default: packages/web/dist, found from the source tree (src/http) or the bundle (dist/main.js).
  const webDist = config.webDist
    ? resolve(config.webDist)
    : ([
        resolve(import.meta.dirname, '../../../web/dist'),
        resolve(import.meta.dirname, '../../web/dist'),
      ].find((dir) => existsSync(join(dir, 'index.html'))) ?? '');
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    // index.html carries the request's base path (docs/design/subpath.md#what-the-server-writes-with-the-base); read
    // per request, so a rebuilt app is served without a restart
    const indexFile = join(webDist, 'index.html');
    const isolationHeaders = (reply: { header: (k: string, v: string) => unknown }) => {
      // Cross-origin isolation: SharedArrayBuffer, so ffmpeg.wasm runs on every core
      // (docs/design/engine-performance.md#cross-origin-isolation-and-multi-threaded-ffmpegwasm)
      const isolation = current().crossOriginIsolation;
      if (isolation !== 'off') {
        reply.header('cross-origin-opener-policy', 'same-origin');
        reply.header('cross-origin-embedder-policy', isolation);
      }
    };
    const sendIndex = async (req: FastifyRequest, reply: FastifyReply) => {
      isolationHeaders(reply);
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(injectBase(await readFile(indexFile, 'utf8'), requestBase(req)));
    };
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      // the page itself is always written with the request's base (sendIndex)
      allowedPath: (path) => !/(^|\/)index\.html$/.test(path),
      // hashed build assets (including the 31 MB ffmpeg.wasm core) never change
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.header('cache-control', 'public, max-age=31536000, immutable');
        // the app shell's entry points change with every release (docs/design/pwa.md#the-app-shell)
        if (/(?:^|[\\/])(?:sw\.js|manifest\.webmanifest)$/.test(path))
          res.header('cache-control', 'no-cache');
        isolationHeaders(res);
      },
    });
    app.get('/', sendIndex);
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split('?')[0]!;
      // the app's routes have no extension; a missing file (an old asset) is a 404, not the app
      const file = /\.[a-z0-9]{1,8}$/i.test(url) && !url.endsWith('/index.html');
      if (
        req.method === 'GET' &&
        !file &&
        !url.startsWith('/api/') &&
        url !== '/mcp' &&
        !url.startsWith('/dav')
      ) {
        return sendIndex(req, reply);
      }
      const err = new AppError('not_found', `no route for ${req.method} ${url}`);
      return reply.code(404).type('application/problem+json').send(problemDetails(err, url));
    });
  }

  const url = () => `http://127.0.0.1:${port}`;
  return {
    app,
    studio,
    url,
    async start() {
      await app.listen({ port: config.port, host: config.host });
      port = (app.server.address() as AddressInfo).port;
      await host!.start();
      const c = current();
      app.log.info(
        {
          url: url(),
          basePath: c.basePath || '/',
          storage: c.storage.mode,
          webdav: c.storage.mode === 'webdav' ? c.webdav.url : undefined,
          gateway: c.gateway.url ?? 'not configured',
        },
        'Rideo is ready',
      );
      return url();
    },
    async stop() {
      await host!.stop();
      await app.close();
    },
  };
}

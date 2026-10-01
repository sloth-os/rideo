import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { APERTURE_PRESETS, CAMERA_MOVES, LENS_PRESETS } from '@rideo/shared';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from '../config';
import type { Logger } from '../domain/deps';
import { createStudio, type Studio } from '../domain/studio';
import { AppError, problemDetails, toAppError } from '../errors';
import { registerMcp } from '../mcp/server';
import { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import { createEmbeddedDav, DAV_PREFIX } from '../storage/embedded-dav';
import { WebDavBackend } from '../storage/webdav';
import { VERSION } from '../version';
import { registerRoutes } from './routes';

export { VERSION };

export interface RideoServer {
  app: FastifyInstance;
  studio: Studio;
  url: () => string;
  start(): Promise<string>;
  stop(): Promise<void>;
}

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return m?.[1];
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

export async function buildServer(
  config: Config,
  opts: { storage?: StorageBackend; logger?: boolean | object } = {},
): Promise<RideoServer> {
  const dav = config.webdav.embedded
    ? createEmbeddedDav({
        root: join(config.dataDir, 'dav'),
        username: config.webdav.davUsername,
        password: config.webdav.davPassword,
      })
    : null;
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
    serverFactory: (handler) =>
      createServer((req, res) => {
        if (dav?.matches(req.url)) return dav.handle(req, res);
        handler(req, res);
      }),
  });
  let port = config.port;
  const metrics = new Metrics();
  const storage =
    opts.storage ??
    (config.webdav.url
      ? new WebDavBackend({
          url: config.webdav.url,
          username: config.webdav.username,
          password: config.webdav.password,
          metrics,
        })
      : new WebDavBackend({
          url: () => `http://127.0.0.1:${port}${DAV_PREFIX}`,
          username: config.webdav.davUsername,
          password: config.webdav.davPassword,
          metrics,
        }));
  const studio = createStudio(config, { log: app.log as unknown as Logger, storage, metrics });

  // two file parts: the upload and the poster the browser made for it
  await app.register(multipart, { limits: { fileSize: 4 * 1024 ** 3, files: 2 } });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.addHook('onRequest', async (req, reply) => {
    if (!config.apiToken) return;
    const url = req.url.split('?')[0]!;
    const guarded =
      (url.startsWith('/api/') && url !== '/api/health') || url === '/mcp' || url === '/metrics';
    if (!guarded) return;
    const token = bearer(req.headers.authorization) ?? (req.query as { token?: string } | undefined)?.token;
    // The free detection tool (docs/design/provenance.md#public-detection-tool): file uploads need no token.
    const publicDetect =
      req.method === 'POST' &&
      url === '/api/watermark/detect' &&
      String(req.headers['content-type'] ?? '').startsWith('multipart/form-data');
    if (token !== config.apiToken && publicDetect) {
      (req as { publicCaller?: boolean }).publicCaller = true;
      return;
    }
    if (token !== config.apiToken) {
      const err = new AppError('unauthorized', 'Missing or invalid bearer token');
      return reply.code(401).type('application/problem+json').send(problemDetails(err, url));
    }
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
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await storage.list(config.webdav.root);
      checks.storage = { ok: true };
    } catch (err) {
      checks.storage = { ok: false, detail: (err as Error).message };
    }
    checks.gateway = { ok: await studio.deps.gateway.health() };
    try {
      await studio.deps.ff.run(['-version']);
      checks.ffmpeg = { ok: true };
    } catch (err) {
      checks.ffmpeg = { ok: false, detail: (err as Error).message };
    }
    checks.llm = {
      ok: true,
      detail: `${config.llm.provider}:${config.llm.model} via /proxy/${config.llm.domain}`,
    };
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });
  app.get('/api/config', async () => {
    const [image, video, music] = await Promise.all(
      (['image', 'video', 'music'] as const).map((m) => studio.deps.gateway.modelLimits(m).catch(() => [])),
    );
    return {
      version: VERSION,
      brand: config.brand,
      user: config.user,
      features: {
        mcp: true,
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
      },
      llm: { provider: config.llm.provider, model: config.llm.model, vision: config.vision.model },
      defaults: studio.projects.defaultSettings(),
      // Directing controls (docs/design/directing.md).
      directing: { moves: CAMERA_MOVES, lenses: LENS_PRESETS, apertures: APERTURE_PRESETS },
      models: { image, video, music },
    };
  });
  app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(metrics.render()));

  app.get('/api/live', { websocket: true }, (socket, req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    studio.deps.hub.attach(
      socket as never,
      projectId && /^prj_[0-9a-z]{10,32}$/.test(projectId) ? projectId : undefined,
    );
  });

  registerRoutes(app, studio);
  registerMcp(app, studio);

  // Default: packages/web/dist, found from the source tree (src/http) or the bundle (dist/main.js).
  const webDist = config.webDist
    ? resolve(config.webDist)
    : ([
        resolve(import.meta.dirname, '../../../web/dist'),
        resolve(import.meta.dirname, '../../web/dist'),
      ].find((dir) => existsSync(join(dir, 'index.html'))) ?? '');
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: ['index.html'],
      // hashed build assets (including the 31 MB ffmpeg.wasm core) never change
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split('?')[0]!;
      if (req.method === 'GET' && !url.startsWith('/api/') && url !== '/mcp' && !url.startsWith('/dav')) {
        return reply.type('text/html').sendFile('index.html');
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
      await studio.start();
      app.log.info(
        { url: url(), webdav: config.webdav.url ?? `${url()}${DAV_PREFIX}`, gateway: config.gateway.url },
        'Rideo is ready',
      );
      return url();
    },
    async stop() {
      await studio.stop();
      await app.close();
    },
  };
}

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  type GenerateContext,
  isLipSyncRequest,
  runImage,
  runMusic,
  runVideo,
  validateRequest,
} from './generate';
import { handleChat, multipartFile } from './llm';
import { MOCK_MODELS, type Modality } from './models';
import { embeddings } from './search';
import { handleSpeech } from './speech';
import { publicTask, type RunResult, TaskStore } from './tasks';

const execFileP = promisify(execFile);

export interface MockGatewayOptions {
  /** Bearer key required on /v1 and /proxy (open when unset). */
  apiKey?: string;
  /** pending→running→done latency (ms). */
  latencyMs?: number;
  /** Every n-th identity-bearing generation drifts (drops signatures). 0 = never. */
  flakyEvery?: number;
  /** Directory for generated files (a temp dir by default). */
  dir?: string;
  logger?: boolean;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export interface MockGatewayApp {
  app: FastifyInstance;
  store: TaskStore;
  dir: string;
  counters: { generations: number; flaky: number; proxyCalls: Record<string, number> };
  close(): Promise<void>;
}

export async function buildMockGateway(opts: MockGatewayOptions = {}): Promise<MockGatewayApp> {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), 'rideo-mock-gateway-')));
  const ownsDir = !opts.dir;
  const store = new TaskStore(opts.latencyMs ?? 200);
  const counters = { generations: 0, flaky: 0, proxyCalls: {} as Record<string, number> };
  const flakyEvery = opts.flakyEvery ?? Number(process.env.MOCK_FLAKY_EVERY ?? 0);
  // Closing ends every connection: a test's gateway stops at once even when a client keeps a socket open
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 200 * 1024 * 1024,
    forceCloseConnections: true,
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const problem = (
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code: string,
    detail: string,
    errors?: unknown[],
  ) =>
    reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: `urn:mm-gateway:problem:${code}`,
        title: code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        status,
        detail,
        instance: req.url.split('?')[0],
        code,
        request_id: `req_${randomBytes(8).toString('hex')}`,
        errors: errors ?? null,
      });

  const baseUrl = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

  app.addHook('onRequest', async (req, reply) => {
    if (!opts.apiKey) return;
    if (!req.url.startsWith('/v1/') && !req.url.startsWith('/proxy/')) return;
    if (req.headers.authorization !== `Bearer ${opts.apiKey}`) {
      return problem(req, reply, 401, 'unauthorized', 'Missing or unknown API key.');
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/metrics', async (_req, reply) =>
    reply
      .type('text/plain')
      .send(
        `# mock gateway\nmock_generations_total ${counters.generations}\nmock_flaky_total ${counters.flaky}\n`,
      ),
  );

  const listModels = (withLimits: boolean) => async (req: FastifyRequest) => {
    const modality = (req.query as { modality?: string }).modality;
    return {
      object: 'list',
      data: MOCK_MODELS.filter((m) => !modality || m.modality === modality).map((m) => ({
        id: m.id,
        object: 'model',
        modality: m.modality,
        ...(withLimits ? { limits: m.limits } : {}),
      })),
    };
  };
  app.get('/v1/models', listModels(false));
  app.get('/v1/models/limits', listModels(true));

  const routes: {
    modality: Modality;
    path: string;
    run: (body: any, ctx: GenerateContext) => Promise<RunResult>;
  }[] = [
    { modality: 'image', path: 'images', run: runImage },
    { modality: 'video', path: 'videos', run: runVideo },
    { modality: 'music', path: 'music', run: runMusic },
  ];

  for (const route of routes) {
    app.post(`/v1/${route.path}`, async (req, reply) => {
      const body = req.body as Record<string, any>;
      const issues = validateRequest(route.modality, body);
      if (issues.length)
        return problem(req, reply, 422, 'validation_error', 'Request validation failed.', issues);
      // Auto routing (like mm-gateway's fit step): a reference video goes to the lip-sync model.
      const lipSync = isLipSyncRequest((body.input as { type?: string; role?: string }[] | undefined) ?? []);
      const model =
        body.model && body.model !== 'auto'
          ? body.model
          : lipSync && route.modality === 'video'
            ? 'mock-lipsync-v1'
            : MOCK_MODELS.find((m) => m.modality === route.modality)!.id;
      if (!MOCK_MODELS.some((m) => m.id === model && m.modality === route.modality)) {
        return problem(req, reply, 422, 'validation_error', `Unknown model ${model}.`, [
          { loc: 'model', msg: 'unknown model' },
        ]);
      }
      const key = req.headers['idempotency-key'] as string | undefined;
      const owner = 'default';
      const replay = store.replay(owner, key, body);
      if (replay === 'conflict')
        return problem(
          req,
          reply,
          409,
          'idempotency_conflict',
          'Idempotency-Key reused with a different body.',
        );
      const identityBearing =
        route.modality === 'video' || (body.input as { type: string }[]).some((p) => p.type === 'image');
      let flaky = body.metadata?.mock_flaky === true;
      if (!replay && identityBearing && route.modality !== 'music') {
        counters.generations++;
        if (flakyEvery > 0 && counters.generations % flakyEvery === 0) flaky = true;
      }
      if (flaky) counters.flaky++;
      const failCode = typeof body.metadata?.mock_fail === 'string' ? body.metadata.mock_fail : null;
      const base = baseUrl(req);
      const task =
        replay ??
        store.create({
          modality: route.modality,
          model,
          owner,
          metadata: body.metadata,
          idempotencyKey: key,
          body,
          run: async () => {
            if (failCode) {
              const { TaskError } = await import('./tasks');
              throw new TaskError(failCode, `mock failure: ${failCode}`);
            }
            return route.run(body, { dir, fileUrl: (name) => `${base}/files/${name}`, flaky });
          },
        });
      const self = `${base}/v1/${route.path}/${task.id}`;
      return reply
        .code(202)
        .header('location', self)
        .header('link', `<${self}>; rel="self"`)
        .header('etag', store.etag(task))
        .header('retry-after', '1')
        .send(publicTask(task, base));
    });

    app.get(`/v1/${route.path}/:id`, async (req, reply) => {
      const task = store.get((req.params as { id: string }).id);
      if (!task || task.object !== route.modality)
        return problem(req, reply, 404, 'not_found', 'Task not found.');
      const etag = store.etag(task);
      reply.header('etag', etag);
      if (!['succeeded', 'failed', 'cancelled', 'expired'].includes(task.status))
        reply.header('retry-after', '1');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return publicTask(task, baseUrl(req));
    });
  }

  app.get('/files/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!/^[a-z0-9-]+\.[a-z0-9]+$/.test(name)) return problem(req, reply, 404, 'not_found', 'No such file.');
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (!st) return problem(req, reply, 404, 'not_found', 'No such file.');
    reply.header('content-length', st.size).type(MIME[extname(name)] ?? 'application/octet-stream');
    return reply.send(createReadStream(path));
  });

  app.all('/proxy/:domain/*', async (req, reply) => {
    const { domain } = req.params as { domain: string; '*': string };
    const path = (req.params as { '*': string })['*'];
    counters.proxyCalls[domain] = (counters.proxyCalls[domain] ?? 0) + 1;
    const speech = await handleSpeech(path, req.body, String(req.headers['content-type'] ?? ''), dir);
    if (speech) return reply.code(speech.status).headers(speech.headers).send(speech.body);
    if (/audio\/transcriptions$/.test(path)) {
      const buf = req.body as Buffer;
      const file = multipartFile(buf, String(req.headers['content-type'] ?? ''));
      let duration = 6;
      if (file) {
        const tmp = join(dir, `stt-${randomBytes(6).toString('hex')}`);
        await writeFile(tmp, file);
        try {
          const { stdout } = await execFileP(process.env.RIDEO_FFPROBE_PATH ?? 'ffprobe', [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'csv=p=0',
            tmp,
          ]);
          duration = Number.parseFloat(stdout) || duration;
        } catch {
          // not a media file: keep the default duration
        }
      }
      // Every other line hesitates, for filler-word removal (docs/design/editor.md#transcript-editing).
      const segments = [];
      for (let t = 0, i = 0; t < duration - 0.5; t += 3, i++) {
        segments.push({
          id: i,
          start: t,
          end: Math.min(duration, t + 2.5),
          text:
            i % 2 ? `Um, line ${i + 1} of the conversation, you know.` : `Line ${i + 1} of the conversation.`,
        });
      }
      // Word timings (`timestamp_granularities[]=word`): spread over each line by length.
      const words = segments.flatMap((s) => {
        const parts = s.text.split(' ');
        const total = parts.reduce((n, w) => n + w.length + 1, 0);
        let at = s.start;
        return parts.map((w) => {
          const d = ((s.end - s.start) * (w.length + 1)) / total;
          const word = {
            word: w.replace(/[,.]+$/, ''),
            start: Math.round(at * 1000) / 1000,
            end: Math.round((at + d) * 1000) / 1000,
          };
          at += d;
          return word;
        });
      });
      return { text: segments.map((s) => s.text).join(' '), duration, language: 'en', segments, words };
    }
    let body: unknown = req.body;
    if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString('utf8'));
      } catch {
        return problem(req, reply, 400, 'bad_request', 'Mock proxy expects JSON.');
      }
    }
    // Caption embeddings for semantic search (docs/design/search.md)
    if (/(^|\/)embeddings$/.test(path)) {
      const res = embeddings(body);
      return reply.code(res.status).send(res.body);
    }
    const res = handleChat(path, body);
    return reply.code(res.status).headers(res.headers).send(res.body);
  });

  return {
    app,
    store,
    dir,
    counters,
    async close() {
      await app.close();
      if (ownsDir) await rm(dir, { recursive: true, force: true });
    },
  };
}

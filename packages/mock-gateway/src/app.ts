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
import { ManagementError, type MockKey, MockManagement } from './management';
import { MOCK_MODELS, type Modality } from './models';
import { embeddings } from './search';
import { handleSpeech } from './speech';
import { publicTask, type RunResult, TaskStore } from './tasks';

const execFileP = promisify(execFile);

/** A chat call that mentions this is answered `503 system cpu overloaded`. */
export const OVERLOAD_MARKER = '[provider overloaded]';

export interface MockGatewayOptions {
  /** Bearer key required on /v1 and /proxy (open when unset). */
  apiKey?: string;
  /** Management token of /v1/management (docs/design/ai-gateway.md#mock-gateway); disabled when unset. */
  managementKey?: string;
  /** Only domains with a registered proxy are served (404 otherwise), like the real gateway. */
  strictProxies?: boolean;
  /** pending→running→done latency (ms). */
  latencyMs?: number;
  /** Every n-th identity-bearing generation drifts (drops signatures). 0 = never. */
  flakyEvery?: number;
  /** Every n-th video generation jumps inside the shot (a flash cut). 0 = never. */
  jumpEvery?: number;
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
  counters: {
    generations: number;
    flaky: number;
    /** Video generations that jump inside the shot (MOCK_JUMP_EVERY, metadata.mock_jump). */
    jumps: number;
    videos: number;
    /** Chat calls answered `503 system cpu overloaded` (overloadChat). */
    overloaded: number;
    /** Task creates turned away with `429` (busyCreates). */
    busy: number;
    proxyCalls: Record<string, number>;
    /** The account and gateway key of the last call to each registered proxy. */
    proxyAccounts: Record<string, { account: string; key: string; headers: Record<string, string> }>;
  };
  /** The management API's state: proxies and keys with their real credentials. */
  management: MockManagement;
  /** The next `times` chat calls through the proxy answer `503 system cpu overloaded`, as an overloaded upstream does. */
  overloadChat(times: number): void;
  /** The next `times` task creates answer `429`, as a provider at its concurrency limit does (no task is made). */
  busyCreates(times: number): void;
  /** The next `times` video generations jump inside the shot (a flash cut), like MOCK_JUMP_EVERY. */
  jumpVideos(times: number): void;
  /** The next `times` sound checks hear no speech, as when the video model does not voice its lines. */
  muffleSpeech(times: number): void;
  close(): Promise<void>;
}

export async function buildMockGateway(opts: MockGatewayOptions = {}): Promise<MockGatewayApp> {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), 'rideo-mock-gateway-')));
  const ownsDir = !opts.dir;
  const store = new TaskStore(opts.latencyMs ?? 200);
  const counters: MockGatewayApp['counters'] = {
    generations: 0,
    flaky: 0,
    jumps: 0,
    videos: 0,
    overloaded: 0,
    busy: 0,
    proxyCalls: {},
    proxyAccounts: {},
  };
  let overloads = 0;
  let busyLeft = 0;
  let jumpsLeft = 0;
  let mufflesLeft = 0;
  const management = new MockManagement({ apiKey: opts.apiKey, managementKey: opts.managementKey });
  const keyOf = new WeakMap<FastifyRequest, MockKey>();
  const flakyEvery = opts.flakyEvery ?? Number(process.env.MOCK_FLAKY_EVERY ?? 0);
  const jumpEvery = opts.jumpEvery ?? Number(process.env.MOCK_JUMP_EVERY ?? 0);
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
    if (req.url.startsWith('/v1/management/')) {
      try {
        management.authorize(req.headers.authorization);
      } catch (err) {
        const e = err as ManagementError;
        return problem(req, reply, e.status, e.code, e.message);
      }
      return;
    }
    if (!req.url.startsWith('/v1/') && !req.url.startsWith('/proxy/')) return;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const key = management.keyFor(token);
    if (!key) return problem(req, reply, 401, 'unauthorized', 'Missing or unknown API key.');
    keyOf.set(req, key);
  });

  // Management (docs/design/ai-gateway.md#mock-gateway)
  const managed =
    (fn: (req: FastifyRequest) => ReturnType<MockManagement['view']>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const out = fn(req);
        return reply.header('etag', `"${out.revision}"`).header('cache-control', 'no-store').send(out);
      } catch (err) {
        if (!(err instanceof ManagementError)) throw err;
        return problem(req, reply, err.status, err.code, err.message);
      }
    };
  const ifMatch = (req: FastifyRequest) => req.headers['if-match'] as string | undefined;
  const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
  const jsonBody = (req: FastifyRequest): unknown =>
    Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
  app.get(
    '/v1/management/config',
    managed(() => management.view()),
  );
  app.put(
    '/v1/management/proxies/:domain',
    managed((req) => management.putProxy(param(req, 'domain'), jsonBody(req), ifMatch(req))),
  );
  app.delete(
    '/v1/management/proxies/:domain',
    managed((req) => management.deleteProxy(param(req, 'domain'), ifMatch(req))),
  );
  app.put(
    '/v1/management/keys/:id',
    managed((req) => management.putKey(param(req, 'id'), jsonBody(req), ifMatch(req))),
  );
  app.delete(
    '/v1/management/keys/:id',
    managed((req) => management.deleteKey(param(req, 'id'), ifMatch(req))),
  );

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
      // A provider at its concurrency limit: mm-gateway passes its 429 on and makes no task
      if (busyLeft > 0) {
        busyLeft--;
        counters.busy++;
        return problem(
          req,
          reply,
          429,
          'generation_service_error',
          'The generation service returned an error.',
        );
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
      let jump = body.metadata?.mock_jump === true;
      if (!replay && route.modality === 'video') {
        counters.videos++;
        if (jumpEvery > 0 && counters.videos % jumpEvery === 0) jump = true;
        if (jumpsLeft > 0) {
          jump = true;
          jumpsLeft--;
        }
      }
      if (jump) counters.jumps++;
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
            return route.run(body, { dir, fileUrl: (name) => `${base}/files/${name}`, flaky, jump });
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
    // A registered proxy is served like mm-gateway does: to the keys its tags allow, with an account's credential
    const registered = management.proxy(domain);
    if (registered) {
      const key = keyOf.get(req)!;
      if (!management.allowed(key, registered))
        return problem(
          req,
          reply,
          403,
          'forbidden',
          `API key '${key.id}' is not allowed to use proxy '${domain}'.`,
        );
      const account = registered.accounts.find((a) => Object.keys(a.headers).length);
      if (!account)
        return problem(
          req,
          reply,
          503,
          'provider_not_configured',
          `Proxy '${domain}' has no configured account.`,
        );
      counters.proxyAccounts[domain] = { account: account.id, key: key.id, headers: account.headers };
      reply.header('x-mm-gateway-proxy-account', account.id);
    } else if (opts.strictProxies) {
      return problem(
        req,
        reply,
        404,
        'generation_service_not_found',
        'The requested generation service was not found.',
      );
    }
    counters.proxyCalls[domain] = (counters.proxyCalls[domain] ?? 0) + 1;
    // Model lists (endpoint tests): the mock's chat and speech models
    if (req.method === 'GET' && /(^|\/)models$/.test(path))
      return {
        object: 'list',
        data: [
          'mock-llm',
          'gpt-4.1-mini',
          'eleven_multilingual_v2',
          'eleven_text_to_sound_v2',
          'gpt-4o-mini-tts',
        ].map((id) => ({ id, object: 'model', owned_by: 'mock' })),
      };
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
    // An upstream turning calls away for load (newapi's words), passed through by the proxy: the next calls after
    // overloadChat(), or every call that mentions OVERLOAD_MARKER (e2e specs share the mock)
    if (overloads > 0 || JSON.stringify(body).includes(OVERLOAD_MARKER)) {
      if (overloads > 0) overloads--;
      counters.overloaded++;
      return reply.code(503).type('text/plain').send('system cpu overloaded');
    }
    const res = handleChat(path, body, {
      muffled: () => {
        if (mufflesLeft <= 0) return false;
        mufflesLeft--;
        return true;
      },
    });
    return reply.code(res.status).headers(res.headers).send(res.body);
  });

  return {
    app,
    store,
    dir,
    counters,
    management,
    overloadChat(times) {
      overloads = times;
    },
    busyCreates(times) {
      busyLeft = times;
    },
    jumpVideos(times) {
      jumpsLeft = times;
    },
    muffleSpeech(times) {
      mufflesLeft = times;
    },
    async close() {
      await app.close();
      if (ownsDir) await rm(dir, { recursive: true, force: true });
    },
  };
}

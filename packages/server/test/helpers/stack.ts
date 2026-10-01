import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningMockGateway, startMockGateway } from '@rideo/mock-gateway';
import { isTerminalJob, type Job } from '@rideo/shared';
import { loadConfig } from '../../src/config';
import { buildServer, type RideoServer } from '../../src/http/app';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(`${status} ${body?.code ?? ''}: ${body?.detail ?? JSON.stringify(body)}`);
  }
}

export interface Stack {
  gw: RunningMockGateway;
  server: RideoServer;
  url: string;
  dataDir: string;
  api: <T = any>(method: string, path: string, body?: unknown) => Promise<T>;
  waitJob: (projectId: string, jobId: string, timeoutMs?: number) => Promise<Job>;
  waitIdle: (projectId: string, timeoutMs?: number) => Promise<void>;
  /** Waits until an export has succeeded or failed (render in an editor tab, then the finishing job). */
  waitExport: (projectId: string, exportId: string, timeoutMs?: number) => Promise<any>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export async function startStack(
  opts: {
    flakyEvery?: number;
    latencyMs?: number;
    env?: Record<string, string>;
    dataDir?: string;
    gw?: RunningMockGateway;
  } = {},
): Promise<Stack> {
  const gw =
    opts.gw ??
    (await startMockGateway({ latencyMs: opts.latencyMs ?? 20, flakyEvery: opts.flakyEvery ?? 0 }));
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), 'rideo-it-')));
  const make = async () => {
    const config = loadConfig({
      RIDEO_PORT: '0',
      RIDEO_HOST: '127.0.0.1',
      RIDEO_DATA_DIR: dataDir,
      MM_GATEWAY_URL: gw.url,
      RIDEO_LOG_LEVEL: 'warn',
      NODE_ENV: 'test',
      RIDEO_WATERMARK_KEY: 'integration-test-key',
      RIDEO_WEBDAV_SYNC_INTERVAL_SEC: '0',
      RIDEO_GATEWAY_POLL_MS: '50',
      RIDEO_WEB_DIST: join(dataDir, 'no-web'),
      // Dialogue voices through the mock's ElevenLabs endpoints (docs/design/dialogue.md).
      RIDEO_TTS_PROVIDER: 'elevenlabs',
      ...opts.env,
    });
    const server = await buildServer(config, { logger: false });
    const url = await server.start();
    return { server, url };
  };
  let { server, url } = await make();
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const isForm = body instanceof FormData;
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: body !== undefined && !isForm ? { 'content-type': 'application/json' } : {},
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  };
  const waitJob = async (projectId: string, jobId: string, timeoutMs = 120_000): Promise<Job> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await api<Job>('GET', `/projects/${projectId}/jobs/${jobId}`);
      if (isTerminalJob(job)) return job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`job ${jobId} did not finish`);
  };
  const waitIdle = async (projectId: string, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const jobs = await api<Job[]>('GET', `/projects/${projectId}/jobs`);
      if (jobs.every(isTerminalJob)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('jobs did not settle');
  };
  const waitExport = async (projectId: string, exportId: string, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const exports = await api<any[]>('GET', `/projects/${projectId}/exports`);
      const e = exports.find((x) => x.id === exportId);
      if (e && (e.status === 'succeeded' || e.status === 'failed')) return e;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`export ${exportId} did not finish`);
  };
  const stack: Stack = {
    gw,
    get server() {
      return server;
    },
    get url() {
      return url;
    },
    dataDir,
    api,
    waitJob,
    waitIdle,
    waitExport,
    async restart() {
      await server.stop();
      ({ server, url } = await make());
    },
    async stop() {
      await server.stop();
      if (!opts.gw) await gw.close();
      if (!opts.dataDir) await rm(dataDir, { recursive: true, force: true });
    },
  } as Stack;
  return stack;
}

/** Story project with screenplay generated, references approved and cast locked (ready for clips). */
export async function readyStoryProject(stack: Stack, settings: Record<string, unknown> = {}) {
  const p = await stack.api<{ id: string }>('POST', '/projects', {
    kind: 'story',
    title: 'The Keeper',
    brief: { prompt: 'A lighthouse keeper receives letters from the future' },
    settings: {
      targetDurationSec: 30,
      pilotDurationSec: 10,
      resolution: { width: 320, height: 180 },
      ...settings,
    },
  });
  const job = await stack.api<Job>('POST', `/projects/${p.id}/screenplay/generate`, {});
  expectSucceeded(await stack.waitJob(p.id, job.id));
  let state = await stack.api<any>('GET', `/projects/${p.id}/state`);
  for (const c of Object.values<any>(state.docs.characters)) {
    const j = await stack.api<Job>('POST', `/projects/${p.id}/characters/${c.id}/references/generate`, {
      views: ['front'],
    });
    expectSucceeded(await stack.waitJob(p.id, j.id));
  }
  state = await stack.api<any>('GET', `/projects/${p.id}/state`);
  for (const c of Object.values<any>(state.docs.characters)) {
    for (const r of c.references)
      await stack.api('PATCH', `/projects/${p.id}/characters/${c.id}/references/${r.id}`, { approved: true });
    await stack.api('POST', `/projects/${p.id}/characters/${c.id}/lock`);
  }
  await lockElements(stack, p.id);
  await lockVoices(stack, p.id);
  return { projectId: p.id, state: await stack.api<any>('GET', `/projects/${p.id}/state`) };
}

/** Designs, picks (the first preview) and locks a voice for every character, when the project speaks. */
export async function lockVoices(stack: Stack, projectId: string): Promise<void> {
  let state = await stack.api<any>('GET', `/projects/${projectId}/state`);
  if (state.docs.project.settings.dialogue.mode === 'off') return;
  for (const c of Object.values<any>(state.docs.characters)) {
    if (c.voice?.lock.locked || c.voice?.candidates.length) continue;
    const j = await stack.api<Job>('POST', `/projects/${projectId}/characters/${c.id}/voice/design`, {});
    expectSucceeded(await stack.waitJob(projectId, j.id));
  }
  state = await stack.api<any>('GET', `/projects/${projectId}/state`);
  for (const c of Object.values<any>(state.docs.characters)) {
    if (c.voice.lock.locked) continue;
    if (!c.voice.voiceId)
      await stack.api('POST', `/projects/${projectId}/characters/${c.id}/voice/select`, {
        candidateId: c.voice.candidates[0].id,
      });
    await stack.api('POST', `/projects/${projectId}/characters/${c.id}/voice/lock`);
  }
}

/** Generates, approves and locks every element (location, prop) the story uses (docs/design/elements.md). */
export async function lockElements(stack: Stack, projectId: string): Promise<void> {
  let state = await stack.api<any>('GET', `/projects/${projectId}/state`);
  for (const e of Object.values<any>(state.docs.elements)) {
    if (e.lock.locked || e.references.length) continue;
    const j = await stack.api<Job>('POST', `/projects/${projectId}/elements/${e.id}/references/generate`, {});
    expectSucceeded(await stack.waitJob(projectId, j.id));
  }
  state = await stack.api<any>('GET', `/projects/${projectId}/state`);
  for (const e of Object.values<any>(state.docs.elements)) {
    if (e.lock.locked) continue;
    for (const r of e.references)
      if (!r.approved)
        await stack.api('PATCH', `/projects/${projectId}/elements/${e.id}/references/${r.id}`, {
          approved: true,
        });
    await stack.api('POST', `/projects/${projectId}/elements/${e.id}/lock`);
  }
}

export function expectSucceeded(job: Job): Job {
  if (job.status !== 'succeeded')
    throw new Error(`job ${job.kind} ${job.status}: ${JSON.stringify(job.error)}`);
  return job;
}

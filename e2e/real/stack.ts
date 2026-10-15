// Playwright webServer of the real-model suite (docs/testing.md#real-models-e2ereal): mm-gateway with the suite's
// configuration, then one studio on the built-in WebDAV server whose AI is the real models.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServer, loadConfig } from '@rideo/server';
import { readRealEnv, studioEnv } from './env';
import { startRealGateway } from './gateway';
import { REAL_PORTS } from './ports';

const log = (line: string) => console.log(`rideo real: ${line}`);
const env = readRealEnv(process.env);
const dir = await mkdtemp(join(tmpdir(), 'rideo-real-'));
const results = resolve(import.meta.dirname, '../../test-results/real');
await mkdir(results, { recursive: true });

const gateway = await startRealGateway(env, {
  port: REAL_PORTS.gateway,
  dir,
  logFile: join(results, 'mm-gateway.log'),
  log,
});
const models = await fetch(`${gateway.url}/v1/models`, {
  headers: { authorization: `Bearer ${gateway.apiKey}` },
})
  .then((r) => r.json() as Promise<{ data?: { id: string; modality: string }[] }>)
  .catch(() => ({ data: [] }));
log(`gateway models: ${(models.data ?? []).map((m) => `${m.id} (${m.modality})`).join(', ') || 'none'}`);

const server = await buildServer(
  loadConfig({
    RIDEO_HOST: '127.0.0.1',
    RIDEO_PORT: String(REAL_PORTS.studio),
    RIDEO_PUBLIC_URL: `http://127.0.0.1:${REAL_PORTS.studio}`,
    RIDEO_DATA_DIR: join(dir, 'studio'),
    RIDEO_STORAGE: 'embedded',
    RIDEO_WEB_DIST: resolve(import.meta.dirname, '../../packages/web/dist'),
    RIDEO_WATERMARK_KEY: 'e2e-real-watermark-key',
    RIDEO_WEBDAV_SYNC_INTERVAL_SEC: '0',
    NODE_ENV: 'production',
    ...studioEnv(env, gateway),
  }),
  // The run's record (every AI task with its model, latency and usage, every gateway task), next to the gateway's.
  { logger: { level: 'info', file: join(results, 'studio.log') } },
);
await server.start();
log(`studio on ${server.url()} (data ${dir}, log ${join(results, 'studio.log')})`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop().catch(() => undefined);
  await gateway.stop().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

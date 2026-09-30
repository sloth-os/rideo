// Playwright webServer: the mock mm-gateway plus a Rideo server with the embedded WebDAV store in a
// temporary data dir, serving the built web app (packages/web/dist).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockGateway } from '@rideo/mock-gateway';
import { buildServer, loadConfig } from '@rideo/server';

const port = process.env.RIDEO_E2E_PORT ?? '8797';
const dataDir = await mkdtemp(join(tmpdir(), 'rideo-e2e-'));
const gateway = await startMockGateway({ latencyMs: 30 });
const server = await buildServer(
  loadConfig({
    RIDEO_HOST: '127.0.0.1',
    RIDEO_PORT: port,
    RIDEO_PUBLIC_URL: `http://127.0.0.1:${port}`,
    RIDEO_DATA_DIR: dataDir,
    RIDEO_WEB_DIST: resolve(import.meta.dirname, '../../packages/web/dist'),
    MM_GATEWAY_URL: gateway.url,
    RIDEO_GATEWAY_POLL_MS: '50',
    RIDEO_WATERMARK_KEY: 'e2e-watermark-key',
    RIDEO_WEBDAV_SYNC_INTERVAL_SEC: '0',
    RIDEO_LOG_LEVEL: 'warn',
    NODE_ENV: 'production',
  }),
);
await server.start();
console.log(`rideo e2e stack on ${server.url()} (gateway ${gateway.url}, data ${dataDir})`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop().catch(() => undefined);
  await gateway.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

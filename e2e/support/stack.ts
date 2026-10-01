// Playwright webServer: the mock mm-gateway plus a Rideo server with the embedded WebDAV store in a
// temporary data dir, serving the built web app (packages/web/dist).
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockGateway, startMockIdp } from '@rideo/mock-gateway';
import { buildServer, loadConfig } from '@rideo/server';

const port = process.env.RIDEO_E2E_PORT ?? '8797';
// Runs that were killed leave their data behind: remove what earlier stacks left more than an hour ago.
for (const name of await readdir(tmpdir())) {
  if (!/^rideo-(e2e|mock-gateway)-/.test(name)) continue;
  const path = join(tmpdir(), name);
  const info = await stat(path).catch(() => null);
  if (info && Date.now() - info.mtimeMs > 3_600_000) await rm(path, { recursive: true, force: true });
}
const dataDir = await mkdtemp(join(tmpdir(), 'rideo-e2e-'));
const gateway = await startMockGateway({ latencyMs: 30 });
const env = (p: string, dir: string) => ({
  RIDEO_HOST: '127.0.0.1',
  RIDEO_PORT: p,
  RIDEO_PUBLIC_URL: `http://127.0.0.1:${p}`,
  RIDEO_DATA_DIR: dir,
  RIDEO_WEB_DIST: resolve(import.meta.dirname, '../../packages/web/dist'),
  MM_GATEWAY_URL: gateway.url,
  RIDEO_GATEWAY_POLL_MS: '50',
  RIDEO_WATERMARK_KEY: 'e2e-watermark-key',
  // Dialogue voices and sound effects through the mock's ElevenLabs endpoints (docs/design/dialogue.md).
  RIDEO_TTS_PROVIDER: 'elevenlabs',
  RIDEO_SFX_PROVIDER: 'elevenlabs',
  RIDEO_WEBDAV_SYNC_INTERVAL_SEC: '0',
  RIDEO_LOG_LEVEL: 'warn',
  NODE_ENV: 'production',
});
const server = await buildServer(loadConfig(env(port, dataDir)));
await server.start();
console.log(`rideo e2e stack on ${server.url()} (gateway ${gateway.url}, data ${dataDir})`);

// A second studio with accounts (docs/design/accounts.md) on the next port, signing in through a mock provider.
const accountsPort = String(Number(port) + 1);
const accountsDir = await mkdtemp(join(tmpdir(), 'rideo-e2e-'));
const idp = await startMockIdp({
  users: [
    { sub: 'u-mira', email: 'mira@studio.test', name: 'Mira Keeper' },
    { sub: 'u-ben', email: 'ben@studio.test', name: 'Ben Editor' },
    { sub: 'u-cleo', email: 'cleo@studio.test', name: 'Cleo Reviewer' },
  ],
});
const accounts = await buildServer(
  loadConfig({
    ...env(accountsPort, accountsDir),
    RIDEO_OIDC_ISSUER: idp.url,
    RIDEO_OIDC_CLIENT_ID: idp.clientId,
    RIDEO_OIDC_CLIENT_SECRET: idp.clientSecret,
    RIDEO_OIDC_NAME: 'Studio SSO',
    RIDEO_ADMINS: 'mira@studio.test',
  }),
);
await accounts.start();
console.log(`rideo e2e accounts stack on ${accounts.url()} (identity provider ${idp.url})`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop().catch(() => undefined);
  await accounts.stop().catch(() => undefined);
  await idp.close().catch(() => undefined);
  await gateway.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
  await rm(accountsDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

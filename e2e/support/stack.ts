// Playwright webServer: the mock mm-gateway plus the Rideo studios of the e2e suite, each in a temporary data dir,
// serving the built web app (packages/web/dist). The main studio starts last: its /api/ready means all are up.

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockGateway, startMockIdp } from '@rideo/mock-gateway';
import { buildServer, loadConfig, type RideoServer } from '@rideo/server';
import { startHostPage } from './host-page';
import { GATEWAY_ADMIN_KEY, PORTS } from './ports';
import { startPrefixProxy } from './prefix-proxy';
import { startSlowMediaProxy } from './slow-media-proxy';

// Runs that were killed leave their data behind: remove what earlier stacks left more than an hour ago.
for (const name of await readdir(tmpdir())) {
  if (!/^rideo-(e2e|mock-gateway)-/.test(name)) continue;
  const path = join(tmpdir(), name);
  const info = await stat(path).catch(() => null);
  if (info && Date.now() - info.mtimeMs > 3_600_000) await rm(path, { recursive: true, force: true });
}
// Its management API lets the settings spec register API keys (docs/design/settings.md#registration-in-mm-gateway).
const gateway = await startMockGateway({
  latencyMs: 30,
  port: PORTS.gateway,
  managementKey: GATEWAY_ADMIN_KEY,
});
const dirs: string[] = [];
const servers: RideoServer[] = [];
const env = async (port: number, extra: Record<string, string> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'rideo-e2e-'));
  dirs.push(dir);
  return {
    RIDEO_HOST: '127.0.0.1',
    RIDEO_PORT: String(port),
    RIDEO_PUBLIC_URL: `http://127.0.0.1:${port}`,
    RIDEO_DATA_DIR: dir,
    // The built-in WebDAV server: specs set projects up over the API without a browser workspace.
    RIDEO_STORAGE: 'embedded',
    RIDEO_WEB_DIST: resolve(import.meta.dirname, '../../packages/web/dist'),
    MM_GATEWAY_URL: gateway.url,
    RIDEO_GATEWAY_POLL_MS: '50',
    RIDEO_WATERMARK_KEY: 'e2e-watermark-key',
    // Dialogue voices and sound effects through the mock's ElevenLabs endpoints (docs/design/dialogue.md).
    RIDEO_TTS_PROVIDER: 'elevenlabs',
    RIDEO_SFX_PROVIDER: 'elevenlabs',
    // Speech-to-text through the mock's proxy: transcripts with word timings (docs/design/editor.md#transcript-editing)
    RIDEO_STT_PROXY_DOMAIN: 'openai',
    RIDEO_WEBDAV_SYNC_INTERVAL_SEC: '0',
    RIDEO_LOG_LEVEL: 'warn',
    NODE_ENV: 'production',
    ...extra,
  };
};
const start = async (name: string, config: Record<string, string>) => {
  const server = await buildServer(loadConfig(config));
  await server.start();
  servers.push(server);
  console.log(`rideo e2e ${name} on ${server.url()} (data ${config.RIDEO_DATA_DIR})`);
  return server;
};

// A studio with accounts (docs/design/accounts.md), signing in through a mock provider.
const idp = await startMockIdp({
  users: [
    { sub: 'u-mira', email: 'mira@studio.test', name: 'Mira Keeper' },
    { sub: 'u-ben', email: 'ben@studio.test', name: 'Ben Editor' },
    { sub: 'u-cleo', email: 'cleo@studio.test', name: 'Cleo Reviewer' },
  ],
});
await start(
  `accounts studio (identity provider ${idp.url})`,
  await env(PORTS.accounts, {
    RIDEO_OIDC_ISSUER: idp.url,
    RIDEO_OIDC_CLIENT_ID: idp.clientId,
    RIDEO_OIDC_CLIENT_SECRET: idp.clientSecret,
    RIDEO_OIDC_NAME: 'Studio SSO',
    RIDEO_ADMINS: 'mira@studio.test',
  }),
);
// Projects in the browser, no gateway: the editor alone (docs/design/browser-storage.md).
await start(
  'browser-storage studio',
  await env(PORTS.browser, {
    RIDEO_STORAGE: 'browser',
    MM_GATEWAY_URL: '',
    RIDEO_TTS_PROVIDER: '',
    RIDEO_SFX_PROVIDER: '',
    RIDEO_STT_PROXY_DOMAIN: '',
    // the library's host page (another origin) uses this studio (docs/design/embedding.md)
    RIDEO_CORS_ORIGINS: `http://127.0.0.1:${PORTS.host}`,
  }),
);
// Under a subpath (docs/design/subpath.md): /studio directly, /rideo through a prefix-stripping proxy.
await start(
  'subpath studio',
  await env(PORTS.subpath, {
    RIDEO_BASE_PATH: '/studio',
    RIDEO_PUBLIC_URL: `http://127.0.0.1:${PORTS.subpath}/studio`,
  }),
);
const proxy: Server = await startPrefixProxy({
  port: PORTS.proxy,
  prefix: '/rideo',
  upstream: PORTS.subpath,
});
console.log(`rideo e2e proxy: http://127.0.0.1:${PORTS.proxy}/rideo/ → :${PORTS.subpath}`);
// Settings changed in the UI (docs/design/settings.md): start without a gateway, left to the spec to connect.
for (const [name, port] of [
  ['settings studio', PORTS.settings],
  ['settings studio (mobile)', PORTS.settingsMobile],
] as const)
  await start(
    name,
    await env(port, {
      MM_GATEWAY_URL: '',
      RIDEO_TTS_PROVIDER: '',
      RIDEO_SFX_PROVIDER: '',
      RIDEO_STT_PROXY_DOMAIN: '',
    }),
  );
const host: Server = await startHostPage({ port: PORTS.host });
console.log(`rideo e2e library host page on http://127.0.0.1:${PORTS.host}/`);
const slowMedia: Server = await startSlowMediaProxy({
  port: PORTS.slowMedia,
  upstream: PORTS.main,
  delayMs: 20_000,
});
console.log(
  `rideo e2e slow media: http://127.0.0.1:${PORTS.slowMedia}/ → :${PORTS.main} (ranged media held 20 s)`,
);
// The main studio last.
await start(`main studio (gateway ${gateway.url})`, await env(PORTS.main));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const s of [...servers].reverse()) await s.stop().catch(() => undefined);
  await new Promise((r) => proxy.close(() => r(null)));
  await new Promise((r) => host.close(() => r(null)));
  slowMedia.closeAllConnections();
  await new Promise((r) => slowMedia.close(() => r(null)));
  await idp.close().catch(() => undefined);
  await gateway.close().catch(() => undefined);
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

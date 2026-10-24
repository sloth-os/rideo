import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningMockGateway, startMockGateway } from '@rideo/mock-gateway';
import { desiredProxies, resolveEndpoints } from '@rideo/shared';
import type { ManagementConfigOutput } from '@sloth-os/mm-gateway-ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { ProxyClient } from '../../src/gateway/proxy-client';
import {
  accountIdFor,
  classifySyncError,
  GatewayProxies,
  loadIdentity,
  planProxySync,
  REDACTED,
} from '../../src/gateway/proxy-sync';
import { Metrics } from '../../src/metrics';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
const identity = { instance: 'a1b2c3', token: 'studio-token' };
const desired = (values: Record<string, string>) =>
  desiredProxies(resolveEndpoints(values, { gateway: true }), (key) => accountIdFor(identity.instance, key))
    .proxies;
const TEXT = { RIDEO_LLM_PROXY_DOMAIN: 'https://ai.example.com/v1', RIDEO_LLM_API_KEY: 'sk-text' };
const config = (over: Partial<ManagementConfigOutput> = {}): ManagementConfigOutput => ({
  backends: [],
  keys: [{ id: 'env', key: REDACTED, allow_tags: ['image'] }],
  proxies: [],
  ...over,
});

describe('the proxy-sync plan (docs/design/settings.md#registration-in-mm-gateway)', () => {
  const account = accountIdFor(identity.instance, 'sk-text');

  it('creates the proxy at the origin, with an account per key and the studio’s own key', () => {
    const plan = planProxySync(config(), desired(TEXT), identity);
    expect(account).toMatch(/^rideo-a1b2c3-[0-9a-f]{8}$/);
    expect(plan.registered).toEqual(['ai.example.com']);
    expect(plan.ops).toEqual([
      {
        kind: 'put-proxy',
        domain: 'ai.example.com',
        created: true,
        body: {
          domain: 'ai.example.com',
          base_url: 'https://ai.example.com',
          tags: ['rideo-a1b2c3'],
          timeout: 600,
          enabled: true,
          // the text and vision models share it: one account, the OpenAI header
          accounts: [{ id: account, headers: { authorization: 'Bearer sk-text' } }],
        },
      },
      {
        kind: 'put-key',
        keyId: 'rideo-a1b2c3',
        created: true,
        body: { id: 'rideo-a1b2c3', key: 'studio-token', allow_tags: ['rideo-a1b2c3'], enabled: true },
      },
    ]);
  });

  it('writes nothing when the gateway already matches', () => {
    const current = config({
      keys: [{ id: 'rideo-a1b2c3', key: REDACTED, allow_tags: ['rideo-a1b2c3'], enabled: true }],
      proxies: [
        {
          domain: 'ai.example.com',
          base_url: 'https://ai.example.com',
          tags: ['rideo-a1b2c3'],
          accounts: [{ id: account, headers: { authorization: REDACTED } }],
        },
      ],
    });
    expect(planProxySync(current, desired(TEXT), identity)).toMatchObject({
      ops: [],
      registered: ['ai.example.com'],
      keyExists: true,
    });
    // a token that no longer works is written again
    expect(planProxySync(current, desired(TEXT), identity, { rewriteKey: true }).ops).toEqual([
      expect.objectContaining({ kind: 'put-key', body: expect.objectContaining({ key: 'studio-token' }) }),
    ]);
  });

  it('adds itself to an operator’s proxy, keeping its accounts and headers redacted, and swaps a new key in', () => {
    const old = accountIdFor(identity.instance, 'sk-old');
    const current = config({
      proxies: [
        {
          domain: 'ai.example.com',
          base_url: 'https://ai.example.com/',
          tags: ['prod'],
          headers: { 'x-team': REDACTED },
          timeout: 120,
          accounts: [
            { id: 'main', headers: { authorization: REDACTED } },
            { id: old, headers: { authorization: REDACTED } },
          ],
        },
      ],
    });
    const plan = planProxySync(current, desired(TEXT), identity);
    expect(plan.ops[0]).toEqual({
      kind: 'put-proxy',
      domain: 'ai.example.com',
      created: false,
      body: {
        domain: 'ai.example.com',
        base_url: 'https://ai.example.com/',
        tags: ['prod', 'rideo-a1b2c3'],
        headers: { 'x-team': REDACTED },
        timeout: 120,
        accounts: [
          { id: 'main', headers: { authorization: REDACTED } },
          { id: account, headers: { authorization: 'Bearer sk-text' } },
        ],
      },
    });
  });

  it('moves its own proxy when the base URL’s origin changes', () => {
    const plan = planProxySync(
      config({
        proxies: [
          {
            domain: 'ai.example.com',
            base_url: 'http://ai.example.com:8080',
            tags: ['rideo-a1b2c3'],
            accounts: [{ id: account, headers: { authorization: REDACTED } }],
          },
        ],
      }),
      desired(TEXT),
      identity,
    );
    expect(plan.conflicts).toEqual({});
    expect(plan.ops[0]).toMatchObject({
      kind: 'put-proxy',
      created: false,
      body: {
        base_url: 'https://ai.example.com',
        accounts: [{ id: account, headers: { authorization: 'Bearer sk-text' } }],
      },
    });
  });

  it('leaves a proxy at another URL, or turned off, alone and says why', () => {
    const at = planProxySync(
      config({ proxies: [{ base_url: 'https://ai.example.com/v1', accounts: [] }] }),
      desired(TEXT),
      identity,
    );
    expect(at.registered).toEqual([]);
    expect(at.conflicts['ai.example.com']).toMatch(/forwards to https:\/\/ai.example.com\/v1/);
    // nothing registered: no key either
    expect(at.ops).toEqual([]);
    const off = planProxySync(
      config({ proxies: [{ base_url: 'https://ai.example.com', enabled: false }] }),
      desired(TEXT),
      identity,
    );
    expect(off.conflicts['ai.example.com']).toMatch(/turned off/);
  });

  it('removes what it no longer wants: its own proxies, its accounts in others, then its key', () => {
    const mine = accountIdFor(identity.instance, 'sk-text');
    const plan = planProxySync(
      config({
        keys: [{ id: 'rideo-a1b2c3', key: REDACTED, allow_tags: ['rideo-a1b2c3'] }],
        proxies: [
          {
            domain: 'ai.example.com',
            base_url: 'https://ai.example.com',
            tags: ['rideo-a1b2c3'],
            accounts: [{ id: mine }],
          },
          {
            domain: 'api.openai.com',
            base_url: 'https://api.openai.com',
            tags: ['prod', 'rideo-a1b2c3'],
            accounts: [{ id: 'main', headers: { authorization: REDACTED } }, { id: mine }],
          },
          // another studio's registrations are not this one's to remove
          {
            base_url: 'https://other.example.com',
            tags: ['rideo-ffffff'],
            accounts: [{ id: 'rideo-ffffff-1' }],
          },
        ],
      }),
      new Map(),
      identity,
    );
    expect(plan.ops).toEqual([
      { kind: 'delete-proxy', domain: 'ai.example.com' },
      {
        kind: 'put-proxy',
        domain: 'api.openai.com',
        created: false,
        body: {
          domain: 'api.openai.com',
          base_url: 'https://api.openai.com',
          tags: ['prod'],
          accounts: [{ id: 'main', headers: { authorization: REDACTED } }],
        },
      },
      { kind: 'delete-key', keyId: 'rideo-a1b2c3' },
    ]);
  });

  it('names its failures with stable codes', () => {
    const axiosError = (status?: number) =>
      Object.assign(new Error('boom'), {
        isAxiosError: true,
        response: status ? { status, data: { detail: 'said' } } : undefined,
      });
    expect(classifySyncError(axiosError(401)).code).toBe('gateway_admin_unauthorized');
    expect(classifySyncError(axiosError(404)).code).toBe('gateway_management_unavailable');
    expect(classifySyncError(axiosError()).code).toBe('gateway_unreachable');
    expect(classifySyncError(axiosError(500))).toEqual({
      code: 'gateway_error',
      detail: 'mm-gateway answered 500: said',
    });
  });
});

describe('syncing with mm-gateway’s management API', () => {
  let gw: RunningMockGateway;
  let dataDir: string;
  beforeAll(async () => {
    gw = await startMockGateway({ latencyMs: 20, apiKey: 'gw-key', managementKey: 'admin' });
  });
  afterAll(async () => {
    await gw.close();
  });
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rideo-proxy-sync-'));
    gw.management.proxies = [];
    gw.management.keys = gw.management.keys.filter((k) => k.id === 'default');
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const studio = (env: Record<string, string>) => {
    const metrics = new Metrics();
    const cfg = loadConfig({
      MM_GATEWAY_URL: gw.url,
      MM_GATEWAY_API_KEY: 'gw-key',
      RIDEO_DATA_DIR: dataDir,
      ...env,
    });
    const proxies = new GatewayProxies({ config: cfg, log, metrics });
    const proxy = new ProxyClient({ baseUrl: cfg.gateway.url, apiKey: cfg.gateway.apiKey, routes: proxies });
    return { cfg, metrics, proxies, proxy };
  };

  it('registers the key, calls the proxy with the studio’s own key and its credential reaches the account', async () => {
    const { proxies, proxy, metrics } = studio({ ...TEXT, MM_GATEWAY_ADMIN_KEY: 'admin' });
    await proxies.start();
    // a call made while the sync runs waits for it
    const res = await proxy.fetch({ domain: 'ai.example.com', prefix: 'v1' }, 'v1/models');
    expect(res.status).toBe(200);
    expect(proxies.state).toMatchObject({ status: 'ok', code: null });
    expect(metrics.gatewayProxySync.get({ result: 'ok' })).toBe(1);
    const { instance, token } = await loadIdentity(dataDir);
    expect((await stat(join(dataDir, 'gateway.json'))).mode & 0o777).toBe(0o600);
    expect(proxies.keyFor('ai.example.com')).toBe(token);
    expect(proxies.keyFor('api.openai.com')).toBeUndefined();
    expect(gw.counters.proxyAccounts['ai.example.com']).toEqual({
      account: accountIdFor(instance, 'sk-text'),
      key: `rideo-${instance}`,
      headers: { authorization: 'Bearer sk-text' },
    });
    expect(gw.management.proxies[0]).toMatchObject({
      base_url: 'https://ai.example.com',
      tags: [`rideo-${instance}`],
    });
    expect(proxies.domainState('ai.example.com')).toEqual({ state: 'registered', detail: null });
    expect(proxies.gatewayHas('ai.example.com')).toBe(true);
    // syncing again writes nothing
    const revision = gw.management.revision;
    await proxies.sync();
    expect(gw.management.revision).toBe(revision);
  });

  it('plans again when the configuration changed underneath, and rewrites a key the gateway forgot', async () => {
    const { proxies } = studio({ ...TEXT, MM_GATEWAY_ADMIN_KEY: 'admin' });
    const put = gw.management.putProxy.bind(gw.management);
    let raced = false;
    gw.management.putProxy = (domain, body, ifMatch) => {
      if (!raced) {
        raced = true;
        gw.management.revision = 'changed-by-someone-else';
      }
      return put(domain, body, ifMatch);
    };
    try {
      expect(await proxies.sync()).toMatchObject({ status: 'ok' });
    } finally {
      gw.management.putProxy = put;
    }
    expect(raced).toBe(true);
    expect(gw.management.proxies).toHaveLength(1);
    // the gateway lost the studio's token: the next sync writes it again
    const { instance, token } = await loadIdentity(dataDir);
    const key = gw.management.keys.find((k) => k.id === `rideo-${instance}`)!;
    key.key = 'something-else';
    expect(await proxies.sync()).toMatchObject({ status: 'ok' });
    expect(gw.management.keys.find((k) => k.id === `rideo-${instance}`)?.key).toBe(token);
  });

  it('cleans up after the keys are cleared, and reports what it cannot do', async () => {
    await studio({ ...TEXT, MM_GATEWAY_ADMIN_KEY: 'admin' }).proxies.sync();
    expect(gw.management.proxies).toHaveLength(1);
    // no keys any more: the identity file says something was registered, so the studio cleans up at start
    const cleared = studio({ MM_GATEWAY_ADMIN_KEY: 'admin' });
    await cleared.proxies.start();
    await cleared.proxies.settled();
    expect(gw.management.proxies).toEqual([]);
    expect(gw.management.keys.map((k) => k.id)).toEqual(['default']);
    // a refused token, no token at all
    const refused = studio({ ...TEXT, MM_GATEWAY_ADMIN_KEY: 'wrong' });
    expect(await refused.proxies.sync()).toMatchObject({
      status: 'failed',
      code: 'gateway_admin_unauthorized',
    });
    expect(refused.metrics.gatewayProxySync.get({ result: 'failed' })).toBe(1);
    const none = new GatewayProxies({
      config: loadConfig({ MM_GATEWAY_URL: gw.url, RIDEO_DATA_DIR: dataDir, ...TEXT }),
      log,
      metrics: new Metrics(),
    });
    expect(await none.sync()).toMatchObject({ status: 'failed', code: 'gateway_admin_missing' });
    // the gateway key doubles as the admin token when none is set (it does not here)
    expect(await studio(TEXT).proxies.sync()).toMatchObject({ code: 'gateway_admin_unauthorized' });
  });

  it('reports a gateway without a management API, and one that does not answer', async () => {
    const plain: Server = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"Not Found"}');
    });
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    const port = (plain.address() as AddressInfo).port;
    const old = new GatewayProxies({
      config: loadConfig({
        MM_GATEWAY_URL: `http://127.0.0.1:${port}`,
        RIDEO_DATA_DIR: dataDir,
        ...TEXT,
        MM_GATEWAY_ADMIN_KEY: 'a',
      }),
      log,
      metrics: new Metrics(),
    });
    expect(await old.sync()).toMatchObject({ status: 'failed', code: 'gateway_management_unavailable' });
    await new Promise((r) => plain.close(r));
    const gone = new GatewayProxies({
      config: loadConfig({
        MM_GATEWAY_URL: `http://127.0.0.1:${port}`,
        RIDEO_DATA_DIR: dataDir,
        ...TEXT,
        MM_GATEWAY_ADMIN_KEY: 'a',
      }),
      log,
      metrics: new Metrics(),
    });
    expect(await gone.sync()).toMatchObject({ status: 'failed', code: 'gateway_unreachable' });
  });
});

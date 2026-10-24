import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type RunningMockGateway, startMockGateway } from '@rideo/mock-gateway';
import type { Analysis, Job, Resource, SettingsView } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EditorWorker, startEditorWorker } from '../helpers/editor-worker';
import { makeFootage } from '../helpers/media';
import { ApiError, expectSucceeded, type Stack, startStack } from '../helpers/stack';

/** Studio settings in the UI (docs/design/settings.md) and a studio without mm-gateway. */
let stack: Stack;
let editor: EditorWorker | undefined;
beforeAll(async () => {
  // No gateway in the environment: the studio starts without AI, and the gateway can be connected in Settings.
  // RIDEO_STORAGE is left to Settings too; the built-in server is chosen by RIDEO_EMBEDDED_DAV.
  stack = await startStack({ env: { MM_GATEWAY_URL: '', RIDEO_STORAGE: '', RIDEO_EMBEDDED_DAV: 'true' } });
});
afterAll(async () => {
  await editor?.stop();
  await stack?.stop();
});

async function problem(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, body: err.body };
    throw err;
  }
  throw new Error('expected the request to fail');
}

describe('a studio without mm-gateway (docs/design/settings.md#without-mm-gateway)', () => {
  it('is ready, says AI is off and refuses AI work at once', async () => {
    const ready = await stack.api<any>('GET', '/ready');
    expect(ready.status).toBe('ok');
    expect(ready.checks.gateway).toEqual({ ok: true, detail: 'not configured' });
    const config = await stack.api<any>('GET', '/config');
    expect(config.features).toMatchObject({ gateway: false, ai: false, storage: 'embedded', tts: null });
    expect(config.llm).toBeNull();
    expect(config.models).toEqual({ image: [], video: [], music: [] });

    const story = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'No AI',
      brief: { prompt: 'A lighthouse keeper' },
    });
    const refused = await problem(stack.api('POST', `/projects/${story.id}/screenplay/generate`, {}));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('gateway_not_configured');
  });

  it('edits footage: analysis with rule-based suggestions, auto edit and a finished export', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Editor only',
      settings: { resolution: { width: 320, height: 180 } },
    });
    const form = new FormData();
    form.set(
      'file',
      new Blob([await readFile(await makeFootage(stack.dataDir))], { type: 'video/mp4' }),
      'clip.mp4',
    );
    const resource = await stack.api<Resource>('POST', `/projects/${p.id}/uploads`, form);
    editor = await startEditorWorker(stack, p.id);
    await stack.waitIdle(p.id);
    await stack.api('POST', `/projects/${p.id}/workflow/approve`, { gate: 'source_ready' });
    const { analysis, job } = await stack.api<{ analysis: Analysis; job: Job }>(
      'POST',
      `/projects/${p.id}/analyses`,
      { resourceId: resource.id },
    );
    const signals = expectSucceeded(await stack.waitJob(p.id, job.id));
    const suggest = expectSucceeded(await stack.waitJob(p.id, (signals.result as { next: string }).next));
    expect(suggest.attempts).toBe(1);
    const state = await stack.api<any>('GET', `/projects/${p.id}/state`);
    const a = state.docs.analyses[analysis.id] as Analysis;
    expect(a.status).toBe('completed');
    expect(a.suggestions.length).toBeGreaterThan(0);
    expect(a.suggestions.every((s) => s.source === 'rules')).toBe(true);
    await stack.api('POST', `/projects/${p.id}/analyses/${a.id}/auto-edit`);
    const exp = await stack.api<any>('POST', `/projects/${p.id}/exports`, {
      quality: 'draft',
      thumbnails: true,
    });
    const done = await stack.waitExport(p.id, exp.export.id);
    expect(done).toMatchObject({ status: 'succeeded', method: 'browser' });
    // thumbnails without the vision model: evenly spaced frames
    expect(done.thumbnails?.length ?? 0).toBeGreaterThan(0);
    await editor.stop();
    editor = undefined;
  }, 300_000);
});

describe('settings (docs/design/settings.md#surfaces)', () => {
  it('shows every setting with its source and lock, and never a secret', async () => {
    const view = await stack.api<SettingsView>('GET', '/settings');
    expect(view.storage).toBe('embedded');
    expect(view.gateway).toBe(false);
    expect(view.error).toBeNull();
    expect(view.fields.MM_GATEWAY_URL).toEqual({ value: null, source: 'default', locked: false, set: false });
    // set by the stack's environment
    expect(view.fields.RIDEO_WATERMARK_STRENGTH).toMatchObject({ source: 'default', locked: false });
    expect(view.fields.RIDEO_TTS_PROVIDER).toEqual({
      value: 'elevenlabs',
      source: 'env',
      locked: true,
      set: true,
    });
    // environment-only configuration is not a setting
    expect(view.fields.RIDEO_DATA_DIR).toBeUndefined();
    expect(view.fields.RIDEO_WATERMARK_KEY).toBeUndefined();
  });

  it('refuses locked keys, unknown keys and invalid values, naming the setting', async () => {
    const locked = await problem(stack.api('PUT', '/settings', { values: { RIDEO_TTS_PROVIDER: 'openai' } }));
    expect(locked.status).toBe(409);
    expect(locked.body).toMatchObject({ code: 'setting_locked', errors: [{ path: 'RIDEO_TTS_PROVIDER' }] });
    const unknown = await problem(stack.api('PUT', '/settings', { values: { RIDEO_DATA_DIR: '/tmp' } }));
    expect(unknown.status).toBe(422);
    // values are checked first, then the rules across settings (each names the setting to fix)
    const invalid = await problem(
      stack.api('PUT', '/settings', { values: { RIDEO_CONSISTENCY_THRESHOLD: 'high' } }),
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body.errors).toEqual([expect.objectContaining({ path: 'RIDEO_CONSISTENCY_THRESHOLD' })]);
    const rule = await problem(stack.api('PUT', '/settings', { values: { RIDEO_STORAGE: 'webdav' } }));
    expect(rule.status).toBe(422);
    expect(rule.body.errors).toEqual([expect.objectContaining({ path: 'RIDEO_WEBDAV_URL' })]);
  });

  it('tests a connection without saving it', async () => {
    const ok = await stack.api<any>('POST', '/settings/test', {
      target: 'gateway',
      values: { MM_GATEWAY_URL: stack.gw.url },
    });
    expect(ok.ok).toBe(true);
    expect(ok.models.video.length).toBeGreaterThan(0);
    const down = await stack.api<any>('POST', '/settings/test', {
      target: 'gateway',
      values: { MM_GATEWAY_URL: 'http://127.0.0.1:9' },
    });
    expect(down.ok).toBe(false);
    const dav = await stack.api<any>('POST', '/settings/test', {
      target: 'webdav',
      values: { RIDEO_WEBDAV_URL: `${stack.url}/dav` },
    });
    expect(dav).toMatchObject({ ok: true });
    expect((await stack.api<SettingsView>('GET', '/settings')).fields.MM_GATEWAY_URL?.set).toBe(false);
  });

  it('connects mm-gateway: applied at once, audited, kept across restarts', async () => {
    const r = await stack.api<SettingsView & { applied: boolean; changed: string[] }>('PUT', '/settings', {
      values: {
        MM_GATEWAY_URL: stack.gw.url,
        MM_GATEWAY_API_KEY: 'k-secret',
        RIDEO_BRAND_NAME: 'Studio Nine',
      },
    });
    expect(r.applied).toBe(true);
    expect(r.changed).toEqual(['MM_GATEWAY_API_KEY', 'MM_GATEWAY_URL', 'RIDEO_BRAND_NAME']);
    expect(r.gateway).toBe(true);
    expect(r.fields.MM_GATEWAY_API_KEY).toEqual({
      value: null,
      source: 'settings',
      locked: false,
      set: true,
    });
    expect(r.updatedBy).toMatchObject({ kind: 'user' });
    const config = await stack.api<any>('GET', '/config');
    expect(config.features.gateway).toBe(true);
    expect(config.brand.name).toBe('Studio Nine');
    expect(config.models.video.length).toBeGreaterThan(0);

    // AI work runs now
    const story = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'With AI',
      brief: { prompt: 'A lighthouse keeper' },
      settings: { targetDurationSec: 30, pilotDurationSec: 10 },
    });
    const job = await stack.api<Job>('POST', `/projects/${story.id}/screenplay/generate`, {});
    expectSucceeded(await stack.waitJob(story.id, job.id));

    // the file holds the secret, readable by the server's user only
    const file = join(stack.dataDir, 'settings.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).values).toMatchObject({ MM_GATEWAY_API_KEY: 'k-secret' });
    const audit = await stack.api<any[]>('GET', '/audit?type=settings.update');
    expect(audit[0]).toMatchObject({
      type: 'settings.update',
      detail: { keys: ['MM_GATEWAY_API_KEY', 'MM_GATEWAY_URL', 'RIDEO_BRAND_NAME'] },
    });
    expect(JSON.stringify(audit)).not.toContain('k-secret');

    await stack.restart();
    expect((await stack.api<any>('GET', '/config')).features.gateway).toBe(true);
    const cleared = await stack.api<SettingsView>('PUT', '/settings', {
      values: { MM_GATEWAY_URL: null, MM_GATEWAY_API_KEY: null },
    });
    expect(cleared.gateway).toBe(false);
    expect((await stack.api<any>('GET', '/config')).features.gateway).toBe(false);
  }, 120_000);

  it('rolls back a change the studio cannot start with', async () => {
    const before = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Still here',
    });
    const failed = await problem(
      stack.api('PUT', '/settings', {
        values: { RIDEO_STORAGE: 'webdav', RIDEO_WEBDAV_URL: 'http://127.0.0.1:9/dav' },
      }),
    );
    expect(failed.status).toBe(422);
    expect(failed.body.detail).toMatch(/could not start/);
    const view = await stack.api<SettingsView>('GET', '/settings');
    expect(view.fields.RIDEO_STORAGE?.source).toBe('default');
    expect(view.storage).toBe('embedded');
    expect((await stack.api<any[]>('GET', '/projects')).map((p) => p.id)).toContain(before.id);
  }, 60_000);

  it('is the same service over MCP', async () => {
    const client = new Client({ name: 'settings-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        return { error: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
      };
      const view = await call('settings_get', {});
      expect(view.body.fields.RIDEO_TTS_PROVIDER.locked).toBe(true);
      const locked = await call('settings_update', { values: { RIDEO_TTS_PROVIDER: 'off' } });
      expect(locked).toMatchObject({ error: true, body: { code: 'setting_locked' } });
      const set = await call('settings_update', { values: { RIDEO_BRAND_OWNER: 'Nine Films' } });
      expect(set.body).toMatchObject({ applied: true, changed: ['RIDEO_BRAND_OWNER'] });
      expect((await stack.api<any>('GET', '/config')).brand.owner).toBe('Nine Films');
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe('API keys registered in mm-gateway (docs/design/settings.md#provider-endpoints-and-api-keys)', () => {
  let gw: RunningMockGateway;
  let keyed: Stack;
  beforeAll(async () => {
    // A gateway like the real one: management behind its own token, only registered proxies served
    gw = await startMockGateway({
      latencyMs: 20,
      apiKey: 'gw-key',
      managementKey: 'admin',
      strictProxies: true,
    });
    keyed = await startStack({
      gw,
      env: {
        MM_GATEWAY_URL: '',
        RIDEO_STORAGE: '',
        RIDEO_EMBEDDED_DAV: 'true',
        RIDEO_TTS_PROVIDER: '',
        RIDEO_SFX_PROVIDER: '',
      },
    });
  });
  afterAll(async () => {
    await keyed?.stop();
    await gw?.close();
  });
  type Saved = SettingsView & { applied: boolean; changed: string[] };
  const settled = async () => {
    for (let i = 0; i < 100; i++) {
      const v = await keyed.api<SettingsView>('GET', '/settings');
      if (v.proxySync.status !== 'pending') return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the proxy sync did not settle');
  };

  it('says how each endpoint is reached before any key is set', async () => {
    const r = await keyed.api<Saved>('PUT', '/settings', {
      values: { MM_GATEWAY_URL: gw.url, MM_GATEWAY_API_KEY: 'gw-key' },
    });
    // no admin token and no keys: nothing to register, nothing known about the gateway's proxies
    expect(r.endpoints.llm).toMatchObject({
      on: true,
      proxy: 'unknown',
      key: 'none',
      url: 'https://api.openai.com/v1',
    });
    expect(r.endpoints.stt).toMatchObject({ on: false, proxy: 'off' });
    expect(r.proxySync.status).toBe('idle');
    const test = await keyed.api<any>('POST', '/settings/test', { target: 'llm' });
    expect(test).toMatchObject({ ok: false, detail: expect.stringMatching(/no proxy for api.openai.com/) });
    // with the admin token the studio can look: the gateway has no proxy for the text model
    const looked = await keyed.api<Saved>('PUT', '/settings', { values: { MM_GATEWAY_ADMIN_KEY: 'admin' } });
    expect(looked.proxySync.status).toBe('ok');
    expect(looked.endpoints.llm).toMatchObject({
      proxy: 'missing',
      detail: expect.stringMatching(/set an API key/),
    });
  });

  it('registers a key as the proxy’s account, used by the endpoints and jobs that share it', async () => {
    const r = await keyed.api<Saved>('PUT', '/settings', {
      values: {
        RIDEO_LLM_PROXY_DOMAIN: 'https://ai.example.com/v1',
        RIDEO_LLM_API_KEY: 'sk-text',
        RIDEO_LLM_MODEL: 'mock-llm',
        RIDEO_STT_PROXY_DOMAIN: 'https://ai.example.com/v1',
      },
    });
    expect(r.applied).toBe(true);
    expect(r.proxySync).toMatchObject({ status: 'ok', code: null });
    expect(r.fields.RIDEO_LLM_API_KEY).toEqual({ value: null, source: 'settings', locked: false, set: true });
    expect(r.endpoints.llm).toMatchObject({
      on: true,
      proxy: 'registered',
      key: 'own',
      domain: 'ai.example.com',
      url: 'https://ai.example.com/v1',
      model: 'mock-llm',
    });
    expect(r.endpoints.vision).toMatchObject({ proxy: 'registered', key: 'shared', keyFrom: 'llm' });
    expect(r.endpoints.stt).toMatchObject({ on: true, proxy: 'registered', key: 'shared', keyFrom: 'llm' });
    // in the gateway: one proxy at the origin, the key in the OpenAI header, the studio's own key to use it
    const { instance } = JSON.parse(await readFile(join(keyed.dataDir, 'gateway.json'), 'utf8'));
    expect(gw.management.proxies).toEqual([
      expect.objectContaining({
        base_url: 'https://ai.example.com',
        tags: [`rideo-${instance}`],
        accounts: [
          { id: expect.stringMatching(`^rideo-${instance}-`), headers: { authorization: 'Bearer sk-text' } },
        ],
      }),
    ]);
    expect(gw.management.keys.map((k) => k.id)).toEqual(['default', `rideo-${instance}`]);

    // the endpoint tests answer through it
    expect(await keyed.api<any>('POST', '/settings/test', { target: 'llm' })).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/mock-llm answered .*OK/),
    });
    expect(await keyed.api<any>('POST', '/settings/test', { target: 'stt' })).toMatchObject({ ok: true });
    expect(gw.counters.proxyAccounts['ai.example.com']).toMatchObject({
      key: `rideo-${instance}`,
      headers: { authorization: 'Bearer sk-text' },
    });

    // and so does the studio's work: a screenplay written through the registered proxy
    const story = await keyed.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Keyed',
      brief: { prompt: 'A lighthouse keeper' },
      settings: { targetDurationSec: 30, pilotDurationSec: 10 },
    });
    const job = await keyed.api<Job>('POST', `/projects/${story.id}/screenplay/generate`, {});
    expectSucceeded(await keyed.waitJob(story.id, job.id));

    // the key is in the settings file only, never in the audit log
    expect(JSON.parse(await readFile(join(keyed.dataDir, 'settings.json'), 'utf8')).values).toMatchObject({
      RIDEO_LLM_API_KEY: 'sk-text',
    });
    expect(JSON.stringify(await keyed.api<any[]>('GET', '/audit?type=settings.update'))).not.toContain(
      'sk-text',
    );

    // registered again at start, writing nothing new
    const revision = gw.management.revision;
    await keyed.restart();
    expect((await settled()).endpoints.llm.proxy).toBe('registered');
    expect(gw.management.revision).toBe(revision);
  }, 120_000);

  it('keeps the settings when the gateway refuses the admin token, and removes cleared keys', async () => {
    const refused = await keyed.api<Saved>('PUT', '/settings', { values: { MM_GATEWAY_ADMIN_KEY: 'wrong' } });
    expect(refused.applied).toBe(true);
    expect(refused.proxySync).toMatchObject({ status: 'failed', code: 'gateway_admin_unauthorized' });
    expect(refused.endpoints.llm).toMatchObject({
      proxy: 'failed',
      detail: expect.stringMatching(/admin token/),
    });
    expect(refused.fields.MM_GATEWAY_ADMIN_KEY?.set).toBe(true);

    await keyed.api<Saved>('PUT', '/settings', { values: { MM_GATEWAY_ADMIN_KEY: 'admin' } });
    const cleared = await keyed.api<Saved>('PUT', '/settings', {
      values: { RIDEO_LLM_API_KEY: null, RIDEO_LLM_PROXY_DOMAIN: null, RIDEO_STT_PROXY_DOMAIN: null },
    });
    expect(cleared.proxySync.status).toBe('ok');
    expect(cleared.endpoints.llm).toMatchObject({ key: 'none', proxy: 'missing' });
    expect(gw.management.proxies).toEqual([]);
    expect(gw.management.keys.map((k) => k.id)).toEqual(['default']);
  }, 60_000);

  it('refuses two keyed origins on one domain, naming the setting', async () => {
    const twice = await problem(
      keyed.api('PUT', '/settings', {
        values: {
          RIDEO_LLM_PROXY_DOMAIN: 'http://ai.example.com:8080/v1',
          RIDEO_LLM_API_KEY: 'a',
          RIDEO_EMBEDDINGS_PROXY_DOMAIN: 'https://ai.example.com/v1',
          RIDEO_EMBEDDINGS_API_KEY: 'b',
        },
      }),
    );
    expect(twice.status).toBe(422);
    expect(twice.body.errors).toEqual([
      expect.objectContaining({
        path: 'RIDEO_EMBEDDINGS_PROXY_DOMAIN',
        message: expect.stringMatching(/one API per domain/),
      }),
    ]);
  });
});

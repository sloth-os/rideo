import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

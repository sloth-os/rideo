import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../src/auth/context';
import { loadConfig } from '../../src/config';
import type { StudioHost } from '../../src/http/host';
import { effectiveConfig } from '../../src/http/host';
import { Metrics } from '../../src/metrics';
import { SettingsService } from '../../src/settings/service';
import { SettingsStore } from '../../src/settings/store';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
const principal = (over: Partial<Principal> = {}): Principal => ({
  kind: 'studio',
  user: { id: 'local', email: '', name: 'You', studioRole: 'admin', disabled: false },
  admin: true,
  token: null,
  actor: { kind: 'user', id: 'local', name: 'You' },
  ...over,
});

describe('settings store and service (docs/design/settings.md)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rideo-settings-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps settings only, written atomically for the server’s user alone', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(
      path,
      JSON.stringify({ version: 1, values: { MM_GATEWAY_URL: 'http://g', RIDEO_DATA_DIR: '/etc' } }),
    );
    const store = await new SettingsStore(path).load();
    expect(store.values).toEqual({ MM_GATEWAY_URL: 'http://g' });
    await store.save(
      { RIDEO_BRAND_NAME: 'Nine', MM_GATEWAY_API_KEY: 's' },
      { kind: 'user', id: 'u', name: 'U' },
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(Object.keys(file.values)).toEqual(['MM_GATEWAY_API_KEY', 'RIDEO_BRAND_NAME']);
    expect(file.updatedBy).toMatchObject({ id: 'u' });
    await writeFile(path, '{nope');
    const broken = await new SettingsStore(path).load();
    expect(broken.values).toEqual({});
    expect(broken.loadError).toMatch(/not valid/);
  });

  it('starts on the environment alone when the stored settings no longer validate', () => {
    const base = loadConfig({ RIDEO_DATA_DIR: dir, RIDEO_STORAGE: 'embedded' });
    const ok = effectiveConfig(base, { RIDEO_BRAND_NAME: 'Nine' });
    expect(ok.error).toBeNull();
    expect(ok.config.brand.name).toBe('Nine');
    const bad = effectiveConfig(base, { RIDEO_CONSISTENCY_THRESHOLD: 'high' });
    expect(bad.error).toMatch(/RIDEO_CONSISTENCY_THRESHOLD/);
    expect(bad.config.consistency.threshold).toBe(0.75);
  });

  it('is for administrators, never agent tokens, and masks secrets', async () => {
    const store = await new SettingsStore(join(dir, 'settings.json')).load();
    await store.save({ MM_GATEWAY_API_KEY: 'k-secret' }, null);
    const host = {
      config: loadConfig({ RIDEO_STORAGE: 'embedded' }),
      studio: { deps: { jobs: { runningCount: () => 0 } } },
    } as unknown as StudioHost;
    const service = new SettingsService({
      store,
      host,
      base: loadConfig({ RIDEO_BRAND_NAME: 'From env' }),
      error: null,
      log,
      metrics: new Metrics(),
    });
    const view = service.view(principal());
    expect(view.fields.MM_GATEWAY_API_KEY).toEqual({
      value: null,
      source: 'settings',
      locked: false,
      set: true,
    });
    expect(view.fields.RIDEO_BRAND_NAME).toEqual({
      value: 'From env',
      source: 'env',
      locked: true,
      set: true,
    });
    expect(() => service.view(null)).toThrow(/Sign in/);
    expect(() =>
      service.view(
        principal({
          kind: 'token',
          token: { id: 'tok_1', name: 'agent', role: 'director', projectIds: null } as never,
        }),
      ),
    ).toThrow(/administrators/);
    expect(() => service.view(principal({ kind: 'user', admin: false }))).toThrow(/administrators/);
    await expect(service.update(principal(), { values: { RIDEO_BRAND_NAME: 'x' } })).rejects.toMatchObject({
      code: 'setting_locked',
    });
  });
});

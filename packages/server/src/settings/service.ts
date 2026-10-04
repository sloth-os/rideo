import {
  SETTING_FIELDS,
  type SettingsTestInput,
  type SettingsTestResult,
  type SettingsUpdateInput,
  type SettingsView,
  type SettingValue,
} from '@rideo/shared';
import type { Principal } from '../auth/context';
import { type Config, loadConfig, nonEmptyEnv, resolveStorageMode } from '../config';
import type { Logger } from '../domain/deps';
import { AppError } from '../errors';
import { GatewayClient } from '../gateway/gateway-client';
import { describeConfigError, embeddedHasProjects, type StudioHost } from '../http/host';
import type { Metrics } from '../metrics';
import { WebDavBackend } from '../storage/webdav';
import { randomHex } from '../util/crypto';
import type { SettingsStore } from './store';

/** Settings are for administrators: the studio principal or an admin signed in; never an agent token. */
function requireAdmin(p: Principal | null): Principal {
  if (!p) throw new AppError('unauthorized', 'Sign in first');
  if (!p.admin || p.token) throw new AppError('forbidden', 'Only administrators change the studio settings');
  return p;
}

/** Zod issues of EnvSchema, keyed by setting, as problem-details errors. */
function issuesOf(err: unknown): { path: string; message: string }[] {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (Array.isArray(issues))
    return issues.map((i) => ({ path: i.path.map(String).join('.') || 'settings', message: i.message }));
  return [{ path: 'settings', message: err instanceof Error ? err.message : String(err) }];
}

/**
 * The Settings page and the `settings_*` MCP tools (docs/design/settings.md#surfaces): the view with sources and
 * locks, validated updates applied by reloading the studio, and connection tests.
 */
export class SettingsService {
  /** Why the stored settings are not in effect (invalid at start). */
  private error: string | null;

  constructor(
    private readonly deps: {
      store: SettingsStore;
      host: StudioHost;
      /** The configuration from the environment alone (its `source` is what settings are merged under). */
      base: Config;
      error: string | null;
      log: Logger;
      metrics: Metrics;
    },
  ) {
    this.error = deps.error ?? deps.store.loadError;
  }

  private env(): Record<string, string> {
    return nonEmptyEnv(this.deps.base.source.env);
  }

  view(principal: Principal | null): SettingsView {
    requireAdmin(principal);
    const env = this.env();
    const stored = this.deps.store.values;
    const fields: Record<string, SettingValue> = {};
    for (const f of SETTING_FIELDS) {
      const locked = f.env in env;
      const raw = locked ? env[f.env] : stored[f.env];
      fields[f.env] = {
        value: f.kind === 'secret' ? null : (raw ?? null),
        source: locked ? 'env' : raw !== undefined ? 'settings' : 'default',
        locked,
        set: raw !== undefined,
      };
    }
    const config = this.deps.host.config;
    return {
      fields,
      storage: config.storage.mode === 'auto' ? 'embedded' : config.storage.mode,
      gateway: config.gateway.configured,
      updatedAt: this.deps.store.updatedAt,
      updatedBy: this.deps.store.updatedBy,
      error: this.error,
      runningJobs: this.deps.host.studio.deps.jobs.runningCount(),
    };
  }

  /** The stored values with an update applied (null or '' clears a key). */
  private merged(values: SettingsUpdateInput['values']): Record<string, string> {
    const next: Record<string, string> = { ...this.deps.store.values };
    for (const [key, value] of Object.entries(values)) {
      const field = SETTING_FIELDS.find((f) => f.env === key)!;
      const v = value === null ? '' : field.kind === 'pem' || field.kind === 'secret' ? value : value.trim();
      if (v === '') delete next[key];
      else next[key] = v;
    }
    return next;
  }

  /** The configuration these settings would give (validation errors as 422 per setting). */
  private candidate(values: Record<string, string>): Config {
    try {
      const config = loadConfig({ ...this.deps.base.source.env }, this.deps.base.source.overrides, values);
      return resolveStorageMode(config, embeddedHasProjects(config));
    } catch (err) {
      throw new AppError('validation_error', 'Some settings are not valid', issuesOf(err));
    }
  }

  async update(
    principal: Principal | null,
    input: SettingsUpdateInput,
  ): Promise<SettingsView & { applied: boolean; changed: string[] }> {
    const p = requireAdmin(principal);
    const env = this.env();
    const locked = Object.keys(input.values).filter((k) => k in env);
    if (locked.length)
      throw new AppError(
        'setting_locked',
        `Set by the environment, so it cannot be changed here: ${locked.join(', ')}`,
        locked.map((k) => ({ path: k, message: 'set by the environment' })),
      );
    const before = { ...this.deps.store.values };
    const next = this.merged(input.values);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(next)])]
      .filter((k) => before[k] !== next[k])
      .sort();
    if (!changed.length && !this.error) return { ...this.view(p), applied: false, changed };
    const config = this.candidate(next);
    const previous = { values: before, actor: this.deps.store.updatedBy };
    await this.deps.store.save(next, p.actor);
    const started = Date.now();
    try {
      await this.deps.host.reload(config);
    } catch (err) {
      await this.deps.store.save(previous.values, previous.actor);
      this.deps.log.warn({ keys: changed, err: describeConfigError(err) }, 'settings not applied');
      throw new AppError(
        'validation_error',
        `The studio could not start with these settings: ${describeConfigError(err)}`,
        issuesOf(err),
      );
    }
    this.error = null;
    this.deps.log.info({ keys: changed, durationMs: Date.now() - started }, 'settings applied');
    await this.deps.host.studio.deps.accounts.record(p, 'settings.update', { detail: { keys: changed } });
    return { ...this.view(p), applied: true, changed };
  }

  /** Tries a connection with the values as they would be saved; nothing is stored. */
  async test(principal: Principal | null, input: SettingsTestInput): Promise<SettingsTestResult> {
    requireAdmin(principal);
    const env = this.env();
    const values = this.merged(
      Object.fromEntries(Object.entries(input.values).filter(([k]) => !(k in env))) as Record<string, string>,
    );
    const config = this.candidate(values);
    if (input.target === 'webdav') {
      if (!config.webdav.url) return { ok: false, detail: 'No WebDAV URL is set' };
      const storage = new WebDavBackend({
        url: config.webdav.url,
        username: config.webdav.username,
        password: config.webdav.password,
      });
      const probe = `${config.webdav.root}/.rideo-probe-${randomHex(6)}`;
      try {
        await storage.write(probe, 'rideo', { contentType: 'text/plain' });
        const back = await storage.read(probe);
        await storage.delete(probe);
        if (back?.toString() !== 'rideo') return { ok: false, detail: 'The probe file did not read back' };
        const entries = await storage.list(config.webdav.root);
        return {
          ok: true,
          detail: `Connected: ${config.webdav.url} (${config.webdav.root}, ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`,
        };
      } catch (err) {
        return { ok: false, detail: `WebDAV: ${(err as Error).message}` };
      }
    }
    if (!config.gateway.url) return { ok: false, detail: 'No gateway URL is set' };
    const gateway = new GatewayClient({
      url: config.gateway.url,
      apiKey: config.gateway.apiKey,
      pollMs: config.gateway.pollMs,
      timeoutsSec: config.gateway.timeoutsSec,
    });
    if (!(await gateway.health()))
      return { ok: false, detail: `mm-gateway at ${config.gateway.url} did not answer` };
    const models: Record<string, string[]> = {};
    const failures: string[] = [];
    for (const modality of ['image', 'video', 'music'] as const) {
      try {
        models[modality] = (await gateway.modelLimits(modality)).map((m) => m.id);
      } catch (err) {
        failures.push(`${modality}: ${(err as Error).message}`);
      }
    }
    const count = Object.values(models).reduce((n, m) => n + m.length, 0);
    return failures.length === 3
      ? { ok: false, detail: `The gateway answered but listed no models (${failures.join('; ')})` }
      : { ok: true, detail: `Connected: ${count} model(s)`, models };
  }
}

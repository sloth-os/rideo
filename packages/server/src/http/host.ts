import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Config, loadConfig, resolveStorageMode } from '../config';
import type { Logger } from '../domain/deps';
import { createStudio, type Studio } from '../domain/studio';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import { createEmbeddedDav, DAV_PREFIX } from '../storage/embedded-dav';
import { embeddedStoreDir, FsBackend } from '../storage/fs';
import { RoutedStorage } from '../storage/routed';
import { WebDavBackend } from '../storage/webdav';
import { WorkspaceRegistry } from '../storage/workspaces';
import { KeyedMutex } from '../util/mutex';

export type EmbeddedDav = ReturnType<typeof createEmbeddedDav>;

interface Hosted {
  config: Config;
  studio: Studio;
  storage: StorageBackend;
  dav: EmbeddedDav | null;
  /** Browser storage (docs/design/browser-storage.md): the tabs that keep projects, when projects live in browsers. */
  workspaces: WorkspaceRegistry | null;
}

/** Whether the built-in store already holds projects (an existing installation keeps using it). */
export function embeddedHasProjects(config: Config): boolean {
  try {
    return readdirSync(join(config.dataDir, 'dav', config.webdav.root, 'projects')).some((n) =>
      /^prj_[0-9a-z]{10,32}$/.test(n),
    );
  } catch {
    return false;
  }
}

/**
 * The configuration the studio runs on: the environment over the settings file, `auto` storage resolved
 * (docs/design/settings.md#where-values-come-from). Settings that fail validation are left out and reported.
 */
export function effectiveConfig(
  base: Config,
  settings: Readonly<Record<string, string>>,
): { config: Config; error: string | null } {
  let config = base;
  let error: string | null = null;
  if (Object.keys(settings).length) {
    try {
      config = loadConfig({ ...base.source.env }, base.source.overrides, settings);
    } catch (err) {
      error = describeConfigError(err);
    }
  }
  return { config: resolveStorageMode(config, embeddedHasProjects(config)), error };
}

/** A config error as one line (zod issues by setting). */
export function describeConfigError(err: unknown): string {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (Array.isArray(issues) && issues.length)
    return issues.map((i) => `${i.path.map(String).join('.') || 'settings'}: ${i.message}`).join('; ');
  return err instanceof Error ? err.message : String(err);
}

/**
 * Holds the running studio and swaps it when settings change (docs/design/settings.md#applying-a-change). Routes and
 * MCP tools use `host.studio`, a stable facade that forwards to the current studio, so a reload takes effect on the
 * next request without re-registering anything.
 */
export class StudioHost {
  private current: Hosted | null = null;
  private readonly lock = new KeyedMutex();
  /** The facade every surface holds. */
  readonly studio: Studio;
  /** Called with each new studio before it starts (recipes' tools, the settings service). */
  onBuilt?: (studio: Studio) => void;

  constructor(
    private readonly deps: {
      log: Logger;
      metrics: Metrics;
      /** Tests: one storage for every configuration. */
      storage?: StorageBackend;
      /** The HTTP port (the embedded WebDAV server is reached over loopback). */
      port: () => number;
    },
  ) {
    this.studio = new Proxy({} as Studio, {
      get: (_target, prop) => Reflect.get(this.hosted().studio, prop),
      has: (_target, prop) => Reflect.has(this.hosted().studio, prop),
    });
  }

  private hosted(): Hosted {
    if (!this.current) throw new Error('the studio is not built yet');
    return this.current;
  }

  get config(): Config {
    return this.hosted().config;
  }

  get storage(): StorageBackend {
    return this.hosted().storage;
  }

  /** The built-in WebDAV server, when this configuration mounts it. */
  get dav(): EmbeddedDav | null {
    return this.current?.dav ?? null;
  }

  /** The workspace registry, when projects live in browsers. */
  get workspaces(): WorkspaceRegistry | null {
    return this.current?.workspaces ?? null;
  }

  private build(config: Config): Hosted {
    const dav = config.webdav.embedded
      ? createEmbeddedDav({
          root: embeddedStoreDir(config.dataDir),
          username: config.webdav.davUsername,
          password: config.webdav.davPassword,
        })
      : null;
    const workspaces =
      !this.deps.storage && config.storage.mode === 'browser'
        ? new WorkspaceRegistry({
            metrics: this.deps.metrics,
            log: this.deps.log.child({ component: 'workspaces' }),
          })
        : null;
    const storage =
      this.deps.storage ??
      (workspaces
        ? new RoutedStorage(new FsBackend(embeddedStoreDir(config.dataDir)), workspaces, config.webdav.root)
        : this.createStorage(config));
    const studio = createStudio(config, { log: this.deps.log, storage, metrics: this.deps.metrics });
    if (workspaces) {
      const { hub, jobs, projects } = studio.deps;
      hub.workspaceHandler = workspaces;
      hub.onSessionClosed((sessionId) => workspaces.detach(sessionId));
      // A workspace's projects resume their jobs when one of its tabs attaches.
      workspaces.onProjects = (workspaceId, ids) => {
        for (const id of ids)
          void jobs
            .loadProject(id, config.jobRecovery)
            .catch((err) =>
              this.deps.log.warn({ err, projectId: id, workspaceId }, 'could not load job records'),
            );
      };
      // The browser changed a project by itself (an import): read it afresh.
      workspaces.onChanged = (workspaceId, ids) => {
        for (const id of ids) {
          projects.forget(id);
          workspaces.assign(id, workspaceId);
          hub.publish(id, { kind: 'head', branch: 'main', commit: null });
        }
      };
    }
    this.onBuilt?.(studio);
    return { config, studio, storage, dav, workspaces };
  }

  private createStorage(config: Config): StorageBackend {
    const metrics = this.deps.metrics;
    switch (config.storage.mode) {
      case 'webdav':
        return new WebDavBackend({
          url: config.webdav.url!,
          username: config.webdav.username,
          password: config.webdav.password,
          metrics,
          log: this.deps.log,
        });
      case 'embedded':
        return new WebDavBackend({
          url: () => `http://127.0.0.1:${this.deps.port()}${DAV_PREFIX}`,
          username: config.webdav.davUsername,
          password: config.webdav.davPassword,
          metrics,
          log: this.deps.log,
        });
      default:
        throw new Error(`storage mode ${config.storage.mode} needs a workspace registry`);
    }
  }

  /** Builds the first studio (started by start()). */
  init(config: Config): void {
    this.current = this.build(config);
  }

  async start(): Promise<void> {
    await this.hosted().studio.start();
  }

  /**
   * Replaces the studio with one built from `config`. A studio that fails to start is stopped and the previous
   * configuration is rebuilt, so a bad setting never leaves the server without a studio.
   */
  async reload(config: Config): Promise<void> {
    await this.lock.run('reload', async () => {
      const prev = this.hosted();
      const started = Date.now();
      let next: Hosted;
      try {
        next = this.build(config);
      } catch (err) {
        this.deps.metrics.settingsReloads.inc({ result: 'failed' });
        throw err;
      }
      await prev.studio.stop();
      prev.workspaces?.close();
      try {
        this.current = next;
        await next.studio.start();
        this.deps.metrics.settingsReloads.inc({ result: 'ok' });
        this.deps.log.info(
          { durationMs: Date.now() - started, storage: config.storage.mode },
          'studio reloaded',
        );
      } catch (err) {
        this.deps.log.error(
          { err },
          'the studio did not start with the new settings; restoring the previous ones',
        );
        await next.studio.stop().catch(() => undefined);
        next.workspaces?.close();
        const again = this.build(prev.config);
        this.current = again;
        await again.studio.start();
        this.deps.metrics.settingsReloads.inc({ result: 'rolled_back' });
        throw err;
      }
    });
  }

  async stop(): Promise<void> {
    await this.current?.studio.stop();
    this.current?.workspaces?.close();
  }
}

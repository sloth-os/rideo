import type { Readable } from 'node:stream';
import type { Entry, ReadResult, Stat, StorageBackend, WriteOptions } from './backend';
import { joinPath } from './backend';
import { currentWorkspace, storageOffline, type WorkspaceRegistry } from './workspaces';

const PROJECT_ID = /^prj_[0-9a-z]{10,32}$/;

type Route =
  | { kind: 'listing' }
  | { kind: 'project'; projectId: string }
  | { kind: 'trash'; projectId: string }
  | { kind: 'global' };

/**
 * The studio's storage when projects live in browsers (docs/design/browser-storage.md#routing-on-the-server):
 * studio-wide data in the data directory, each project in the workspace that holds it, and the project listing as the
 * union of both, scoped to the caller's workspace.
 */
export class RoutedStorage implements StorageBackend {
  readonly kind = 'routed' as const;
  private readonly root: string;
  /** Projects found in the data directory (kept from before projects moved to browsers). */
  private readonly globalProjects = new Set<string>();

  constructor(
    private readonly global: StorageBackend,
    private readonly workspaces: WorkspaceRegistry,
    root: string,
  ) {
    this.root = joinPath(root).replace(/\/+$/, '');
  }

  /** The workspace path of a storage path (relative to the root). */
  private inner(path: string): string {
    const p = joinPath(path).replace(/\/+$/, '');
    return p.slice(this.root.length) || '/';
  }

  private outer(path: string): string {
    return joinPath(this.root, path);
  }

  private classify(path: string): Route {
    const p = joinPath(path).replace(/\/+$/, '');
    if (p !== this.root && !p.startsWith(`${this.root}/`)) return { kind: 'global' };
    const segs = p.slice(this.root.length).split('/').filter(Boolean);
    if (segs[0] === 'projects') {
      if (segs.length === 1) return { kind: 'listing' };
      if (PROJECT_ID.test(segs[1]!)) return { kind: 'project', projectId: segs[1]! };
    }
    if (segs[0] === 'trash' && segs[1]) {
      const id = /^(prj_[0-9a-z]{10,32})-\d+$/.exec(segs[1])?.[1];
      if (id) return { kind: 'trash', projectId: id };
    }
    return { kind: 'global' };
  }

  private async inGlobal(projectId: string): Promise<boolean> {
    if (this.globalProjects.has(projectId)) return true;
    const s = await this.global.stat(joinPath(this.root, 'projects', projectId));
    if (s?.isDir) this.globalProjects.add(projectId);
    return !!s?.isDir;
  }

  /**
   * Where a project's files are: its workspace, the data directory, or (for a project nobody knows yet) the request's
   * workspace; null when the project does not exist anywhere reachable.
   */
  private async backendOf(projectId: string, intent: 'read' | 'write'): Promise<StorageBackend | null> {
    const owner = this.workspaces.owner(projectId);
    if (owner) return this.workspaces.storage(owner);
    if (await this.inGlobal(projectId)) return this.global;
    const context = currentWorkspace();
    if (context) {
      if (!(await this.workspaces.waitFor(context))) {
        if (intent === 'write')
          throw storageOffline('This browser is not connected to the studio yet; reload the page.');
        return null;
      }
      const known = this.workspaces.owner(projectId);
      if (known) return this.workspaces.storage(known);
      const ws = this.workspaces.storage(context);
      if (intent === 'write' || (await ws.stat(`/projects/${projectId}`))?.isDir) {
        this.workspaces.assign(projectId, context);
        return ws;
      }
      return null;
    }
    if (intent === 'write') {
      // Agents and jobs without a workspace of their own: the browser that attached last.
      const recent = this.workspaces.mostRecent();
      if (!recent)
        throw storageOffline('No browser is connected to keep this project. Open Rideo in a browser first.');
      this.workspaces.assign(projectId, recent);
      return this.workspaces.storage(recent);
    }
    return null;
  }

  private async resolve(
    path: string,
    intent: 'read' | 'write',
  ): Promise<{ backend: StorageBackend; path: string } | null> {
    const route = this.classify(path);
    if (route.kind === 'global' || route.kind === 'listing') return { backend: this.global, path };
    const backend = await this.backendOf(route.projectId, intent);
    if (!backend) return null;
    return backend === this.global ? { backend, path } : { backend, path: this.inner(path) };
  }

  async read(path: string): Promise<Buffer | null> {
    const r = await this.resolve(path, 'read');
    return r ? r.backend.read(r.path) : null;
  }

  async readStream(path: string, range?: { start: number; end?: number }): Promise<ReadResult | null> {
    const r = await this.resolve(path, 'read');
    return r ? r.backend.readStream(r.path, range) : null;
  }

  async write(
    path: string,
    data: Buffer | string | Readable,
    opts?: WriteOptions,
  ): Promise<{ etag?: string }> {
    const r = await this.resolve(path, 'write');
    if (!r) throw storageOffline();
    return r.backend.write(r.path, data, opts);
  }

  async stat(path: string): Promise<Stat | null> {
    if (this.classify(path).kind === 'listing') return { size: 0, mtime: 0, isDir: true };
    const r = await this.resolve(path, 'read');
    return r ? r.backend.stat(r.path) : null;
  }

  async list(dir: string): Promise<Entry[]> {
    if (this.classify(dir).kind === 'listing') return this.listProjects(dir);
    const r = await this.resolve(dir, 'read');
    if (!r) return [];
    const entries = await r.backend.list(r.path);
    return r.backend === this.global ? entries : entries.map((e) => ({ ...e, path: this.outer(e.path) }));
  }

  /** The projects folder: the data directory's, and those of the caller's workspace (or of every attached one). */
  private async listProjects(dir: string): Promise<Entry[]> {
    const out = new Map<string, Entry>();
    for (const e of await this.global.list(dir)) {
      if (e.isDir && PROJECT_ID.test(e.name)) this.globalProjects.add(e.name);
      out.set(e.name, e);
    }
    const context = currentWorkspace();
    const scope = context ? [context] : this.workspaces.attachedWorkspaces();
    for (const ws of scope) {
      if (!(await this.workspaces.waitFor(ws))) continue;
      for (const e of await this.workspaces.storage(ws).list('/projects')) {
        if (!e.isDir || !PROJECT_ID.test(e.name) || out.has(e.name)) continue;
        if (!this.workspaces.owner(e.name)) this.workspaces.assign(e.name, ws);
        out.set(e.name, { ...e, path: this.outer(e.path) });
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(path: string): Promise<void> {
    const r = await this.resolve(path, 'read');
    if (r) await r.backend.delete(r.path);
  }

  async move(from: string, to: string): Promise<void> {
    const a = await this.resolve(from, 'read');
    if (!a) return;
    const target = this.classify(to);
    // A project's trash stays with the project (its workspace, or the data directory).
    if (a.backend !== this.global && (target.kind === 'trash' || target.kind === 'project'))
      return a.backend.move(a.path, this.inner(to));
    const b = await this.resolve(to, 'write');
    if (!b || b.backend !== a.backend) throw new Error(`cannot move ${from} to ${to} across storages`);
    return a.backend.move(a.path, b.path);
  }

  async capabilities() {
    return this.global.capabilities();
  }

  /** Who holds a project the server knows: a workspace id, 'global' (the data directory), or null. */
  async holder(projectId: string): Promise<string | null> {
    const owner = this.workspaces.owner(projectId);
    if (owner) return owner;
    return (await this.inGlobal(projectId)) ? 'global' : null;
  }

  externallyEditable(projectDir: string): boolean {
    const route = this.classify(projectDir);
    return !(route.kind === 'project' && this.workspaces.owner(route.projectId));
  }
}

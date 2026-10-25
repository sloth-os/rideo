import { docsFromEntries, type ProjectDocs } from '@rideo/shared';
import { notFound } from '../errors';
import type { LiveHub } from '../live/hub';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { sleep } from '../util/abort';
import { Repository } from '../vcs/repo';
import { Worktree } from '../vcs/worktree';

export interface ProjectHandle {
  id: string;
  repo: Repository;
  worktree: Worktree;
  /** Its `.rideo/HEAD` was found: requests use the handle without asking storage again. */
  confirmed?: boolean;
}

/** One Repository + Worktree per project, wired to live events and metrics. */
export class ProjectRegistry {
  private readonly handles = new Map<string, ProjectHandle>();
  /** Commits on a project's checked-out branch, with the documents they changed (the search index follows them). */
  onCommit?: (projectId: string, docs: Record<string, unknown>) => void;

  constructor(
    private readonly deps: {
      storage: StorageBackend;
      layout: Layout;
      hub: LiveHub;
      metrics: Metrics;
      coalesceWindowMs: number;
      log?: { warn: (o: unknown, m?: string) => void };
      /** How long a missing `.rideo/HEAD` is given to show up before the project counts as gone (WebDAV: 1 s). */
      confirmMs?: number;
    },
  ) {}

  handle(projectId: string): ProjectHandle {
    let h = this.handles.get(projectId);
    if (h) return h;
    const repo = new Repository(this.deps.storage, this.deps.layout, projectId, {
      coalesceWindowMs: this.deps.coalesceWindowMs,
    });
    const worktree = new Worktree(
      this.deps.storage,
      this.deps.layout,
      projectId,
      this.deps.log,
      this.deps.metrics,
    );
    repo.materializer = worktree;
    repo.onCommit = (e) => {
      this.deps.metrics.commits.inc({ actor: e.summary.author.kind });
      const commit = e.replaces
        ? { ...e.summary, meta: { ...e.summary.meta, replaces: e.replaces } }
        : e.summary;
      this.deps.hub.publish(projectId, { kind: 'commit', commit, docs: e.checkedOut ? e.docs : null });
      if (e.checkedOut) this.onCommit?.(projectId, e.docs);
    };
    repo.onHead = (branch, commit) => this.deps.hub.publish(projectId, { kind: 'head', branch, commit });
    h = { id: projectId, repo, worktree };
    this.handles.set(projectId, h);
    return h;
  }

  /**
   * The handle of an existing project (404 otherwise). Storage is asked once per process (each time for a project
   * kept in a browser): projects go away through Rideo (`forget`), and sync's `verify` notices folders deleted
   * outside it. A missing `.rideo/HEAD` is looked for twice, `confirmMs` apart, before the project counts as gone:
   * a slow server can answer 404 for files it holds (docs/design/storage-webdav.md#slow-and-flaky-servers).
   */
  async existing(projectId: string, opts: { verify?: boolean } = {}): Promise<ProjectHandle> {
    let h: ProjectHandle;
    try {
      h = this.handle(projectId);
    } catch {
      throw notFound(`project ${projectId}`);
    }
    if (h.confirmed && !opts.verify && this.sticky(projectId)) return h;
    if (!(await h.repo.exists())) {
      const confirmMs = this.deps.confirmMs ?? (this.deps.storage.kind === 'webdav' ? 1000 : 0);
      if (confirmMs > 0) await sleep(confirmMs);
      if (!confirmMs || !(await h.repo.exists())) {
        if (this.handles.get(projectId) === h) this.handles.delete(projectId);
        throw notFound(`project ${projectId}`);
      }
      this.deps.log?.warn({ projectId }, 'project folder answered 404 once; found it on the second look');
    }
    h.confirmed = true;
    return h;
  }

  /**
   * Whether a project, once found, stays found: not for one kept in a browser, whose every request asks its tab
   * (that is how a closed browser is noticed, docs/design/browser-storage.md#routing-on-the-server).
   */
  private sticky(projectId: string): boolean {
    return this.deps.storage.externallyEditable?.(this.deps.layout.project(projectId)) !== false;
  }

  forget(projectId: string): void {
    this.handles.delete(projectId);
  }

  /** Writes what the work trees have queued, waiting at most `ms` (shutdown). */
  async flush(ms: number): Promise<void> {
    await Promise.all([...this.handles.values()].map((h) => h.worktree.flush(ms)));
  }

  async listIds(): Promise<string[]> {
    const entries = await this.deps.storage.list(this.deps.layout.projectsDir());
    return entries.filter((e) => e.isDir && /^prj_[0-9a-z]{10,32}$/.test(e.name)).map((e) => e.name);
  }

  async docs(projectId: string, branch?: string): Promise<ProjectDocs> {
    const h = await this.existing(projectId);
    const snap = await h.repo.snapshot(branch);
    return docsFromEntries(snap.docs);
  }
}

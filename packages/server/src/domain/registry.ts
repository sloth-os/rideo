import { docsFromEntries, type ProjectDocs } from '@rideo/shared';
import { notFound } from '../errors';
import type { LiveHub } from '../live/hub';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { Repository } from '../vcs/repo';
import { Worktree } from '../vcs/worktree';

export interface ProjectHandle {
  id: string;
  repo: Repository;
  worktree: Worktree;
}

/** One Repository + Worktree per project, wired to live events and metrics. */
export class ProjectRegistry {
  private readonly handles = new Map<string, ProjectHandle>();

  constructor(
    private readonly deps: {
      storage: StorageBackend;
      layout: Layout;
      hub: LiveHub;
      metrics: Metrics;
      coalesceWindowMs: number;
      log?: { warn: (o: unknown, m?: string) => void };
    },
  ) {}

  handle(projectId: string): ProjectHandle {
    let h = this.handles.get(projectId);
    if (h) return h;
    const repo = new Repository(this.deps.storage, this.deps.layout, projectId, {
      coalesceWindowMs: this.deps.coalesceWindowMs,
    });
    const worktree = new Worktree(this.deps.storage, this.deps.layout, projectId, this.deps.log);
    repo.materializer = worktree;
    repo.onCommit = (e) => {
      this.deps.metrics.commits.inc({ actor: e.summary.author.kind });
      const commit = e.replaces
        ? { ...e.summary, meta: { ...e.summary.meta, replaces: e.replaces } }
        : e.summary;
      this.deps.hub.publish(projectId, { kind: 'commit', commit, docs: e.checkedOut ? e.docs : null });
    };
    repo.onHead = (branch, commit) => this.deps.hub.publish(projectId, { kind: 'head', branch, commit });
    h = { id: projectId, repo, worktree };
    this.handles.set(projectId, h);
    return h;
  }

  /** The handle of an existing project (404 otherwise). */
  async existing(projectId: string): Promise<ProjectHandle> {
    let h: ProjectHandle;
    try {
      h = this.handle(projectId);
    } catch {
      throw notFound(`project ${projectId}`);
    }
    if (!(await h.repo.exists())) {
      this.handles.delete(projectId);
      throw notFound(`project ${projectId}`);
    }
    return h;
  }

  forget(projectId: string): void {
    this.handles.delete(projectId);
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

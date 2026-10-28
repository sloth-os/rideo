import { readFile, writeFile } from 'node:fs/promises';
import {
  agentCommits,
  docsFromEntries,
  type ProjectDigest,
  ProjectDigestSchema,
  type ProjectDocs,
  projectDigest,
} from '@rideo/shared';
import { AppError, notFound } from '../errors';
import type { LiveHub } from '../live/hub';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { sleep } from '../util/abort';
import { type CommitEvent, Repository } from '../vcs/repo';
import { Worktree } from '../vcs/worktree';

export interface ProjectHandle {
  id: string;
  repo: Repository;
  worktree: Worktree;
  /** Its `.rideo/HEAD` was found: requests use the handle without asking storage again. */
  confirmed?: boolean;
}

/** One Repository + Worktree per project, wired to live events and metrics. */
/** The recently used projects remembered across restarts (docs/design/storage-webdav.md#maintenance). */
const RECENT_KEPT = 20;
/** Commits read into the object cache when a project is warmed. */
const WARM_LOG = 100;
/** How long a WebDAV listing of the projects folder is reused (docs/design/storage-webdav.md#slow-and-flaky-servers). */
const IDS_TTL_MS = 60_000;
/** Commits a summary made from the documents reads for its agents' commits. */
const DIGEST_LOG = 100;

export class ProjectRegistry {
  private readonly handles = new Map<string, ProjectHandle>();
  /** When each project was last asked for, to warm the recent ones after a restart. */
  private readonly lastUsed = new Map<string, number>();
  /** Warm-ups started in this process, at most one per project. */
  private readonly warmed = new Map<string, Promise<void>>();
  /** What the project list and the Inbox show, by project: made once, then following the commits. */
  private readonly digests = new Map<string, ProjectDigest>();
  private readonly digesting = new Map<string, Promise<ProjectDigest>>();
  /** Summaries waiting to be written, a few seconds behind a burst of commits. */
  private readonly digestWrites = new Map<string, NodeJS.Timeout>();
  /** The projects folder listing (WebDAV only: it is slow there, and the browser's changes as tabs connect). */
  private ids: { at: number; ids: Promise<string[]> } | null = null;
  /** Commits on a project's checked-out branch, with the documents they changed (the search index follows them). */
  onCommit?: (projectId: string, docs: Record<string, unknown>) => void;

  constructor(
    private readonly deps: {
      storage: StorageBackend;
      layout: Layout;
      hub: LiveHub;
      metrics: Metrics;
      coalesceWindowMs: number;
      log?: { warn: (o: unknown, m?: string) => void; info?: (o: unknown, m?: string) => void };
      /** How long a missing `.rideo/HEAD` is given to show up before the project counts as gone (WebDAV: 1 s). */
      confirmMs?: number;
      /** Where the recently used projects are kept across restarts. */
      recentFile?: string;
      /** How long after a burst of commits a project's summary is written (3 s). */
      digestWriteMs?: number;
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
      if (e.checkedOut) {
        this.onCommit?.(projectId, e.docs);
        this.followCommit(projectId, repo, e);
      }
    };
    repo.onHead = (branch, commit) => {
      // Another branch checked out: its summary is made when next asked for
      this.digests.delete(projectId);
      this.deps.hub.publish(projectId, { kind: 'head', branch, commit });
    };
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
    this.lastUsed.set(projectId, Date.now());
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
    this.lastUsed.delete(projectId);
    this.warmed.delete(projectId);
    this.digests.delete(projectId);
    clearTimeout(this.digestWrites.get(projectId));
    this.digestWrites.delete(projectId);
    this.invalidateIds();
  }

  /**
   * What the project list and the Inbox show of a project (docs/design/storage-webdav.md#slow-and-flaky-servers): in
   * memory once made; else `.rideo/summary.json` when it is at the branch's tip; else made from the documents.
   */
  digest(projectId: string): Promise<ProjectDigest> {
    const hit = this.digests.get(projectId);
    if (hit) return Promise.resolve(hit);
    let made = this.digesting.get(projectId);
    if (!made) {
      made = this.makeDigest(projectId).finally(() => this.digesting.delete(projectId));
      this.digesting.set(projectId, made);
    }
    return made;
  }

  private async makeDigest(projectId: string): Promise<ProjectDigest> {
    const h = await this.existing(projectId);
    const branch = await h.repo.currentBranch();
    const tip = await h.repo.readRef(branch);
    const stored = await this.readDigest(projectId);
    if (stored && stored.summary.id === projectId && stored.branch === branch && stored.commit === tip) {
      this.deps.metrics.projectDigests.inc({ source: 'file' });
      return this.keepDigest(projectId, stored);
    }
    // Made from the documents, again when a commit landed meanwhile (one before the summary is kept is not followed);
    // a summary still behind is set right by the next commit, and a file behind the tip is made again when read
    for (let tries = 1; ; tries++) {
      const snap = await h.repo.snapshot(branch);
      const log = await h.repo.log({ branch, limit: DIGEST_LOG });
      const d = projectDigest({
        projectId,
        docs: docsFromEntries(snap.docs),
        branch,
        commit: snap.commit,
        updatedAt: log[0]?.timestamp,
        agents: agentCommits(log),
      });
      if (tries < 3 && (await h.repo.snapshot(branch)).commit !== d.commit) continue;
      this.deps.metrics.projectDigests.inc({ source: 'documents' });
      this.keepDigest(projectId, d);
      void this.writeDigest(projectId);
      return d;
    }
  }

  private keepDigest(projectId: string, d: ProjectDigest): ProjectDigest {
    // Kept only while the project is loaded here: a forgotten project's summary is made again
    if (this.handles.has(projectId)) this.digests.set(projectId, d);
    return d;
  }

  private async readDigest(projectId: string): Promise<ProjectDigest | null> {
    try {
      const raw = await this.deps.storage.read(this.deps.layout.digest(projectId));
      if (!raw) return null;
      const parsed = ProjectDigestSchema.safeParse(JSON.parse(raw.toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** A made summary follows the checked-out branch's commits; the file is written a few seconds behind them. */
  private followCommit(projectId: string, repo: Repository, e: CommitEvent): void {
    const prev = this.digests.get(projectId);
    if (!prev) return;
    // The tip and the agents' commits at once (commits arrive in order); what the documents show once they are read
    const agents = [
      ...(e.summary.author.kind === 'agent' ? agentCommits([e.summary]) : []),
      ...prev.agents.filter((a) => a.id !== e.replaces),
    ].slice(0, 50);
    this.digests.set(projectId, {
      ...prev,
      commit: e.summary.id,
      summary: { ...prev.summary, updatedAt: e.summary.timestamp },
      agents,
    });
    void repo
      .snapshot()
      .then((snap) => {
        const now = this.digests.get(projectId);
        if (!now || snap.branch !== now.branch) return;
        this.digests.set(
          projectId,
          projectDigest({
            projectId,
            docs: docsFromEntries(snap.docs),
            branch: snap.branch,
            commit: snap.commit,
            updatedAt: now.summary.updatedAt,
            agents: now.agents,
          }),
        );
        this.scheduleDigestWrite(projectId);
      })
      .catch((err) => {
        this.digests.delete(projectId);
        this.deps.log?.warn(
          { projectId, err: (err as Error).message },
          'could not update the project summary',
        );
      });
  }

  private scheduleDigestWrite(projectId: string): void {
    clearTimeout(this.digestWrites.get(projectId));
    const timer = setTimeout(() => {
      this.digestWrites.delete(projectId);
      void this.writeDigest(projectId);
    }, this.deps.digestWriteMs ?? 3000);
    timer.unref?.();
    this.digestWrites.set(projectId, timer);
  }

  private async writeDigest(projectId: string): Promise<void> {
    const d = this.digests.get(projectId);
    if (!d) return;
    try {
      await this.deps.storage.write(this.deps.layout.digest(projectId), JSON.stringify(d), {
        contentType: 'application/json',
      });
    } catch (err) {
      this.deps.log?.warn({ projectId, err: (err as Error).message }, 'could not write the project summary');
    }
  }

  /** A project was created, deleted or imported: the next listing asks storage. */
  invalidateIds(): void {
    this.ids = null;
  }

  /**
   * Loads a project's documents and reads its recent log into the object cache, once per process
   * (docs/design/storage-webdav.md#maintenance): the first History after a restart then reads no commit one at a time.
   */
  warm(projectId: string): Promise<void> {
    let w = this.warmed.get(projectId);
    if (!w) {
      const started = Date.now();
      w = this.existing(projectId)
        .then(async (h) => {
          await h.repo.snapshot();
          await h.repo.log({ limit: WARM_LOG });
          this.deps.metrics.projectsWarmed.inc();
          this.deps.log?.info?.({ projectId, ms: Date.now() - started }, 'project warmed');
        })
        .catch((err) => {
          this.warmed.delete(projectId);
          this.deps.log?.warn({ projectId, err: (err as Error).message }, 'could not warm the project');
        });
      this.warmed.set(projectId, w);
    }
    return w;
  }

  /** Warms the most recently used projects of the last run, one at a time (after a restart). */
  async warmRecent(count = 3): Promise<string[]> {
    const ids = (await this.readRecent()).slice(0, count);
    for (const id of ids) await this.warm(id);
    return ids;
  }

  /** The recently used projects, most recent first, from the file of the last run. */
  async readRecent(): Promise<string[]> {
    if (!this.deps.recentFile) return [];
    try {
      const raw = JSON.parse(await readFile(this.deps.recentFile, 'utf8')) as { projects?: unknown };
      return Array.isArray(raw.projects)
        ? raw.projects.filter((x): x is string => typeof x === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /** Writes the recently used projects (every few minutes and at shutdown). */
  async saveRecent(): Promise<void> {
    if (!this.deps.recentFile) return;
    const previous = await this.readRecent();
    const used = [...this.lastUsed].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const projects = [...new Set([...used, ...previous])].slice(0, RECENT_KEPT);
    await writeFile(this.deps.recentFile, JSON.stringify({ projects }));
  }

  /**
   * Looks up every loaded project on storage again and forgets the ones whose folder is gone
   * (docs/design/storage-webdav.md#maintenance): sync did it only for projects with live subscribers.
   */
  async verifyLoaded(): Promise<string[]> {
    const gone: string[] = [];
    for (const [id, h] of [...this.handles]) {
      if (!h.confirmed || !this.sticky(id)) continue;
      try {
        await this.existing(id, { verify: true });
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'not_found')) continue;
        this.forget(id);
        gone.push(id);
        this.deps.metrics.projectsVanished.inc();
        this.deps.log?.warn({ projectId: id }, 'project folder is gone; forgot the project');
      }
    }
    return gone;
  }

  /** Writes what the work trees, the recent logs and the summaries have queued, waiting at most `ms` (shutdown). */
  async flush(ms: number): Promise<void> {
    const queued = [...this.digestWrites.keys()];
    for (const id of queued) clearTimeout(this.digestWrites.get(id));
    this.digestWrites.clear();
    await Promise.all([
      ...[...this.handles.values()].map((h) => h.worktree.flush(ms)),
      Promise.race([
        Promise.all([
          ...queued.map((id) => this.writeDigest(id)),
          ...[...this.handles.values()].map((h) => h.repo.flushRecent()),
        ]),
        sleep(ms),
      ]),
    ]);
  }

  async listIds(): Promise<string[]> {
    const read = () =>
      this.deps.storage
        .list(this.deps.layout.projectsDir())
        .then((entries) =>
          entries.filter((e) => e.isDir && /^prj_[0-9a-z]{10,32}$/.test(e.name)).map((e) => e.name),
        );
    if (this.deps.storage.kind !== 'webdav') return read();
    const now = Date.now();
    if (!this.ids || now - this.ids.at > IDS_TTL_MS) {
      const ids = read();
      this.ids = { at: now, ids };
      ids.catch(() => {
        if (this.ids?.ids === ids) this.ids = null;
      });
    }
    return [...(await this.ids.ids)];
  }

  async docs(projectId: string, branch?: string): Promise<ProjectDocs> {
    const h = await this.existing(projectId);
    const snap = await h.repo.snapshot(branch);
    return docsFromEntries(snap.docs);
  }
}

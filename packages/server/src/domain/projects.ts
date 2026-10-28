import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Job } from '@rideo/shared';
import {
  type Actor,
  ASPECT_RESOLUTIONS,
  type CreateProjectInput,
  docPath,
  docsFromEntries,
  evaluateWorkflow,
  initialStage,
  kindFromMime,
  newId,
  type Project,
  ProjectAccessSchema,
  type ProjectDocs,
  type ProjectRole,
  type ProjectSettingsPatch,
  ProjectSettingsSchema,
  type ProjectSummary,
  type Resource,
  type UpdateProjectInput,
  type WorkflowEvaluation,
} from '@rideo/shared';
import { currentPrincipal } from '../auth/context';
import { invalid } from '../errors';
import { mimeFor } from '../media/store';
import { Service } from './base';

export interface ProjectState {
  seq: number;
  head: { branch: string; commit: string | null };
  docs: ProjectDocs;
  jobs: Job[];
  workflow: WorkflowEvaluation;
  syncIssues: { path: string; error: string }[];
}

export interface SyncReport {
  changed: string[];
  issues: { path: string; error: string }[];
  imported: string[];
  commit: string | null;
}

const WEBDAV_ACTOR: Actor = { kind: 'webdav', id: 'webdav', name: 'WebDAV' };
const INBOX_README =
  'Drop images, videos or audio files into this folder (via any WebDAV client).\nRideo imports them as project resources on the next sync and removes them from the inbox.\n';

function mergeSettings(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = mergeSettings(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** How long a deleted project stays in the trash (docs/design/storage-webdav.md#maintenance). */
const TRASH_KEEP_MS = 7 * 24 * 3600_000;

export class ProjectService extends Service {
  private readonly syncIssues = new Map<string, { path: string; error: string }[]>();

  defaultSettings(patch: ProjectSettingsPatch = {}) {
    const c = this.deps.config;
    const base = ProjectSettingsSchema.parse({
      models: c.gateway.models,
      consistency: {
        threshold: c.consistency.threshold,
        maxAttempts: c.consistency.maxAttempts,
        judge: c.consistency.judge,
        // New projects check every attempt for jumps and physics (docs/design/continuity.md#quality-checks-in-the-gate).
        qualityChecks: true,
      },
      // New projects speak their dialogue when the server has a TTS provider (docs/design/dialogue.md).
      dialogue: { mode: c.tts ? 'tts' : 'off', lipSync: true },
      // and use continuity-aware prompts (docs/design/continuity.md#prompt-version).
      generation: { promptVersion: 2 },
    });
    const merged = mergeSettings(
      base as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    if (patch.aspectRatio && !patch.resolution) merged.resolution = ASPECT_RESOLUTIONS[patch.aspectRatio];
    return ProjectSettingsSchema.parse(merged);
  }

  async create(actor: Actor, input: CreateProjectInput): Promise<Project> {
    const id = newId('project');
    const project: Project = {
      schemaVersion: 1,
      id,
      kind: input.kind,
      title: input.title.trim(),
      createdAt: new Date().toISOString(),
      brief: {
        prompt: input.brief?.prompt ?? '',
        attachmentResourceIds: input.brief?.attachmentResourceIds ?? [],
      },
      settings: this.defaultSettings(input.settings),
      workflow: { stage: initialStage(input.kind), approvals: {} },
      // With accounts the creator directs the project (docs/design/accounts.md#users-roles-and-projects).
      access: this.creatorAccess(),
    };
    const h = this.deps.projects.handle(id);
    await h.repo.init({ 'project.json': project }, actor, `Create ${input.kind} project “${project.title}”`);
    await this.deps.storage.write(`${this.deps.layout.inbox(id)}/README.txt`, INBOX_README, {
      contentType: 'text/plain',
    });
    await this.deps.jobs.loadProject(id, false);
    this.activity(id, actor, 'project.create', `Created “${project.title}”`);
    return project;
  }

  private creatorAccess(): Project['access'] {
    const p = currentPrincipal();
    if (this.deps.accounts.mode !== 'oidc' || !p || p.kind === 'studio') return null;
    return ProjectAccessSchema.parse({ members: [{ userId: p.user.id, role: 'director' }] });
  }

  /** The projects the caller may read, with their role. */
  async list(): Promise<ProjectSummary[]> {
    const out: ProjectSummary[] = [];
    const principal = currentPrincipal() ?? this.deps.accounts.studioPrincipal();
    for (const id of await this.deps.projects.listIds()) {
      try {
        const docs = await this.deps.projects.docs(id);
        const role = this.deps.accounts.roleInProject(principal, docs.project);
        if (!role) continue;
        const ev = evaluateWorkflow(docs);
        const log = await this.deps.projects.handle(id).repo.log({ limit: 1 });
        const poster = Object.values(docs.clips)
          .flatMap((c) => c.shots)
          .flatMap((s) => s.takes)
          .find((t) => t.video?.poster)?.video?.poster?.path;
        out.push({
          id,
          kind: docs.project.kind,
          title: docs.project.title,
          stage: ev.stage,
          createdAt: docs.project.createdAt,
          updatedAt: log[0]?.timestamp,
          targetDurationSec: docs.project.settings.targetDurationSec,
          plannedDurationSec: ev.plannedDurationSec,
          approvedDurationSec: ev.approvedDurationSec,
          ...(poster ? { posterPath: poster } : {}),
          role,
        });
      } catch (err) {
        this.deps.log.warn({ err, projectId: id }, 'skipping unreadable project');
      }
    }
    return out.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
  }

  /** Members (as people), invites and visibility (docs/design/accounts.md#surfaces). */
  async access(projectId: string) {
    const project = (await this.deps.projects.docs(projectId)).project;
    const principal = currentPrincipal() ?? this.deps.accounts.studioPrincipal();
    return {
      ...this.deps.accounts.describeAccess(project.access),
      open: !project.access,
      role: this.deps.accounts.roleInProject(principal, project),
    };
  }

  /** Sets visibility and the members by email (people not signed in yet are invited). */
  async setAccess(
    actor: Actor,
    projectId: string,
    input: { visibility?: 'private' | 'studio'; members?: { email: string; role: ProjectRole }[] },
  ) {
    const principal = currentPrincipal() ?? this.deps.accounts.studioPrincipal();
    await this.mutate(
      actor,
      projectId,
      (tx) => {
        const cur = tx.require<Project>('project.json', 'project');
        const access = this.deps.accounts.resolveAccess(principal, cur.access, input);
        tx.set('project.json', { ...cur, access });
        return access;
      },
      {
        message: (a) =>
          `Set access: ${a.visibility === 'studio' ? 'studio-visible, ' : ''}${a.members.length} member(s)${a.invites.length ? `, ${a.invites.length} invited` : ''}`,
      },
    );
    await this.deps.accounts.record(principal, 'project.access', {
      projectId,
      detail: { visibility: input.visibility, members: input.members },
    });
    return this.access(projectId);
  }

  async state(projectId: string): Promise<ProjectState> {
    const seq = this.deps.hub.currentSeq(projectId);
    const h = await this.deps.projects.existing(projectId);
    // A page opened: its History follows, so the recent log is read in the background (docs/design/storage-webdav.md#maintenance)
    void this.deps.projects.warm(projectId);
    const snap = await h.repo.snapshot();
    const docs = docsFromEntries(snap.docs);
    return {
      seq,
      head: { branch: snap.branch, commit: snap.commit },
      docs,
      jobs: this.deps.jobs.list(projectId).slice(0, 200),
      workflow: evaluateWorkflow(docs),
      syncIssues: this.syncIssues.get(projectId) ?? [],
    };
  }

  async update(actor: Actor, projectId: string, input: UpdateProjectInput): Promise<Project> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const p = tx.require<Project>('project.json', 'project');
        const next: Project = {
          ...p,
          ...(input.title ? { title: input.title.trim() } : {}),
          brief: { ...p.brief, ...input.brief },
          settings: input.settings
            ? ProjectSettingsSchema.parse(
                mergeSettings(
                  p.settings as unknown as Record<string, unknown>,
                  input.settings as Record<string, unknown>,
                ),
              )
            : p.settings,
        };
        if (input.settings?.aspectRatio && !input.settings.resolution)
          next.settings.resolution = ASPECT_RESOLUTIONS[input.settings.aspectRatio];
        tx.set('project.json', next);
        return next;
      },
      {
        message: `Update project${input.title ? ' title' : ''}${input.brief ? ' brief' : ''}${input.settings ? ' settings' : ''}`,
        coalesce:
          input.brief && !input.settings && !input.title ? { key: 'doc:project.json#brief' } : undefined,
      },
    );
    return result;
  }

  async remove(actor: Actor, projectId: string): Promise<void> {
    await this.deps.projects.existing(projectId);
    const at = Date.now();
    const folder = this.deps.layout.project(projectId);
    let target = `${this.deps.layout.trashDir()}/${projectId}-${at}`;
    try {
      await this.deps.storage.move(folder, target);
    } catch (err) {
      // Some WebDAV servers rename within a folder but cannot move to another (OpenList on cloud drives answers 500):
      // the folder is renamed where it is, to a name Rideo does not list (docs/design/storage-webdav.md)
      if ((err as { code?: string }).code !== 'storage_error') throw err;
      target = `${folder}.trashed-${at}`;
      await this.deps.storage.move(folder, target);
      this.deps.log.warn(
        { projectId, target, err: (err as Error).message },
        'project renamed in place: the storage cannot move it to the trash',
      );
    }
    this.deps.projects.forget(projectId);
    this.deps.log.info({ projectId, actor, target }, 'project moved to trash');
  }

  /**
   * Removes deleted projects for good 7 days after their deletion (docs/design/storage-webdav.md#maintenance): the
   * trash folder's `<id>-<time>` and, on servers that cannot move folders, `projects/<id>.trashed-<time>`.
   */
  async purgeTrash(now = Date.now()): Promise<string[]> {
    const { storage, layout } = this.deps;
    const older = (name: string, pattern: RegExp) => {
      const at = Number(pattern.exec(name)?.[1]);
      return Number.isFinite(at) && now - at > TRASH_KEEP_MS;
    };
    const trash = await storage.list(layout.trashDir()).catch(() => []);
    const renamed = await storage.list(layout.projectsDir()).catch(() => []);
    const targets = [
      ...trash
        .filter((e) => e.isDir && older(e.name, /^prj_[0-9a-z]+-(\d+)$/))
        .map((e) => `${layout.trashDir()}/${e.name}`),
      ...renamed
        .filter((e) => e.isDir && older(e.name, /^prj_[0-9a-z]+\.trashed-(\d+)$/))
        .map((e) => `${layout.projectsDir()}/${e.name}`),
    ];
    for (const path of targets) {
      await storage.delete(path);
      this.deps.metrics.trashPurged.inc();
      this.deps.log.info({ path }, 'deleted project removed for good after 7 days');
    }
    return targets;
  }

  async getDoc(projectId: string, path: string, at?: string): Promise<unknown> {
    const h = await this.deps.projects.existing(projectId);
    const doc = await h.repo.readDoc(path, at);
    if (doc === null) throw invalid(`no document at ${path}${at ? ` in ${at.slice(0, 8)}` : ''}`);
    return doc;
  }

  /** Applies external WebDAV edits and imports the inbox (docs/design/storage-webdav.md#external-edits). */
  async sync(projectId: string, opts: { discardInvalid?: boolean } = {}): Promise<SyncReport> {
    // The folder may have been deleted outside Rideo: look again
    const h = await this.deps.projects.existing(projectId, { verify: true });
    // The work tree catches up with the commits first: an edit made over a document a commit changed is overwritten
    await h.worktree.idle();
    const snap = await h.repo.snapshot();
    const scan = await h.worktree.scan(snap.docs);
    const report: SyncReport = {
      changed: Object.keys(scan.changes),
      issues: scan.issues,
      imported: [],
      commit: null,
    };
    if (report.changed.length) {
      const { commit } = await this.mutate(
        WEBDAV_ACTOR,
        projectId,
        (tx) => {
          for (const [p, doc] of Object.entries(scan.changes)) {
            if (doc === null) tx.delete(p);
            else tx.set(p, doc);
          }
        },
        { message: `External edit via WebDAV: ${report.changed.join(', ')}` },
      );
      report.commit = commit?.id ?? null;
    }
    const projectIssue = scan.issues.find((i) => i.path === 'project.json' && /deleted/.test(i.error));
    if (projectIssue || (opts.discardInvalid && scan.issues.length)) {
      await h.worktree.rematerialize(
        opts.discardInvalid ? scan.issues.map((i) => i.path) : ['project.json'],
        (await h.repo.snapshot()).docs,
      );
    }
    for (const issue of scan.issues)
      this.deps.hub.publish(projectId, { kind: 'sync-issue', path: issue.path, error: issue.error });
    this.syncIssues.set(
      projectId,
      opts.discardInvalid ? [] : scan.issues.filter((i) => i.path !== 'project.json'),
    );
    const files = scan.inbox.filter((f) => f.name !== 'README.txt');
    if (files.length) report.imported = await this.importInbox(projectId, files);
    // ...and shows what sync committed when it answers
    await h.worktree.idle();
    return report;
  }

  private async importInbox(
    projectId: string,
    files: { name: string; path: string; size: number }[],
  ): Promise<string[]> {
    const docs = await this.deps.projects.docs(projectId);
    const imported: Resource[] = [];
    for (const f of files) {
      const mime = mimeFor(f.name);
      const kind = kindFromMime(mime);
      if (!kind) continue;
      const res = await this.deps.storage.readStream(f.path);
      if (!res) continue;
      const tmp = this.deps.media.tmp(f.name.split('.').pop() ?? 'bin');
      try {
        await pipeline(res.stream, createWriteStream(tmp));
        // Audio and video are probed by a studio tab (media.process); images here.
        const media = await this.deps.media.putFile(projectId, tmp, {
          kind: 'uploads',
          name: f.name.replace(/\.[^.]+$/, ''),
          mime,
          probe: kind === 'image',
        });
        imported.push({
          id: newId('resource'),
          kind,
          role:
            kind === 'video'
              ? docs.project.kind === 'edit'
                ? 'source'
                : 'reference'
              : kind === 'audio'
                ? 'music'
                : 'reference',
          name: f.name,
          media,
          createdAt: new Date().toISOString(),
          origin: 'inbox',
          status: kind === 'image' ? 'ready' : 'processing',
        });
        await this.deps.storage.delete(f.path);
      } finally {
        await rm(tmp, { force: true });
      }
    }
    if (!imported.length) return [];
    await this.mutate(
      WEBDAV_ACTOR,
      projectId,
      (tx) => {
        for (const r of imported) tx.set(docPath.resource(r.id), r);
      },
      { message: `Import ${imported.length} file(s) from the WebDAV inbox` },
    );
    const branch = await this.branchOf(projectId);
    for (const r of imported.filter((x) => x.kind !== 'image')) {
      await this.deps.jobs.enqueue({
        projectId,
        kind: 'media.process',
        params: { resourceId: r.id },
        actor: WEBDAV_ACTOR,
        branch,
        dedupeKey: `process:${r.id}`,
        maxAttempts: 5,
      });
    }
    return imported.map((r) => r.name);
  }
}

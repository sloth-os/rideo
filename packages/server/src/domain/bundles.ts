import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  type Actor,
  BUNDLE_MANIFEST,
  BUNDLE_PREFIX,
  type BundleImportMode,
  bundledFile,
  bundleFileName,
  bundleRelPath,
  newId,
  type Project,
  type ProjectBundleManifest,
  ProjectBundleManifestSchema,
  parseTarHeader,
  rewriteProjectId,
  TAR_BLOCK,
  tarEnd,
  tarHeader,
  tarPadding,
} from '@rideo/shared';
import { currentPrincipal } from '../auth/context';
import { AppError, conflict, invalid } from '../errors';
import { joinPath } from '../storage/backend';
import { ObjectStore, type VcsObject } from '../vcs/objects';
import { VERSION } from '../version';
import { Service } from './base';
import type { Deps } from './deps';
import type { ProjectService } from './projects';

const INBOX_README =
  'Drop images, videos or audio files into this folder (via any WebDAV client).\nRideo imports them as project resources on the next sync and removes them from the inbox.\n';
/** Files that change after they are written (refs, the work tree): read whole before the archive starts. */
const immutable = (rel: string) => rel.startsWith('media/') || rel.startsWith('.rideo/objects/');

interface FileEntry {
  rel: string;
  path: string;
  size: number;
  data?: Buffer;
}

export interface BundleImport {
  id: string;
  title: string;
  kind: Project['kind'];
  mode: BundleImportMode;
  files: number;
  skipped: string[];
}

/**
 * Project files (docs/design/browser-storage.md#project-files-export-and-import): a project folder streamed out as a
 * `.rideo` archive, and an archive streamed into the studio's storage, as itself, in place of itself, or as a copy
 * with a new id.
 */
export class BundleService extends Service {
  constructor(
    deps: Deps,
    private readonly projectService: ProjectService,
  ) {
    super(deps);
  }

  /** The project's files, mutable ones (refs, HEAD, the work tree) read first so the archive is consistent. */
  private async files(projectId: string): Promise<FileEntry[]> {
    const root = this.deps.layout.project(projectId);
    const all: FileEntry[] = [];
    const dirs = [root];
    while (dirs.length) {
      const dir = dirs.shift()!;
      for (const e of await this.deps.storage.list(dir)) {
        const rel = e.path.slice(root.length + 1);
        if (!bundledFile(rel)) continue;
        if (e.isDir) dirs.push(e.path);
        else all.push({ rel, path: e.path, size: e.size });
      }
    }
    const mutable = all.filter((f) => !immutable(f.rel));
    for (const f of mutable) {
      f.data = (await this.deps.storage.read(f.path)) ?? Buffer.alloc(0);
      f.size = f.data.length;
    }
    // Objects and media written after the refs were read are not referenced by them: list those last.
    return [...mutable, ...all.filter((f) => immutable(f.rel))].sort((a, b) => a.rel.localeCompare(b.rel));
  }

  async export(projectId: string): Promise<{
    manifest: ProjectBundleManifest;
    filename: string;
    size: number;
    stream: Readable;
  }> {
    const h = await this.deps.projects.existing(projectId);
    const snap = await h.repo.snapshot();
    const project = snap.docs.get('project.json') as Project;
    const files = await this.files(projectId);
    const manifest: ProjectBundleManifest = {
      format: 'rideo-project',
      version: 1,
      projectId,
      title: project.title,
      kind: project.kind,
      createdAt: project.createdAt,
      exportedAt: new Date().toISOString(),
      generator: `Rideo ${VERSION}`,
      head: { branch: snap.branch, commit: snap.commit },
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
    };
    const json = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const size =
      TAR_BLOCK +
      json.length +
      tarPadding(json.length) +
      files.reduce((n, f) => n + TAR_BLOCK + f.size + tarPadding(f.size), 0) +
      TAR_BLOCK * 2;
    const storage = this.deps.storage;
    const now = Math.floor(Date.now() / 1000);
    const metrics = this.deps.metrics;
    const log = this.deps.log;
    async function* archive() {
      yield Buffer.from(tarHeader(BUNDLE_MANIFEST, json.length, now));
      yield json;
      yield Buffer.alloc(tarPadding(json.length));
      for (const f of files) {
        yield Buffer.from(tarHeader(`${BUNDLE_PREFIX}${f.rel}`, f.size, now));
        if (f.data) yield f.data;
        else {
          const r = await storage.readStream(f.path);
          if (!r || r.size !== f.size)
            throw new AppError('storage_error', `${f.rel} changed during the export`);
          for await (const chunk of r.stream) yield chunk as Buffer;
        }
        yield Buffer.alloc(tarPadding(f.size));
      }
      yield Buffer.from(tarEnd());
      metrics.bundles.inc({ direction: 'export', outcome: 'ok' });
      log.info({ projectId, files: files.length, bytes: manifest.bytes }, 'project exported');
    }
    return { manifest, filename: bundleFileName(project.title), size, stream: Readable.from(archive()) };
  }

  private async exists(projectId: string): Promise<boolean> {
    try {
      await this.deps.projects.existing(projectId);
      return true;
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_found') return false;
      throw err;
    }
  }

  /** Imports a project file (a local archive) into the studio's storage. */
  async import(actor: Actor, archive: string, mode: BundleImportMode = 'new'): Promise<BundleImport> {
    const fh = await open(archive, 'r');
    try {
      const block = Buffer.alloc(TAR_BLOCK);
      const readHeader = async (at: number) => {
        const { bytesRead } = await fh.read(block, 0, TAR_BLOCK, at);
        if (bytesRead < TAR_BLOCK) return null;
        return parseTarHeader(block);
      };
      let first: ReturnType<typeof parseTarHeader>;
      try {
        first = await readHeader(0);
      } catch (err) {
        throw invalid(`not a Rideo project file: ${(err as Error).message}`);
      }
      if (!first || first.name !== BUNDLE_MANIFEST)
        throw invalid('not a Rideo project file (no manifest first)');
      const buf = Buffer.alloc(first.size);
      await fh.read(buf, 0, first.size, TAR_BLOCK);
      const parsed = ProjectBundleManifestSchema.safeParse(JSON.parse(buf.toString('utf8') || 'null'));
      if (!parsed.success)
        throw invalid(
          'the project file’s manifest is not valid',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      const manifest = parsed.data;
      const exists = await this.exists(manifest.projectId);
      if (exists && mode === 'new')
        throw conflict(
          `“${manifest.title}” is already in this studio (${manifest.projectId}): replace it or import it as a copy`,
        );
      if (exists && mode === 'replace') {
        const principal = currentPrincipal() ?? this.deps.accounts.studioPrincipal();
        await this.deps.accounts.authorize(principal, manifest.projectId, 'project.manage');
        await this.projectService.remove(actor, manifest.projectId);
      }
      const targetId = mode === 'copy' ? newId('project') : manifest.projectId;
      const root = this.deps.layout.project(targetId);
      const skipped: string[] = [];
      let files = 0;
      let at = TAR_BLOCK + first.size + tarPadding(first.size);
      try {
        for (;;) {
          const h = await readHeader(at);
          if (!h) break;
          const start = at + TAR_BLOCK;
          at = start + h.size + tarPadding(h.size);
          if (h.type !== '0' && h.type !== '\0') continue;
          const rel = bundleRelPath(h.name);
          if (!rel) {
            skipped.push(h.name.slice(0, 200));
            continue;
          }
          const path = joinPath(root, rel);
          if (h.size <= 1024 * 1024) {
            const data = Buffer.alloc(h.size);
            if (h.size) await fh.read(data, 0, h.size, start);
            await this.deps.storage.write(path, data);
          } else {
            await this.deps.storage.write(
              path,
              createReadStream(archive, { start, end: start + h.size - 1 }),
              { size: h.size },
            );
          }
          files++;
        }
        if (!(await this.deps.storage.stat(this.deps.layout.head(targetId))))
          throw invalid('the project file has no version history (.rideo/HEAD)');
        if (mode === 'copy') await this.rewriteCopy(targetId);
      } catch (err) {
        await this.deps.storage.delete(root).catch(() => undefined);
        this.deps.projects.forget(targetId);
        throw err;
      }
      await this.deps.storage.write(`${this.deps.layout.inbox(targetId)}/README.txt`, INBOX_README, {
        contentType: 'text/plain',
      });
      this.deps.projects.forget(targetId);
      const handle = await this.deps.projects.existing(targetId);
      let title = manifest.title;
      if (mode === 'copy') {
        title = `${manifest.title} (copy)`.slice(0, 200);
        await handle.worktree.materializeAll((await handle.repo.snapshot()).docs);
        await this.projectService.update(actor, targetId, { title });
      }
      await this.deps.jobs.loadProject(targetId, false);
      this.deps.metrics.bundles.inc({ direction: 'import', outcome: 'ok' });
      this.deps.log.info({ projectId: targetId, from: manifest.projectId, mode, files }, 'project imported');
      this.activity(targetId, actor, 'project.import', `Imported “${title}” from a project file`);
      return { id: targetId, title, kind: manifest.kind, mode: exists ? mode : 'new', files, skipped };
    } catch (err) {
      this.deps.metrics.bundles.inc({ direction: 'import', outcome: 'failed' });
      throw err;
    } finally {
      await fh.close();
    }
  }

  /** A copy's history names its new id in every commit (rewriteProjectId); its refs move to the new commits. */
  private async rewriteCopy(projectId: string): Promise<void> {
    const layout = this.deps.layout;
    const storage = this.deps.storage;
    const objects = new ObjectStore(storage, layout, projectId);
    const refs: { path: string; body: Record<string, unknown>; commit: string }[] = [];
    for (const dir of [layout.branchesDir(projectId), layout.tagsDir(projectId)]) {
      for (const e of await storage.list(dir)) {
        if (e.isDir) continue;
        const buf = await storage.read(e.path);
        const body = buf ? (JSON.parse(buf.toString('utf8')) as Record<string, unknown>) : null;
        if (body && typeof body.commit === 'string') refs.push({ path: e.path, body, commit: body.commit });
      }
    }
    const mapped = await rewriteProjectId(
      {
        read: (id) =>
          objects.get(id) as Promise<Parameters<Parameters<typeof rewriteProjectId>[0]['write']>[0]>,
        write: (obj) => objects.put(obj as VcsObject),
      },
      [...new Set(refs.map((r) => r.commit))],
      projectId,
    );
    for (const r of refs)
      await storage.write(r.path, JSON.stringify({ ...r.body, commit: mapped.get(r.commit) ?? r.commit }), {
        contentType: 'application/json',
      });
  }
}

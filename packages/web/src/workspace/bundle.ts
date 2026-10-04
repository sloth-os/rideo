import {
  BUNDLE_MANIFEST,
  BUNDLE_MIME,
  BUNDLE_PREFIX,
  bundledFile,
  bundleFileName,
  bundleRelPath,
  type ProjectBundleManifest,
  ProjectBundleManifestSchema,
  parseTarHeader,
  TAR_BLOCK,
  tarEnd,
  tarHeader,
  tarPadding,
} from '@rideo/shared';
import type { WorkspaceStore } from './store';

/**
 * Project files in the browser (docs/design/browser-storage.md#project-files-export-and-import): a project of this
 * browser becomes a `.rideo` Blob made of its stored Blobs (no copy of the media), and a project file is read with
 * `File.slice` (no copy either) and written into the store.
 */

const VERSION = 'Rideo web';

async function json<T>(store: WorkspaceStore, path: string): Promise<T | null> {
  const r = await store.read(path);
  if (!r) return null;
  try {
    return JSON.parse(await r.blob.text()) as T;
  } catch {
    return null;
  }
}

export async function exportFromBrowser(
  store: WorkspaceStore,
  projectId: string,
): Promise<{ blob: Blob; filename: string; manifest: ProjectBundleManifest }> {
  const root = `/projects/${projectId}`;
  const project = await json<{ title: string; kind: 'story' | 'edit'; createdAt: string }>(
    store,
    `${root}/project.json`,
  );
  if (!project) throw new Error('This project is not in this browser');
  const head = (await json<{ branch: string }>(store, `${root}/.rideo/HEAD`)) ?? { branch: 'main' };
  const ref = await json<{ commit: string | null }>(store, `${root}/.rideo/refs/heads/${head.branch}`);
  const files = (await store.files(root))
    .map((e) => ({ entry: e, rel: e.path.slice(root.length + 1) }))
    .filter((f) => bundledFile(f.rel))
    .sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const parts: BlobPart[] = [];
  const now = Math.floor(Date.now() / 1000);
  let bytes = 0;
  const bodies: Blob[] = [];
  for (const f of files) {
    const r = await store.read(f.entry.path);
    const blob = r?.blob ?? new Blob([]);
    bodies.push(blob);
    bytes += blob.size;
  }
  const manifest: ProjectBundleManifest = {
    format: 'rideo-project',
    version: 1,
    projectId,
    title: project.title,
    kind: project.kind,
    createdAt: project.createdAt,
    exportedAt: new Date().toISOString(),
    generator: VERSION,
    head: { branch: head.branch, commit: ref?.commit ?? null },
    files: files.length,
    bytes,
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const pad = (n: number) => new Uint8Array(tarPadding(n));
  parts.push(tarHeader(BUNDLE_MANIFEST, manifestBytes.length, now), manifestBytes, pad(manifestBytes.length));
  files.forEach((f, i) => {
    const body = bodies[i]!;
    parts.push(tarHeader(`${BUNDLE_PREFIX}${f.rel}`, body.size, now), body, pad(body.size));
  });
  parts.push(tarEnd());
  return { blob: new Blob(parts, { type: BUNDLE_MIME }), filename: bundleFileName(project.title), manifest };
}

export interface ProjectFile {
  manifest: ProjectBundleManifest;
  entries: { rel: string; blob: Blob }[];
  skipped: string[];
}

/** Reads a project file: the manifest first, then the project's entries (lazy slices of the file). */
export async function readProjectFile(file: Blob): Promise<ProjectFile> {
  const header = async (at: number) =>
    parseTarHeader(new Uint8Array(await file.slice(at, at + TAR_BLOCK).arrayBuffer()));
  let first: Awaited<ReturnType<typeof header>>;
  try {
    first = file.size >= TAR_BLOCK ? await header(0) : null;
  } catch {
    throw new Error('This is not a Rideo project file');
  }
  if (!first || first.name !== BUNDLE_MANIFEST) throw new Error('This is not a Rideo project file');
  const raw = await file.slice(TAR_BLOCK, TAR_BLOCK + first.size).text();
  const parsed = ProjectBundleManifestSchema.safeParse(JSON.parse(raw || 'null'));
  if (!parsed.success) throw new Error('The project file’s manifest is not valid');
  const entries: ProjectFile['entries'] = [];
  const skipped: string[] = [];
  let at = TAR_BLOCK + first.size + tarPadding(first.size);
  while (at + TAR_BLOCK <= file.size) {
    const h = await header(at);
    if (!h) break;
    const start = at + TAR_BLOCK;
    at = start + h.size + tarPadding(h.size);
    if (h.type !== '0' && h.type !== '\0') continue;
    const rel = bundleRelPath(h.name);
    if (rel) entries.push({ rel, blob: file.slice(start, start + h.size) });
    else skipped.push(h.name);
  }
  if (!entries.some((e) => e.rel === '.rideo/HEAD'))
    throw new Error('The project file has no version history');
  return { manifest: parsed.data, entries, skipped };
}

/**
 * Writes a project file into this browser under its own id. `replace` first moves the browser's copy of the
 * project to the trash. (Copies with a new id are made by the server, which rewrites the history.)
 */
export async function importIntoBrowser(
  store: WorkspaceStore,
  project: ProjectFile,
  mode: 'new' | 'replace',
  onProgress?: (done: number, total: number) => void,
): Promise<{ id: string; title: string }> {
  const id = project.manifest.projectId;
  const root = `/projects/${id}`;
  const exists = (await store.stat(root))?.isDir;
  if (exists && mode === 'new') throw new Error(`“${project.manifest.title}” is already in this browser`);
  if (exists) await store.move(root, `/trash/${id}-${Date.now()}`);
  const total = project.entries.reduce((n, e) => n + e.blob.size, 0);
  let done = 0;
  try {
    for (const e of project.entries) {
      await store.write(`${root}/${e.rel}`, e.blob);
      done += e.blob.size;
      onProgress?.(done, total);
    }
  } catch (err) {
    await store.delete(root).catch(() => undefined);
    throw err;
  }
  return { id, title: project.manifest.title };
}

/** Saves a Blob as a file on the person's device. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

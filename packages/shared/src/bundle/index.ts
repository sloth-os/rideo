import { z } from 'zod';
import { ProjectKindSchema } from '../schemas/project';

/**
 * Project files (`.rideo`, docs/design/browser-storage.md#project-files-export-and-import): a POSIX tar archive whose
 * first entry is the manifest and whose other entries are the project folder under `project/`. Shared by the server
 * (streams) and the browser (Blobs), so both read and write the same files.
 */

export const BUNDLE_MANIFEST = 'rideo-project.json';
export const BUNDLE_PREFIX = 'project/';
export const BUNDLE_EXTENSION = '.rideo';
export const BUNDLE_MIME = 'application/x-tar';

export const ProjectBundleManifestSchema = z.object({
  format: z.literal('rideo-project'),
  version: z.literal(1),
  projectId: z.string().regex(/^prj_[0-9a-z]{10,32}$/),
  title: z.string().max(500),
  kind: ProjectKindSchema,
  createdAt: z.string().max(40),
  exportedAt: z.string().max(40),
  generator: z.string().max(100),
  head: z.object({ branch: z.string().max(200), commit: z.string().max(64).nullable() }),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type ProjectBundleManifest = z.infer<typeof ProjectBundleManifestSchema>;

export const BundleImportModeSchema = z.enum(['new', 'replace', 'copy']);
export type BundleImportMode = z.infer<typeof BundleImportModeSchema>;

/** Whether a file of the project folder travels in a project file: job records and the inbox stay behind. */
export function bundledFile(rel: string): boolean {
  return (
    !rel.startsWith('.rideo/jobs/') && rel !== '.rideo/jobs' && !rel.startsWith('inbox/') && rel !== 'inbox'
  );
}

/** The project-relative path of an archive entry, or null when the entry is not a safe project file. */
export function bundleRelPath(name: string): string | null {
  if (!name.startsWith(BUNDLE_PREFIX)) return null;
  const rel = name.slice(BUNDLE_PREFIX.length);
  if (!rel || rel.length > 400 || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0'))
    return null;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (!/^[A-Za-z0-9._@+=,~() -]+(\/[A-Za-z0-9._@+=,~() -]+)*$/.test(rel)) return null;
  return bundledFile(rel) ? rel : null;
}

/** A file name for the project file of a title. */
export function bundleFileName(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return `${base || 'project'}${BUNDLE_EXTENSION}`;
}

// ---- tar (ustar) ---------------------------------------------------------------------------------------------------

export const TAR_BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Bytes of padding after a file of `size` bytes. */
export function tarPadding(size: number): number {
  return (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
}

/** The two empty blocks that end an archive. */
export function tarEnd(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(TAR_BLOCK * 2);
}

/** A ustar header for a regular file; names up to 255 bytes are split into prefix (155) and name (100). */
export function tarHeader(name: string, size: number, mtimeSec = 0): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(TAR_BLOCK);
  let prefix = '';
  let base = name;
  if (encoder.encode(name).length > 100) {
    let cut = -1;
    for (let i = name.length - 1; i > 0; i--) {
      if (name[i] !== '/') continue;
      if (encoder.encode(name.slice(0, i)).length <= 155 && encoder.encode(name.slice(i + 1)).length <= 100) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) throw new Error(`tar: name too long: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const put = (s: string, at: number, len: number) => h.set(encoder.encode(s).subarray(0, len), at);
  const octal = (v: number, len: number) =>
    `${Math.floor(v)
      .toString(8)
      .padStart(len - 1, '0')}\0`;
  put(base, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  if (size >= 8 ** 11) {
    // GNU base-256 size for files of 8 GiB and more
    h[124] = 0x80;
    let v = BigInt(size);
    for (let i = 135; i > 124; i--) {
      h[i] = Number(v & 0xffn);
      v >>= 8n;
    }
  } else put(octal(size, 12), 124, 12);
  put(octal(mtimeSec, 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put('rideo', 265, 32);
  put('rideo', 297, 32);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

export interface TarEntryHeader {
  name: string;
  size: number;
  /** '0' (or '\0') regular file, '5' directory, 'x'/'g' pax headers, … */
  type: string;
}

function field(h: Uint8Array, at: number, len: number): string {
  const slice = h.subarray(at, at + len);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

/** Parses a header block; null for an empty (end) block; throws on a damaged one. */
export function parseTarHeader(h: Uint8Array): TarEntryHeader | null {
  if (h.length < TAR_BLOCK) throw new Error('tar: truncated header');
  if (h.every((b) => b === 0)) return null;
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  const stored = Number.parseInt(field(h, 148, 8).trim() || '0', 8);
  if (stored !== sum) throw new Error('tar: bad header checksum (not a project file?)');
  let size: number;
  if (h[124]! & 0x80) {
    let v = 0n;
    for (let i = 125; i < 136; i++) v = (v << 8n) | BigInt(h[i]!);
    size = Number(v);
  } else size = Number.parseInt(field(h, 124, 12).trim() || '0', 8);
  const name = field(h, 0, 100);
  const prefix = field(h, 345, 155);
  const type = String.fromCharCode(h[156] || 48);
  return { name: prefix ? `${prefix}/${name}` : name, size, type };
}

// ---- history rewrite (import as a copy) -----------------------------------------------------------------------------

interface TreeEntry {
  kind: 'blob' | 'tree';
  hash: string;
}
type VcsObject =
  | { type: 'blob'; content: unknown }
  | { type: 'tree'; entries: Record<string, TreeEntry> }
  | { type: 'commit'; tree: string; parents: string[]; [k: string]: unknown };

/** Reads and writes a project's version objects (write returns the new object's id). */
export interface ObjectIo {
  read(id: string): Promise<VcsObject>;
  write(obj: VcsObject): Promise<string>;
}

/**
 * Gives a copied project its new id in every commit (docs/design/browser-storage.md#project-files-export-and-import):
 * each `project.json` blob gets the new id, so its root tree and its commit (and every later commit) get new ids;
 * subtrees and other documents are shared. Commits are rewritten parents first, without recursion.
 */
export async function rewriteProjectId(
  io: ObjectIo,
  heads: readonly string[],
  newId: string,
): Promise<Map<string, string>> {
  const mapped = new Map<string, string>();
  const blobs = new Map<string, string>();
  const stack: { id: string; expanded: boolean }[] = heads.map((id) => ({ id, expanded: false }));
  const commits = new Map<string, Extract<VcsObject, { type: 'commit' }>>();
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    if (mapped.has(top.id)) {
      stack.pop();
      continue;
    }
    let commit = commits.get(top.id);
    if (!commit) {
      const obj = await io.read(top.id);
      if (obj.type !== 'commit') throw new Error(`object ${top.id.slice(0, 12)} is not a commit`);
      commit = obj;
      commits.set(top.id, commit);
    }
    if (!top.expanded) {
      top.expanded = true;
      for (const p of commit.parents) if (!mapped.has(p)) stack.push({ id: p, expanded: false });
      continue;
    }
    stack.pop();
    const tree = await io.read(commit.tree);
    if (tree.type !== 'tree') throw new Error(`object ${commit.tree.slice(0, 12)} is not a tree`);
    const entry = tree.entries['project.json'];
    let treeId = commit.tree;
    if (entry?.kind === 'blob') {
      let blobId = blobs.get(entry.hash);
      if (!blobId) {
        const blob = await io.read(entry.hash);
        if (blob.type !== 'blob') throw new Error('project.json is not a blob');
        blobId = await io.write({ type: 'blob', content: { ...(blob.content as object), id: newId } });
        blobs.set(entry.hash, blobId);
      }
      treeId = await io.write({
        type: 'tree',
        entries: { ...tree.entries, 'project.json': { kind: 'blob', hash: blobId } },
      });
    }
    const parents = commit.parents.map((p) => mapped.get(p)!);
    mapped.set(top.id, await io.write({ ...commit, tree: treeId, parents }));
  }
  return mapped;
}

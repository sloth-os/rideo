import { localProxyCommand, type MediaRef } from '@rideo/shared';
import { ffmpeg } from './ffmpeg';
import { mediaBlob } from './media-files';

/**
 * Local proxies for media this browser cannot decode (docs/design/editor.md#playback-compatibility-local-proxies):
 * VP8/Opus WebM made with ffmpeg.wasm, cached in the Origin Private File System (LRU, 2 GB) so they survive
 * reloads, and in memory when OPFS is unavailable.
 */

const VERSION = 'v1';
const MAX_BYTES = 2 * 1024 ** 3;
const memory = new Map<string, Blob>();
const inflight = new Map<string, Promise<Blob>>();

async function proxiesDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('proxies', { create: true });
  } catch {
    return null;
  }
}

async function fromDisk(name: string): Promise<Blob | null> {
  const dir = await proxiesDir();
  if (!dir) return null;
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return file.size > 0 ? file : null;
  } catch {
    return null;
  }
}

async function toDisk(name: string, blob: Blob): Promise<void> {
  const dir = await proxiesDir();
  if (!dir) return;
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    await trim(dir);
  } catch {
    // OPFS writes are unavailable here (e.g. Safari's main thread): memory only
  }
}

async function trim(dir: FileSystemDirectoryHandle): Promise<void> {
  const files: File[] = [];
  for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (handle.kind === 'file') files.push(await (handle as FileSystemFileHandle).getFile());
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const f of files.sort((a, b) => a.lastModified - b.lastModified)) {
    if (total <= MAX_BYTES) break;
    await dir.removeEntry(f.name).catch(() => undefined);
    total -= f.size;
  }
}

/** The local proxy of a media file (built on first use). */
export function localProxy(projectId: string, media: MediaRef, signal?: AbortSignal): Promise<Blob> {
  const name = `${media.hash}-${VERSION}.webm`;
  const cached = memory.get(name);
  if (cached) return Promise.resolve(cached);
  let p = inflight.get(name);
  if (!p) {
    p = (async () => {
      const disk = await fromDisk(name);
      if (disk) return disk;
      const src = await mediaBlob(projectId, media, signal);
      const out = '/out/proxy.webm';
      const r = await ffmpeg.run(localProxyCommand('/in/src', out, media), {
        inputs: { src },
        outputs: [out],
        signal,
      });
      const blob = new Blob([r.outputs[out]! as BlobPart], { type: 'video/webm' });
      memory.set(name, blob);
      await toDisk(name, blob);
      return blob;
    })();
    inflight.set(name, p);
    p.finally(() => inflight.delete(name)).catch(() => undefined);
  }
  return p;
}

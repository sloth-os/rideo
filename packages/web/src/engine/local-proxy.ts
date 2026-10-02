import { localProxyCommand, type MediaRef } from '@rideo/shared';
import { webCodecsCanDecode } from './codecs';
import { ffmpeg } from './ffmpeg';
import { mediaBlob } from './media-files';
import { type ProxyMethod, proxyName, proxyPlan } from './proxy-plan';

/**
 * Local proxies (docs/design/editor.md#playback-compatibility-local-proxies): WebM made with the hardware codecs
 * when WebCodecs decodes the original, with ffmpeg.wasm otherwise
 * (docs/design/engine-performance.md#local-proxies-made-with-webcodecs), cached in the Origin Private File System
 * (LRU, 2 GB) so they survive reloads, and in memory when OPFS is unavailable.
 */

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

/** A proxy made with WebCodecs: decoded, scaled to `height` lines, VP9 (else VP8) and Opus in WebM. */
async function webCodecsProxy(src: Blob, height: number, signal?: AbortSignal): Promise<Blob> {
  const m = await import('mediabunny');
  const input = new m.Input({ source: new m.BlobSource(src), formats: m.ALL_FORMATS });
  const target = new m.BufferTarget();
  const output = new m.Output({ format: new m.WebMOutputFormat(), target });
  try {
    const codec = (await m.canEncodeVideo('vp9')) ? 'vp9' : 'vp8';
    const conversion = await m.Conversion.init({
      input,
      output,
      // a key frame every half second, for scrubbing (as the ffmpeg proxy's -g 12)
      video: { height, codec, bitrate: 1_000_000, keyFrameInterval: 0.5, forceTranscode: true },
      audio: { codec: 'opus', bitrate: 64_000, forceTranscode: true },
    });
    if (!conversion.isValid)
      throw new Error(`cannot convert: ${conversion.discardedTracks.map((d) => d.reason).join(', ')}`);
    const abort = () => void conversion.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await conversion.execute();
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    if (signal?.aborted) throw new DOMException('The operation was cancelled', 'AbortError');
    return new Blob([target.buffer!], { type: 'video/webm' });
  } finally {
    input.dispose();
  }
}

/** A proxy made with ffmpeg.wasm (the original's codec is not decodable by WebCodecs). */
async function ffmpegProxy(src: Blob, media: MediaRef, signal?: AbortSignal): Promise<Blob> {
  const out = '/out/proxy.webm';
  const r = await ffmpeg.run(localProxyCommand('/in/src', out, media), {
    inputs: { src },
    outputs: [out],
    signal,
  });
  return new Blob([r.outputs[out]! as BlobPart], { type: 'video/webm' });
}

/** How the proxies this tab made were made (the engine state). */
export const proxiesMade: Record<ProxyMethod, number> = { webcodecs: 0, ffmpeg: 0 };

/** What plays when the original does not (built on first use). */
export async function playbackProxy(projectId: string, media: MediaRef, signal?: AbortSignal): Promise<Blob> {
  const blob = await localProxy(projectId, media, { purpose: 'playback', signal });
  if (!blob) throw new Error('no proxy is needed for this file');
  return blob;
}

/** A lighter picture of a heavy original for the preview, or null when it needs none. */
export function editingProxy(projectId: string, media: MediaRef, signal?: AbortSignal): Promise<Blob | null> {
  return localProxy(projectId, media, { purpose: 'editing', signal });
}

/** The local proxy of a media file for a purpose, built on first use (null when it needs none). */
export async function localProxy(
  projectId: string,
  media: MediaRef,
  opts: { purpose?: 'playback' | 'editing'; signal?: AbortSignal } = {},
): Promise<Blob | null> {
  const decodes = await webCodecsCanDecode(media);
  const plan = proxyPlan({
    decodes,
    plays: false,
    width: media.width,
    height: media.height,
    purpose: opts.purpose ?? 'playback',
  });
  if (!plan) return null;
  const name = proxyName(media.hash, plan);
  const cached = memory.get(name);
  if (cached) return cached;
  let p = inflight.get(name);
  if (!p) {
    p = (async () => {
      const disk = await fromDisk(name);
      if (disk) return disk;
      const src = await mediaBlob(projectId, media, opts.signal);
      let blob: Blob;
      if (plan.method === 'webcodecs') {
        try {
          blob = await webCodecsProxy(src, plan.height, opts.signal);
          proxiesMade.webcodecs++;
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          // a file WebCodecs reads but cannot convert (an unusual container): ffmpeg.wasm makes it
          blob = await ffmpegProxy(src, media, opts.signal);
          proxiesMade.ffmpeg++;
        }
      } else {
        blob = await ffmpegProxy(src, media, opts.signal);
        proxiesMade.ffmpeg++;
      }
      memory.set(name, blob);
      await toDisk(name, blob);
      return blob;
    })();
    inflight.set(name, p);
    p.finally(() => inflight.delete(name)).catch(() => undefined);
  }
  return p;
}

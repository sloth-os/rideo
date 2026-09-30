import type { MediaRef } from '@rideo/shared';
import { mediaUrl } from '../lib/api';

/**
 * Blob access to project media for the editor engine: files this tab uploaded are reused from memory; others
 * are downloaded once and kept in a small LRU (browsers back large Blobs with disk).
 */

const uploaded = new Map<string, Blob>();
const fetched = new Map<string, { blob: Blob; used: number }>();
const MAX_FETCHED_BYTES = 1024 ** 3;

export function rememberUpload(media: Pick<MediaRef, 'hash'>, blob: Blob): void {
  uploaded.set(media.hash, blob);
}

function evict(): void {
  let total = [...fetched.values()].reduce((s, e) => s + e.blob.size, 0);
  const oldest = [...fetched.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [hash, e] of oldest) {
    if (total <= MAX_FETCHED_BYTES || fetched.size <= 1) break;
    fetched.delete(hash);
    total -= e.blob.size;
  }
}

export async function mediaBlob(
  projectId: string,
  media: Pick<MediaRef, 'hash' | 'path'>,
  signal?: AbortSignal,
): Promise<Blob> {
  const own = uploaded.get(media.hash);
  if (own) return own;
  const hit = fetched.get(media.hash);
  if (hit) {
    hit.used = Date.now();
    return hit.blob;
  }
  const res = await fetch(mediaUrl(projectId, media.path), { signal });
  if (!res.ok) throw new Error(`could not download ${media.path} (HTTP ${res.status})`);
  const blob = await res.blob();
  fetched.set(media.hash, { blob, used: Date.now() });
  evict();
  return blob;
}

/** A stable, WORKERFS-safe input name for a media file. */
export function inputName(media: Pick<MediaRef, 'hash' | 'path'>): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(media.path)?.[1]?.toLowerCase() ?? 'bin';
  return `${media.hash.slice(0, 24)}.${ext}`;
}

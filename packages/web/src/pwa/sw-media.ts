import type { WorkspaceEntry } from '../workspace/store';

/**
 * The workspace database's name (workspace/store.ts DB_NAME, checked equal by the tests): spelled here so the service
 * worker imports nothing it would share with the app (a classic service worker cannot load chunks).
 */
export const SW_DB_NAME = 'rideo-workspace';

/**
 * Media of projects kept in this browser, answered by the service worker from IndexedDB
 * (docs/design/browser-storage.md#media-in-the-browser): with Range, so players and the editor engine seek in local
 * bytes. Null when the file is not (yet) in the browser: the request then goes to the server.
 */

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  cube: 'text/plain',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff2: 'font/woff2',
  tar: 'application/x-tar',
};

export function mimeOf(path: string): string {
  return TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** Opens the workspace database if it exists; never creates it (the app does, with its schema). */
function openExisting(idb: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let r: IDBOpenDBRequest;
    try {
      r = idb.open(SW_DB_NAME);
    } catch {
      resolve(null);
      return;
    }
    r.onupgradeneeded = () => r.transaction?.abort();
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('entries') || !db.objectStoreNames.contains('blobs')) {
        db.close();
        resolve(null);
      } else resolve(db);
    };
    r.onerror = () => resolve(null);
    r.onblocked = () => resolve(null);
  });
}

function get<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

/** Parses `bytes=a-b`, `bytes=a-`, `bytes=-n` against a size; null for none or an unsatisfiable range. */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export async function workspaceMediaResponse(
  path: string,
  rangeHeader: string | null,
  idb: IDBFactory,
): Promise<Response | null> {
  const db = await openExisting(idb);
  if (!db) return null;
  try {
    const tx = db.transaction(['entries', 'blobs'], 'readonly');
    const entry = await get<WorkspaceEntry>(tx.objectStore('entries'), path);
    if (!entry || entry.isDir || !entry.blob) return null;
    const blob = await get<Blob>(tx.objectStore('blobs'), entry.blob);
    if (!blob) return null;
    const type = entry.contentType || mimeOf(path);
    const size = blob.size;
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-rideo-source': 'browser',
    };
    const range = parseRange(rangeHeader, size);
    if (range === 'invalid')
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    if (!range)
      return new Response(blob, { status: 200, headers: { ...headers, 'content-length': String(size) } });
    return new Response(blob.slice(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...headers,
        'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  } finally {
    db.close();
  }
}

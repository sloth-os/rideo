/**
 * How the service worker answers a request (docs/design/pwa.md#the-app-shell): the app shell from the cache, live
 * data never, and media of projects kept in this browser from IndexedDB (docs/design/browser-storage.md#media-in-the-browser).
 * Paths are relative to the worker's scope, so the app works under a subpath (docs/design/subpath.md).
 */
export type Strategy = 'network-first-shell' | 'cache-first' | 'network' | 'workspace-media';

/** The path of a URL inside the scope ('' for the scope itself), or null outside it. */
export function scopedPath(url: URL, scope: string): string | null {
  const s = new URL(scope);
  if (url.origin !== s.origin || !url.pathname.startsWith(s.pathname)) return null;
  return url.pathname.slice(s.pathname.length);
}

const WORKSPACE_MEDIA = /^api\/projects\/(prj_[0-9a-z]{10,32})\/media\/(.+)$/;

export function strategyFor(url: URL, scope: string, method: string, mode: string): Strategy {
  if (method !== 'GET') return 'network';
  const path = scopedPath(url, scope);
  if (path === null) return 'network';
  if (WORKSPACE_MEDIA.test(path) && url.searchParams.has('ws')) return 'workspace-media';
  // live data: the API (and media under it), MCP, WebDAV
  if (path.startsWith('api/') || path === 'mcp' || path.startsWith('dav')) return 'network';
  if (mode === 'navigate') return 'network-first-shell';
  // hashed build files never change; the ffmpeg.wasm cores stay in the browser's HTTP cache
  if (path.startsWith('assets/') && !path.includes('ffmpeg-core')) return 'cache-first';
  return 'network';
}

/**
 * The workspace path of a browser project's media URL: `…/api/projects/prj_…/media/<media path>`, where the media path
 * is the project-relative one (`media/takes/…`), is stored at `/projects/prj_…/<media path>`.
 */
export function workspaceMediaPath(url: URL, scope: string): string | null {
  const m = WORKSPACE_MEDIA.exec(scopedPath(url, scope) ?? '');
  if (!m) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  if (!rel.startsWith('media/') || rel.split('/').some((s) => s === '' || s === '.' || s === '..'))
    return null;
  return `/projects/${m[1]}/${rel}`;
}

/** The cache of this version of the shell. */
export const SHELL_CACHE = 'rideo-shell-v2';
/** What is cached when the worker installs, relative to its scope. */
export const SHELL_FILES = ['./', 'manifest.webmanifest', 'logo.svg', 'icons/icon-192.png'];

export function shellUrls(scope: string): string[] {
  return SHELL_FILES.map((f) => new URL(f, scope).href);
}

/** A pushed message as the server sends it (docs/design/pwa.md#notifications-on-the-phone-web-push). */
export interface PushPayload {
  title: string;
  body: string;
  link: string;
  tag: string | null;
}

/** An app path (`/p/x?review=1`) under the scope (`/rideo/p/x?review=1`). */
function appLink(path: string, scope: string): string {
  const u = new URL(path.slice(1), scope);
  return u.pathname + u.search;
}

/** The notification of a push; its link (an app path like `/inbox`) opens under the scope. */
export function notificationOf(
  data: unknown,
  scope = 'https://rideo.invalid/',
): {
  title: string;
  options: NotificationOptions & { data: { link: string } };
} {
  const p = (data ?? {}) as Partial<PushPayload>;
  const app =
    typeof p.link === 'string' && p.link.startsWith('/') && !p.link.startsWith('//') ? p.link : '/inbox';
  return {
    title: p.title || 'Rideo',
    options: {
      body: p.body ?? '',
      icon: new URL('icons/icon-192.png', scope).pathname,
      badge: new URL('icons/badge-72.png', scope).pathname,
      ...(p.tag ? { tag: p.tag } : {}),
      data: { link: appLink(app, scope) },
    },
  };
}

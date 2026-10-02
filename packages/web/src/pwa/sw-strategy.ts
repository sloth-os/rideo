/**
 * How the service worker answers a request (docs/design/pwa.md#the-app-shell): the app shell from the cache, live
 * data never.
 */
export type Strategy = 'network-first-shell' | 'cache-first' | 'network';

export function strategyFor(url: URL, origin: string, method: string, mode: string): Strategy {
  if (method !== 'GET' || url.origin !== origin) return 'network';
  const path = url.pathname;
  // live data: the API (and media under it), MCP, WebDAV
  if (path.startsWith('/api/') || path === '/mcp' || path.startsWith('/dav')) return 'network';
  if (mode === 'navigate') return 'network-first-shell';
  // hashed build files never change; the ffmpeg.wasm cores stay in the browser's HTTP cache
  if (path.startsWith('/assets/') && !path.includes('ffmpeg-core')) return 'cache-first';
  return 'network';
}

/** The cache of this version of the shell. */
export const SHELL_CACHE = 'rideo-shell-v1';
/** What is cached when the worker installs. */
export const SHELL_FILES = ['/', '/manifest.webmanifest', '/logo.svg', '/icons/icon-192.png'];

/** A pushed message as the server sends it (docs/design/pwa.md#notifications-on-the-phone-web-push). */
export interface PushPayload {
  title: string;
  body: string;
  link: string;
  tag: string | null;
}

export function notificationOf(data: unknown): {
  title: string;
  options: NotificationOptions & { data: { link: string } };
} {
  const p = (data ?? {}) as Partial<PushPayload>;
  return {
    title: p.title || 'Rideo',
    options: {
      body: p.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      ...(p.tag ? { tag: p.tag } : {}),
      data: { link: typeof p.link === 'string' && p.link.startsWith('/') ? p.link : '/inbox' },
    },
  };
}

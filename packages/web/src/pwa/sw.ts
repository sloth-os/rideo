/// <reference lib="webworker" />
import { workspaceMediaResponse } from './sw-media';
import { notificationOf, SHELL_CACHE, shellUrls, strategyFor, workspaceMediaPath } from './sw-strategy';

/**
 * The service worker (docs/design/pwa.md): the app shell for offline starts, media of projects kept in this browser
 * (docs/design/browser-storage.md#media-in-the-browser), and Web Push notifications that open where they point. Built
 * as `sw.js` next to the app; its scope is the app's base (docs/design/subpath.md).
 */
declare const self: ServiceWorkerGlobalScope;

const scope = () => self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(shellUrls(scope())))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL_CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const strategy = strategyFor(url, scope(), req.method, req.mode);
  if (strategy === 'network') return;
  if (strategy === 'workspace-media') {
    const path = workspaceMediaPath(url, scope());
    if (!path) return;
    event.respondWith(
      workspaceMediaResponse(path, req.headers.get('range'), indexedDB)
        .catch(() => null)
        .then((res) => res ?? fetch(req)),
    );
    return;
  }
  if (strategy === 'cache-first') {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }
  // a page: the network, else the shell (the app says it is offline)
  const shell = new URL('./', scope()).href;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          void caches.open(SHELL_CACHE).then((c) => c.put(shell, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(shell)) ?? Response.error()),
  );
});

self.addEventListener('push', (event) => {
  let data: unknown = null;
  try {
    data = event.data?.json();
  } catch {
    data = { title: 'Rideo', body: event.data?.text() ?? '' };
  }
  const { title, options } = notificationOf(data, scope());
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link =
    (event.notification.data as { link?: string } | null)?.link ?? new URL('inbox', scope()).pathname;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).href.startsWith(scope()));
      if (open) {
        await open.navigate(link).catch(() => undefined);
        await open.focus();
        return;
      }
      await self.clients.openWindow(link);
    })(),
  );
});

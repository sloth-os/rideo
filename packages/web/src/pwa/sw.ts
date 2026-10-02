/// <reference lib="webworker" />
import { notificationOf, SHELL_CACHE, SHELL_FILES, strategyFor } from './sw-strategy';

/**
 * The service worker (docs/design/pwa.md): the app shell for offline starts, and Web Push notifications that open
 * where they point. Built as `/sw.js` (scope `/`).
 */
declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
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
  const strategy = strategyFor(new URL(req.url), self.location.origin, req.method, req.mode);
  if (strategy === 'network') return;
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
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          void caches.open(SHELL_CACHE).then((c) => c.put('/', copy));
        }
        return res;
      })
      .catch(async () => (await caches.match('/')) ?? Response.error()),
  );
});

self.addEventListener('push', (event) => {
  let data: unknown = null;
  try {
    data = event.data?.json();
  } catch {
    data = { title: 'Rideo', body: event.data?.text() ?? '' };
  }
  const { title, options } = notificationOf(data);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data as { link?: string } | null)?.link ?? '/inbox';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.navigate(link).catch(() => undefined);
        await open.focus();
        return;
      }
      await self.clients.openWindow(link);
    })(),
  );
});

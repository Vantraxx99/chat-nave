'use strict';
// Service worker: mostra le notifiche push anche ad app chiusa e, al tocco,
// apre la chat giusta. Non mette niente in cache (la chat è sempre online).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'Global Reunion';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Nuovo messaggio',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'chat',
    renotify: true,
    vibrate: [120, 60, 120],
    data: { convId: data.convId || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const convId = event.notification.data && event.notification.data.convId;
  const url = '/' + (convId ? '#' + convId : '');
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (new URL(client.url).origin === self.location.origin) {
        client.postMessage({ type: 'open-conv', convId });
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});

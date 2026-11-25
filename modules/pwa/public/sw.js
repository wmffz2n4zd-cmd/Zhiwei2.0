const CACHE = 'zhiwei-public-s153';
const STATIC_PATHS = ['/app.v1.css?v=s153', '/app.v1.js?v=s153', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.webmanifest'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC_PATHS))); });
self.addEventListener('activate', event => {
  // Retain the immediately previous asset cache while an old page may still use it.
  event.waitUntil((async () => { const keys = (await caches.keys()).filter(k => k.startsWith('zhiwei-public-')); for (const key of keys.slice(0, Math.max(0, keys.length - 2))) if (key !== CACHE) await caches.delete(key); await self.clients.claim(); })());
});
self.addEventListener('message', event => { if (event.data?.type === 'ACTIVATE_UPDATE') void self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !STATIC_PATHS.includes(url.pathname + url.search)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload = {}; try { payload = event.data?.json() || {}; } catch { /* Show a generic visible notification even with invalid data. */ }
    const messageId = typeof payload.messageId === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(payload.messageId) ? payload.messageId : '';
    const topic = typeof payload.tag === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(payload.tag) ? payload.tag : 'zhiwei-message';
    const preview = typeof payload.body === 'string' ? payload.body.slice(0, 180) : '知微发来了新消息';
    await self.registration.showNotification('知微', { body: preview, icon: '/icon-192.png', badge: '/icon-192.png', tag: topic, data: { messageId }, renotify: false });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const id = event.notification.data?.messageId;
    const target = new URL('/', self.location.origin); if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(id)) target.searchParams.set('message', id);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if (new URL(client.url).origin === self.location.origin) { client.postMessage({ type: 'OPEN_CONVERSATION', messageId: id }); await client.focus(); return; }
    await self.clients.openWindow(target.href);
  })());
});

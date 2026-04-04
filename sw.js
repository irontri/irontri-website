const CACHE_NAME = 'irontri-v34';
const STATIC_ASSETS = ['/irontri_logo.png','/irontri_logo.jpg','/icon-192.png','/icon-512.png','/manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('push', e => {
  let data = { title: 'irontri', body: 'Time to train! 🏊‍♂️🚴‍♂️🏃‍♂️', url: '/dashboard.html' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch(err) {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url },
    vibrate: [100, 50, 100]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/dashboard.html';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.includes('irontriapp.com') && 'focus' in c) return c.focus(); }
    return clients.openWindow(url);
  }));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.includes('/api/') || url.hostname.includes('supabase') || url.hostname.includes('anthropic') || url.hostname.includes('mailerlite')) return;
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});

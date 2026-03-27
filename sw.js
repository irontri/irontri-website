const CACHE_NAME = 'irontri-v30';
const STATIC_ASSETS = ['/irontri_logo.png','/irontri_logo.jpg','/icon-192.png','/icon-512.png','/manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.includes('/api/') || url.hostname.includes('supabase') || url.hostname.includes('anthropic') || url.hostname.includes('mailerlite')) return;
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});

const CACHE_NAME = 'irontri-v9';

// Only cache static non-HTML assets
const STATIC_ASSETS = [
  '/irontri_logo.png',
  '/irontri_logo.jpg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

// Install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — never cache HTML, always fetch fresh
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  
  // Always go to network for HTML pages and API calls
  if (e.request.mode === 'navigate' || 
      url.pathname.endsWith('.html') ||
      url.pathname.includes('/api/') ||
      url.hostname.includes('supabase') ||
      url.hostname.includes('anthropic') ||
      url.hostname.includes('mailerlite')) {
    return;
  }

  // For static assets, use cache first
  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request);
    })
  );
});

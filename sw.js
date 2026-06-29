/* ERONIX City Order Desk — service worker
   Precaches the app shell + the self-hosted Code 128 scan engine so the portal
   installs and scans offline on Android and iOS. Bump CACHE on every release. */
const CACHE = 'codesk-v35';
const PRECACHE = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-64.png',
  '/vendor/zxing/es/reader/index.js', '/vendor/zxing/es/share.js', '/vendor/zxing/zxing_reader.wasm'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;            // never cache actions
  if (u.pathname.startsWith('/.netlify/')) return;   // API + functions: always network
  if (u.pathname === '/packing.html') return;        // admin tool: always fresh, never cached

  // App shell (navigations + HTML): NETWORK-FIRST, so a new deploy is served
  // immediately even if CACHE wasn't bumped; fall back to cache only offline.
  const isNav = e.request.mode === 'navigate' || u.pathname === '/' || u.pathname.endsWith('.html');
  if (isNav) {
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp.ok && u.origin === location.origin) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return resp;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('/index.html')))
    );
    return;
  }

  // Static assets (icons / fonts / scan-engine wasm): CACHE-FIRST — fast + offline.
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
      if (resp.ok && u.origin === location.origin) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return resp;
    }).catch(() => caches.match('/index.html')))
  );
});

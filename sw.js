// Kuai Tracking service worker (view link / PWA).
// Network-first for HTML/JS/CSS so GitHub Pages updates are not stuck on Mac/phone.
const CACHE = 'kuai-tracking-v96';
const SHELL = ['./', 'icon.svg', 'manifest.json', 'img/gesex.png', 'img/fruitcolor.jpg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;

  // Always prefer network for the app shell (index / js / css) so ?v=95+ updates show up
  const p = url.pathname;
  const isApp = /\/(index\.html)?$/.test(p) || /\/(app|style|sw)\.(js|css)$/.test(p) || p.endsWith('/');
  if (isApp) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request).then(m => m || caches.match('./') || caches.match('index.html')))
    );
    return;
  }

  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});

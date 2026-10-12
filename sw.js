// Minimal service worker so Kuai Tracking can be installed as an app.
// Always goes to the network (the data lives on the local server), keeps the page shell for offline viewing.
const CACHE = 'kuai-tracking-v20';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'commands.js', 'icon.svg', 'manifest.json', 'img/gesex.png', 'img/fruitcolor.jpg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});

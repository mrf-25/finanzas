// Sube CACHE en cada versión nueva para que el iPhone descargue los cambios.
const CACHE = 'finanzas-v1.3.0';
const FILES = ['./', 'index.html', 'styles.css', 'calc.js', 'sync.js', 'app.js', 'manifest.webmanifest', 'fonts/archivo.woff2', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Primero la caché (funciona sin conexión); si no está, red.
// Las llamadas a la nube (otro dominio) van siempre a la red, nunca a la caché.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request))
  );
});

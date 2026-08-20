// Service worker для Vaultly.
// Кэшируем только статическую "оболочку" (HTML/CSS/JS/иконки), чтобы
// приложение открывалось офлайн. Запросы к /api/ НИКОГДА не кэшируются —
// это чувствительные и всегда актуальные данные.

const CACHE_NAME = 'vaultly-shell-v2';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.html',
  '/share.html',
  '/css/style.css',
  '/js/icons.js',
  '/js/crypto.js',
  '/js/api.js',
  '/js/auth.js',
  '/js/app.js',
  '/js/share.js',
  '/js/preview.js',
  '/js/zip.js',
  '/js/webauthn.js',
  '/js/webauthn-browser.js',
  '/js/pwa.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API и WebAuthn-эндпоинты — всегда только сеть, никогда не кэшируем
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResp) => {
          if (networkResp && networkResp.ok) {
            const clone = networkResp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResp;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

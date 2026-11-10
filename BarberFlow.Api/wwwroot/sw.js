// Service Worker básico para permitir instalación nativa PWA en Android e iOS
const CACHE_NAME = 'barberflow-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Red de paso normal para que siempre tenga datos frescos de citas y servicios
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
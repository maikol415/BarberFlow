// Service Worker básico para permitir instalación nativa PWA en Android e iOS
const CACHE_NAME = 'barberflow-v2';

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

// ---------- Notificaciones push del panel (Android) ----------
// La API envía { titulo, cuerpo, url, etiqueta }. Misma etiqueta = reemplaza el aviso anterior (ej. la misma cita).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { cuerpo: e.data ? e.data.text() : '' }; }
  const mostrar = self.registration.showNotification(d.titulo || 'BarberFlow', {
    body: d.cuerpo || '',
    icon: '/icons/bf-192.png',
    badge: '/icons/bf-badge-96.png',
    tag: d.etiqueta || undefined,
    renotify: !!d.etiqueta,
    vibrate: [120, 60, 120],
    data: { url: d.url || '/admin.html' }
  });
  // Si el panel está abierto, que recargue la agenda
  const avisarPaneles = clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(lista => lista.forEach(c => c.postMessage({ tipo: 'push-recibido' })));
  e.waitUntil(Promise.all([mostrar, avisarPaneles]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = new URL((e.notification.data && e.notification.data.url) || '/admin.html', self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    const panel = lista.find(c => c.url.startsWith(self.location.origin + '/admin'));
    if (panel) { panel.postMessage({ tipo: 'push-recibido' }); return panel.focus(); }
    return clients.openWindow(destino);
  }));
});

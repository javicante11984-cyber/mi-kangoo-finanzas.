/* Service worker de Mi Kangoo Finanzas.
 * Versión: 1.1.1   ← debe coincidir con version.js (las pruebas lo verifican)
 *
 * - Guarda los archivos de la app en una caché con el número de versión.
 * - Sirve siempre desde esa caché: los archivos nunca se mezclan entre versiones.
 * - Una versión nueva se descarga completa en segundo plano; si falta un archivo ESENCIAL, no se instala
 *   y sigue funcionando la versión anterior.
 * - Los íconos no son esenciales: si faltan en el sitio, la app igual funciona sin conexión
 *   (la pantalla Respaldo → "Revisar instalación" avisa qué falta).
 * - La versión nueva se activa solo cuando el usuario toca "Actualizar ahora".
 * - No guarda tus datos (esos están en IndexedDB).
 */
importScripts('version.js');
const VERSION = self.MKF_VERSION;
const PREFIJO = 'mkf-';
const CACHE = PREFIJO + VERSION;
const ESENCIALES = ['./', './index.html', './styles.css', './version.js', './calc.js', './graficos.js', './instalacion.js', './app.js', './manifest.webmanifest'];
const ICONOS = ['./icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon-48.png', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(ESENCIALES.map(u => new Request(u, { cache: 'reload' })));
    await Promise.all(ICONOS.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => null)));
  }));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith(PREFIJO) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => {
  if (e.data && e.data.tipo === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.searchParams.has('diagnostico')) return;   // la revisión de instalación consulta el sitio real, no la copia
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      const r = await cache.match('./index.html');
      if (r) return r;
    }
    const r = await cache.match(req, { ignoreSearch: true });
    if (r) return r;
    try { return await fetch(req); }
    catch (err) { return new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  })());
});

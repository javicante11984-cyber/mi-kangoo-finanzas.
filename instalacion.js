/* Mi Kangoo Finanzas — diagnóstico de instalación (PWA).
 * Revisa en el sitio publicado lo mismo que Chrome necesita para ofrecer "Instalar app":
 * manifest, íconos, service worker y archivos de la versión. No toca tus datos.
 * evaluar() es pura (se prueba con Node); revisar() hace los pedidos desde el navegador. */
'use strict';

const Instalacion = (function () {
  const ARCHIVOS_APP = ['index.html', 'styles.css', 'version.js', 'calc.js', 'graficos.js', 'instalacion.js', 'app.js', 'sw.js'];

  /* r = { seguro, sinConexion, manifest: {estado, json, error}, iconos: [{src, sizes, purpose, estado, tipo, ancho, alto}],
   *       archivos: [{nombre, estado}], versionPublicada, versionEnUso, sw: {registrado, activo, controla}, instalada } */
  function evaluar(r) {
    const items = [];
    const ok = (texto) => items.push({ ok: true, texto });
    const mal = (texto, arreglo) => items.push({ ok: false, texto, arreglo });
    if (r.instalada) ok('Estás usando la app instalada.');
    if (r.sinConexion) {
      mal('No hay conexión: no se puede revisar el sitio publicado.', 'Conectate a internet y volvé a tocar "Revisar instalación".');
      return { listo: false, items, motivo: 'sin-conexion' };
    }
    if (r.seguro) ok('La conexión es segura (https).');
    else mal('La página no se abrió con https.', 'Abrí la dirección que empieza con https:// (GitHub Pages la da así).');

    const m = r.manifest || {};
    if (m.estado !== 200) mal('No se encontró el archivo manifest.webmanifest (respuesta ' + (m.estado || 'sin respuesta') + ').', 'Subí manifest.webmanifest a GitHub, en la misma carpeta que index.html.');
    else if (!m.json) mal('El archivo manifest.webmanifest está dañado: ' + (m.error || 'no se puede leer') + '.', 'Volvé a subir manifest.webmanifest desde el ZIP.');
    else {
      const j = m.json;
      if ((j.name || j.short_name) && j.display === 'standalone' && j.start_url) ok('El manifest está completo (nombre, modo app y página de inicio).');
      else mal('Al manifest le faltan datos (nombre, "display": "standalone" o "start_url").', 'Volvé a subir manifest.webmanifest desde el ZIP.');
    }

    const iconos = r.iconos || [];
    const malos = iconos.filter(i => i.estado !== 200 || !/^image\/png/.test(i.tipo || '') || !i.ancho || i.sizes !== i.ancho + 'x' + i.alto);
    const usables = iconos.filter(i => !malos.includes(i) && (i.purpose || 'any').split(' ').includes('any') && i.ancho >= 144);
    malos.forEach(i => {
      if (i.estado !== 200) mal('Falta el ícono ' + i.src + ' en el sitio (respuesta ' + (i.estado || 'sin respuesta') + ').', 'Subí ' + i.src + ' a GitHub, en la misma carpeta que index.html.');
      else if (!/^image\/png/.test(i.tipo || '')) mal('El ícono ' + i.src + ' no es una imagen PNG (llegó como ' + (i.tipo || 'desconocido') + ').', 'Volvé a subir ' + i.src + ' desde el ZIP.');
      else mal('El ícono ' + i.src + ' mide ' + (i.ancho || '?') + 'x' + (i.alto || '?') + ' y el manifest dice ' + i.sizes + '.', 'Volvé a subir ' + i.src + ' desde el ZIP.');
    });
    if (m.json && !iconos.length) mal('El manifest no tiene íconos.', 'Volvé a subir manifest.webmanifest desde el ZIP.');
    if (usables.length) ok('Hay un ícono válido para instalar (' + usables.map(i => i.src).join(', ') + ').');
    else if (iconos.length) mal('Chrome no tiene un ícono válido de al menos 144 px: por eso no deja instalar y muestra una letra gris.', 'Subí los íconos que faltan (lista de arriba).');

    const faltan = (r.archivos || []).filter(a => a.estado !== 200);
    if (faltan.length) faltan.forEach(a => mal('Falta ' + a.nombre + ' en el sitio (respuesta ' + (a.estado || 'sin respuesta') + ').', 'Subí ' + a.nombre + ' a GitHub.'));
    else if ((r.archivos || []).length) ok('Están todos los archivos de la app.');

    if (r.versionPublicada && r.versionEnUso && r.versionPublicada !== r.versionEnUso)
      mal('En el sitio está la versión ' + r.versionPublicada + ' y estás usando la ' + r.versionEnUso + '.', 'Cerrá la app del todo y volvé a abrirla; tocá "Actualizar ahora" si aparece.');
    else if (r.versionPublicada) ok('La versión publicada (' + r.versionPublicada + ') es la que estás usando.');

    const sw = r.sw || {};
    if (sw.activo) ok('El modo sin conexión está activo.');
    else mal('El modo sin conexión no está activo todavía.', 'Recargá la página una vez con internet. Si sigue así, revisá que estén todos los archivos.');

    const listo = items.every(i => i.ok);
    return { listo, items, motivo: listo ? 'ok' : 'problemas' };
  }

  function texto(res, extra) {
    return ['Mi Kangoo Finanzas — revisión de instalación', extra || ''].concat(res.items.map(i => (i.ok ? '[OK] ' : '[X] ') + i.texto + (i.arreglo ? ' → ' + i.arreglo : ''))).join('\n');
  }

  async function pedir(url) {
    // "diagnostico" en la dirección hace que el service worker NO responda desde la copia guardada:
    // así vemos lo que está publicado de verdad en GitHub.
    const u = new URL(url, location.href);
    u.searchParams.set('diagnostico', Date.now());
    return fetch(u.href, { cache: 'no-store' });
  }

  async function revisar(versionEnUso) {
    const r = { seguro: window.isSecureContext && location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1',
      instalada: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true, versionEnUso, archivos: [], iconos: [] };
    if (navigator.onLine === false) { r.sinConexion = true; return r; }
    const link = document.querySelector('link[rel="manifest"]');
    const urlManifest = new URL(link ? link.getAttribute('href') : 'manifest.webmanifest', location.href);
    try {
      const resp = await pedir(urlManifest.href);
      r.manifest = { estado: resp.status };
      if (resp.ok) { try { r.manifest.json = JSON.parse(await resp.text()); } catch (e) { r.manifest.error = e.message; } }
    } catch (e) { r.sinConexion = true; return r; }
    const iconos = (r.manifest.json && Array.isArray(r.manifest.json.icons)) ? r.manifest.json.icons : [];
    for (const ic of iconos) {
      const d = { src: ic.src, sizes: ic.sizes, purpose: ic.purpose || 'any' };
      try {
        const resp = await pedir(new URL(ic.src, urlManifest).href);
        d.estado = resp.status; d.tipo = resp.headers.get('content-type') || '';
        if (resp.ok) { try { const bmp = await createImageBitmap(await resp.blob()); d.ancho = bmp.width; d.alto = bmp.height; } catch (e) { /* no es imagen */ } }
      } catch (e) { d.estado = 0; }
      r.iconos.push(d);
    }
    for (const nombre of ARCHIVOS_APP) {
      try {
        const resp = await pedir(nombre);
        r.archivos.push({ nombre, estado: resp.status });
        if (nombre === 'version.js' && resp.ok) { const m = (await resp.text()).match(/MKF_VERSION\s*=\s*'([^']+)'/); if (m) r.versionPublicada = m[1]; }
      } catch (e) { r.archivos.push({ nombre, estado: 0 }); }
    }
    try {
      const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
      r.sw = { registrado: !!reg, activo: !!(reg && reg.active), controla: !!(navigator.serviceWorker && navigator.serviceWorker.controller) };
    } catch (e) { r.sw = {}; }
    return r;
  }

  return { ARCHIVOS_APP, evaluar, texto, revisar };
})();

if (typeof module !== 'undefined') module.exports = Instalacion;

/* Mi Kangoo Finanzas — interfaz y almacenamiento */
'use strict';
const C = Calc;
const G = Graficos;
const APP_VERSION = self.MKF_VERSION || '?';
const DB_NAME = 'mi-kangoo-finanzas';
const STORE = 'kv';
const K_ESTADO = 'estado';
const K_PREVIO = 'respaldo_previo';
const K_PREMIG = 'pre_migracion_esquema1';   // copia intacta de los datos de la 1.0.x, guardada al actualizar

/* =====================================================================
 * ALMACENAMIENTO
 * Regla: la pantalla solo muestra un cambio DESPUÉS de que quedó guardado
 * y verificado (se vuelve a leer y se compara). Si algo falla, los datos
 * en pantalla y en el dispositivo quedan como estaban.
 * ===================================================================== */
class ErrorConflicto extends Error {}
class ErrorValidacion extends Error {}

let dbPromesa = null;
let usaLocalStorage = false;

function abrirDB() {
  if (!dbPromesa) {
    dbPromesa = new Promise((res, rej) => {
      if (!('indexedDB' in window)) return rej(new Error('Sin IndexedDB'));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Base de datos bloqueada'));
    }).catch(e => { dbPromesa = null; throw e; });
  }
  return dbPromesa;
}

async function dbLeer(k) {
  if (usaLocalStorage) { const v = localStorage.getItem('mkf_' + k); return v ? JSON.parse(v) : undefined; }
  const db = await abrirDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const q = tx.objectStore(STORE).get(k);
    q.onsuccess = () => res(q.result);
    tx.onabort = () => rej(tx.error || new Error('Lectura cancelada'));
  });
}

/* Guarda el estado nuevo (y, si se pide, otro registro) en UNA sola transacción.
 * Rechaza si otra ventana cambió los datos desde la última lectura (rev distinta). */
async function dbConfirmar(nuevo, revEsperada, extra) {
  if (usaLocalStorage) {
    const actual = await dbLeer(K_ESTADO);
    if (actual && (actual.rev || 0) !== revEsperada) throw new ErrorConflicto();
    const anteriorExtra = extra ? localStorage.getItem('mkf_' + extra.k) : null;
    try {
      if (extra) localStorage.setItem('mkf_' + extra.k, JSON.stringify(extra.v));
      localStorage.setItem('mkf_' + K_ESTADO, JSON.stringify(nuevo));
    } catch (e) {
      if (extra) { try { if (anteriorExtra === null) localStorage.removeItem('mkf_' + extra.k); else localStorage.setItem('mkf_' + extra.k, anteriorExtra); } catch (e2) { /* nada */ } }
      throw e;
    }
  } else {
    const db = await abrirDB();
    await new Promise((res, rej) => {
      let conflicto = false;
      let tx;
      try { tx = db.transaction(STORE, 'readwrite'); } catch (e) { return rej(e); }
      const st = tx.objectStore(STORE);
      const q = st.get(K_ESTADO);
      q.onsuccess = () => {
        const actual = q.result;
        if (actual && (actual.rev || 0) !== revEsperada) { conflicto = true; tx.abort(); return; }
        try {
          if (extra) st.put(extra.v, extra.k);
          st.put(nuevo, K_ESTADO);
        } catch (e) { try { tx.abort(); } catch (e2) { /* ya abortada */ } }
      };
      tx.oncomplete = () => res();
      tx.onabort = () => rej(conflicto ? new ErrorConflicto() : (tx.error || new Error('No se pudo escribir en el almacenamiento')));
    });
  }
  const leido = await dbLeer(K_ESTADO);
  if (!leido || JSON.stringify(leido) !== JSON.stringify(nuevo)) throw new Error('La verificación posterior al guardado falló.');
}

let estado = null;
let ocupado = false;
const clonar = o => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const canal = ('BroadcastChannel' in window) ? new BroadcastChannel('mkf') : null;
const ahoraISO = () => new Date().toISOString();

function erroresDe(e) { return C.validarEstado(e, hoyISO()); }

function mensajeError(e) {
  if (e instanceof ErrorConflicto) {
    mostrarBanner('Tus datos cambiaron en otra ventana. No se guardó nada.', 'Recargar datos', recargarDesdeAlmacen);
    return 'No se guardó: tus datos cambiaron en otra ventana o pestaña. Recargalos y volvé a intentar.';
  }
  if (e instanceof ErrorValidacion) return 'No se guardó: ' + e.message;
  if (e && e.name === 'QuotaExceededError') return 'No se guardó: el dispositivo no tiene espacio. Exportá una copia de seguridad.';
  return 'No se guardó ningún cambio (error de almacenamiento). Exportá una copia de seguridad y volvé a intentar.';
}

/*
 * Aplica un cambio de forma segura:
 * 1) trabaja sobre una copia, 2) valida, 3) guarda y verifica, 4) recién ahí actualiza la pantalla.
 * modo 'cambio': solo se rechazan errores NUEVOS (por si había datos viejos con problemas).
 * modo 'reemplazo': el estado nuevo debe ser 100 % válido.
 */
async function aplicarCambio(construir, { modo = 'cambio', extra = null } = {}) {
  if (ocupado) { aviso('Esperá: se está guardando el cambio anterior.', true); return false; }
  ocupado = true;
  document.body.classList.add('ocupado');
  try {
    const nuevo = construir(clonar(estado));
    if (!nuevo) return false;
    nuevo.rev = (estado.rev || 0) + 1;
    nuevo.actualizado = ahoraISO();
    const errs = erroresDe(nuevo);
    if (modo === 'reemplazo') { if (errs.length) throw new ErrorValidacion(errs[0]); }
    else { const viejos = new Set(erroresDe(estado)); const nuevos = errs.filter(x => !viejos.has(x)); if (nuevos.length) throw new ErrorValidacion(nuevos[0]); }
    await dbConfirmar(nuevo, estado.rev || 0, extra ? extra() : null);
    estado = nuevo;
    if (canal) try { canal.postMessage({ tipo: 'cambio', rev: estado.rev }); } catch (e) { /* nada */ }
    return true;
  } catch (e) {
    console.warn('Guardado rechazado:', e && e.message);
    aviso(mensajeError(e), true);
    return false;
  } finally {
    ocupado = false;
    document.body.classList.remove('ocupado');
  }
}

async function recargarDesdeAlmacen() {
  try {
    const g = await dbLeer(K_ESTADO);
    if (g) {
      const r = C.cargarEstado(g, ahoraISO());
      if (r.migrado) { location.reload(); return; }
      estado = r.estado;
    }
    ocultarBanner(); render(); aviso('Datos recargados.');
  } catch (e) { aviso('No se pudieron leer tus datos.', true); }
}
if (canal) canal.onmessage = ev => {
  if (ev.data && ev.data.tipo === 'cambio' && estado && ev.data.rev !== estado.rev)
    mostrarBanner('Tus datos se modificaron en otra ventana.', 'Ver datos actuales', recargarDesdeAlmacen);
};

/* ---------- Utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pesos = n => nf.format(Math.round(n));
const pesos2 = n => nf2.format(n);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mesTexto = aaaamm => { const [y, m] = aaaamm.split('-').map(Number); return MESES[m - 1] + ' de ' + y; };
const fechaTexto = iso => { if (!iso) return '—'; const [y, m, d] = iso.slice(0, 10).split('-'); return d + '/' + m + '/' + y; };
const fechaHoraTexto = iso => iso ? new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
const hoyISO = () => C.fechaClave(new Date());
const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
const etiqueta = est => '<span class="tag tag-' + esc(est.replace(/\s/g, '-').toLowerCase()) + '">' + esc(est) + '</span>';
const mesesTexto = n => n === 1 ? '1 mes' : n + ' meses';
const explicacion = (titulo, texto) => '<details class="explica"><summary>' + esc(titulo) + '</summary><p>' + texto + '</p></details>';
const montoInput = n => n ? String(n).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '';

let avisoTimer = null;
function aviso(txt, error) {
  const t = $('#toast');
  t.textContent = txt; t.className = 'toast visible' + (error ? ' error' : '');
  t.setAttribute('role', error ? 'alert' : 'status');
  clearTimeout(avisoTimer); avisoTimer = setTimeout(() => { t.className = 'toast'; }, error ? 7000 : 3000);
}
function mostrarBanner(texto, boton, accion) {
  const b = $('#banner');
  b.innerHTML = '<p>' + esc(texto) + '</p><button class="btn primario" type="button">' + esc(boton) + '</button>';
  b.querySelector('button').onclick = accion;
  b.hidden = false;
}
function ocultarBanner() { $('#banner').hidden = true; }

/* ---------- Navegación ---------- */
const PANTALLAS = { inicio: 'Inicio', ahorros: 'Mis ahorros', graficos: 'Gráficos', metas: 'Metas', respaldo: 'Respaldo' };
function pantallaActual() { const h = location.hash.replace('#', ''); return PANTALLAS[h] ? h : 'inicio'; }
function render() {
  if (!estado) return;
  const p = pantallaActual();
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('activo', a.dataset.p === p));
  $('#titulo').textContent = PANTALLAS[p];
  const main = $('#main');
  ({ inicio: renderInicio, ahorros: renderAhorros, graficos: renderGraficos, metas: renderMetas, respaldo: renderRespaldo })[p](main);
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

/* Botones para elegir el plazo principal (Inicio y Gráficos). */
function chipsPlazo() {
  const c = estado.config;
  return '<div class="chips" role="group" aria-label="Plazo de la meta">' + c.plazos.slice().sort((a, b) => a - b).map(p =>
    '<button type="button" class="chip' + (p === c.plazoPrincipal ? ' activo' : '') + '" data-plazo="' + p + '" aria-pressed="' + (p === c.plazoPrincipal) + '">' + p + ' meses</button>').join('') +
    '<a class="chip" href="#metas">Otro…</a></div>';
}
function activarChips(main) {
  main.querySelectorAll('[data-plazo]').forEach(b => b.addEventListener('click', async () => {
    const p = Number(b.dataset.plazo);
    if (p === estado.config.plazoPrincipal) return;
    if (await aplicarCambio(n => { n.config.plazoPrincipal = p; return n; })) render();
  }));
}

/* ---------- Inicio ---------- */
function renderInicio(main) {
  const hoy = new Date();
  const cfg = estado.config;
  const movs = estado.movimientos;
  const capital = C.capitalReal(movs);
  const mes = C.netoDelMes(movs, C.mesClave(hoy));
  const rec = C.recomendar(estado, hoy);
  const precio = C.precioVigente(estado.precios);
  const ep = C.estadoDePrecio(precio, hoy);
  const reserva = cfg.reservaEmergencia || 0;
  const disponible = capital - reserva;
  const pct = precio ? Math.max(0, Math.min(100, disponible / precio.precio * 100)) : 0;
  const problemas = erroresDe(estado);
  const plan = C.planVigente(cfg, C.mesClave(hoy));
  const meta = C.proyectarMeta(estado, cfg.plazoPrincipal, hoy);
  const alcance = C.mesesParaAlcanzar(estado, hoy);
  const ritmo = C.mesesAlRitmoReal(estado, hoy);

  let h = '';
  if (problemas.length) h += '<div class="card"><p class="msg malo"><b>Revisá tus datos:</b> se detectaron ' + problemas.length + ' problema(s) en registros anteriores. No afectan el cálculo del capital (las correcciones repetidas no se cuentan), pero conviene exportar una copia.</p><ul>' + problemas.slice(0, 5).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
  h += '<div class="card rec rec-' + esc(rec.codigo.split(' ')[0].toLowerCase()) + '"><p class="rec-cod">' + esc(rec.codigo) + '</p><p>' + esc(rec.texto) + '</p></div>';

  // 1. Capital REAL
  h += '<div class="card bloque-real"><p class="sub">Capital real ' + etiqueta('REAL') + '</p><p class="grande" id="capital">' + pesos(capital) + '</p>';
  if (mes > 0) h += '<p>Este mes ahorraste <b>' + pesos(mes) + '</b>.</p>';
  else if (mes < 0) h += '<p>Este mes tu capital bajó <b>' + pesos(-mes) + '</b>.</p>';
  else h += '<p>Este mes todavía no registraste ahorro.</p>';
  if (reserva > 0) h += '<p class="sub">Reserva de emergencia: ' + pesos(reserva) + ' (no se usa para el auto). Disponible para la Kangoo: ' + pesos(Math.max(0, disponible)) + '.</p>';
  h += explicacion('¿Qué es el capital real?', 'Es la suma de lo que registraste: depósitos, aguinaldos y rendimientos, menos retiros y comisiones. Es el único número que representa dinero que ya tenés.');
  h += '</div>';

  // 2. Precio (con su estado)
  h += '<div class="card bloque-precio"><p class="sub">Precio de la Kangoo ' + (precio ? etiqueta(ep) : etiqueta('SIN DATO')) + '</p>';
  if (precio) {
    h += '<p class="grande" id="precioVigente">' + pesos(precio.precio) + '</p>';
    if (precio.descripcion) h += '<p>' + esc(precio.descripcion) + '</p>';
    h += '<p class="sub">Fuente: ' + (precio.fuente ? esc(precio.fuente) : 'sin indicar') + ' · consultado: ' + (precio.fecha ? fechaTexto(precio.fecha) : 'fecha desconocida') + '</p>';
    h += '<div class="barra" role="progressbar" aria-valuenow="' + Math.round(pct) + '" aria-valuemin="0" aria-valuemax="100"><div style="width:' + pct.toFixed(1) + '%"></div></div>';
    h += '<p>Progreso: <b id="progreso">' + pct.toFixed(1).replace('.', ',') + '%</b> del precio (sin tocar tu reserva).</p>';
    const v = C.variacionPrecioVsCapital(estado);
    if (v) {
      const subio = v.variacionPrecio > 0;
      h += '<p class="msg ' + (subio && v.variacionPrecio > v.variacionCapital ? 'malo' : 'neutro') + '">Entre el ' + fechaTexto(v.desde) + ' y el ' + fechaTexto(v.hasta) + ' el precio ' + (subio ? 'subió ' : 'bajó ') + pesos(Math.abs(v.variacionPrecio)) +
        ' y tu capital ' + (v.variacionCapital >= 0 ? 'creció ' : 'bajó ') + pesos(Math.abs(v.variacionCapital)) + '.' +
        (subio && v.variacionPrecio > v.variacionCapital ? ' Tu capital creció, pero la Kangoo aumentó más rápido.' : '') +
        (v.mismoVehiculo ? '' : ' Ojo: los dos precios no son del mismo vehículo, la comparación es aproximada.') + '</p>';
    }
    h += '<p><a href="#metas">Actualizar precio o ver historial</a></p>';
  } else h += '<p>No cargaste un precio todavía.</p><p><a class="btn" href="#metas">Cargar precio</a></p>';
  h += '</div>';

  // 3. Cuánto falta (dinero y meses, ESTIMADO)
  h += '<div class="card bloque-estimado"><h3>¿Cuánto falta? ' + etiqueta('ESTIMADO') + '</h3>';
  if (alcance.estado === 'sin-precio') h += '<p>Cargá un precio para calcularlo.</p>';
  else if (alcance.estado === 'alcanzado') h += '<p class="msg bueno" id="falta">Ya tenés el precio más tu reserva. Antes de comprar falta calcular los gastos del auto (Etapa 3).</p>';
  else {
    h += '<p>En dinero: <b id="falta">' + pesos(alcance.falta) + '</b> (precio + reserva − capital real).</p>';
    if (alcance.estado === 'estimado') h += '<p>Con tu plan (' + pesos(plan.ahorroMensual) + ' por mes + aguinaldos): <b id="mesesPlan">' + mesesTexto(alcance.meses) + '</b>, hacia ' + mesTexto(alcance.mes) + '.</p>';
    else h += '<p id="mesesPlan">Con tu plan actual no se alcanza (el ahorro planeado es $0 o demasiado bajo).</p>';
    if (ritmo) {
      if (ritmo.meses === null) h += '<p>A tu ritmo real (promedio de ' + mesesTexto(ritmo.ritmo.meses) + ': ' + pesos(ritmo.ritmo.promedio) + ' por mes) no se alcanza.</p>';
      else h += '<p>A tu ritmo real (promedio de los últimos ' + mesesTexto(ritmo.ritmo.meses) + ': ' + pesos(ritmo.ritmo.promedio) + ' por mes): <b id="mesesRitmo">' + mesesTexto(ritmo.meses) + '</b>.</p>';
    } else h += '<p class="sub">Con 3 meses completos de registros también te mostramos una estimación según lo que ahorrás de verdad.</p>';
  }
  h += explicacion('¿Por qué es una estimación?', 'Supone que el precio de la Kangoo no cambia y que cumplís el plan todos los meses. En Argentina los precios suben: si la Kangoo aumenta más rápido que tu ahorro, vas a tardar más. Estas cuentas todavía no descuentan inflación (eso llega en la Etapa 3).');
  h += '</div>';

  // 4. Meta según el plazo elegido
  h += '<div class="card bloque-estimado"><h3>Tu meta a ' + mesesTexto(meta.plazoMeses) + '</h3>' + chipsPlazo();
  h += '<p class="sub">Objetivo: ' + mesTexto(meta.mesObjetivo) + ' · faltan ' + mesesTexto(meta.mesesRestantes) + '</p>';
  h += '<div class="fila"><span>Capital real hoy ' + etiqueta('REAL') + '</span><b>' + pesos(meta.capitalReal) + '</b></div>';
  h += '<div class="fila"><span>Ahorro planeado</span><b>+ ' + pesos(meta.ahorroProyectado) + '</b></div>';
  h += '<div class="fila"><span>Aguinaldos planeados (' + meta.cantAguinaldos + ')</span><b>+ ' + pesos(meta.aguinaldoProyectado) + '</b></div>';
  h += '<div class="fila total"><span>Podrías tener ' + etiqueta('ESTIMADO') + '</span><b id="metaTotal">' + pesos(meta.total) + '</b></div>';
  if (meta.necesario !== null) {
    h += '<div class="fila"><span>Necesitás (precio + reserva)</span><b>' + pesos(meta.necesario) + '</b></div>';
    h += meta.diferencia < 0 ? '<p class="msg malo">Faltarían ' + pesos(-meta.diferencia) + ' si el precio no cambia.</p>' : '<p class="msg bueno">Alcanzaría, con ' + pesos(meta.diferencia) + ' de margen, si el precio no cambia.</p>';
    if (meta.ahorroMensualNecesario !== null) h += '<p class="sub">Para llegar en ese plazo necesitarías ahorrar ' + pesos(meta.ahorroMensualNecesario) + ' por mes (hoy planeás ' + pesos(plan.ahorroMensual) + ').</p>';
  }
  h += '<p><a href="#graficos">Ver gráficos</a></p></div>';

  h += '<div class="card nota"><p><b>Cómo leer los datos:</b> ' + etiqueta('REAL') + ' es lo que registraste. ' + etiqueta('ESTIMADO') + ' es un cálculo con supuestos, no dinero disponible. Los precios llevan su estado: ' + etiqueta('VERIFICADO') + ' (fuente y fecha), ' + etiqueta('SIN VERIFICAR') + ' o ' + etiqueta('DESACTUALIZADO') + ' (más de ' + C.DIAS_DESACTUALIZADO + ' días).</p>';
  h += '<p class="sub">Última modificación guardada: ' + fechaHoraTexto(estado.actualizado) + ' · Última copia de seguridad generada: ' + fechaHoraTexto(estado.ultimoRespaldo) + '</p>';
  const diasResp = estado.ultimoRespaldo ? C.diasDesde(estado.ultimoRespaldo.slice(0, 10), hoy) : null;
  if (movs.length && (diasResp === null || diasResp > 30)) h += '<p class="msg malo">Hace mucho que no hacés una copia de seguridad. <a href="#respaldo">Hacerla ahora</a>.</p>';
  h += '</div>';
  main.innerHTML = h;
  activarChips(main);
}

/* ---------- Gráficos ---------- */
function renderGraficos(main) {
  const hoy = new Date();
  const cfg = estado.config;
  const mesHoy = C.mesClave(hoy);
  let h = '<div class="card nota"><p>Azul sólido = <b>real</b>. Azul claro o punteado = <b>estimado</b>. Naranja = <b>precio de la Kangoo</b>. Tocá un gráfico para ver los valores de cada mes.</p></div>';

  // 1. Evolución del capital real
  const sc = C.serieCapital(estado.movimientos, hoy);
  h += '<section class="card"><h3>Evolución de tu capital real ' + etiqueta('REAL') + '</h3><p class="sub">Capital al final de cada mes. Solo dinero registrado.</p><div class="graf">';
  h += G.lineas({ id: 'gCapital', titulo: 'Evolución del capital real', meses: sc.map(x => x.mes), series: [{ nombre: 'Capital real', valores: sc.map(x => x.capital), color: G.COLOR.real }],
    vacio: 'Cargá movimientos para ver la evolución de tu capital.' });
  h += '</div>' + (sc.length ? G.tabla(['Mes', 'Capital real'], sc.map(x => [G.mesLargo(x.mes), pesos2(x.capital)])) : '');
  h += explicacion('¿Por qué puede bajar?', 'Baja si registrás retiros o comisiones. Las correcciones se aplican en el mes del movimiento corregido, para que la historia muestre lo que realmente tenías.');
  h += '</section>';

  // 2. Ahorro real vs proyectado
  const sa = C.serieAportesVsPlan(estado, hoy).slice(-24);
  h += '<section class="card"><h3>Ahorro real frente al plan</h3><p class="sub">Lo que aportaste cada mes (depósitos + aguinaldos − retiros) y la marca de lo que planeabas.</p><div class="graf">';
  h += G.barras({ id: 'gAportes', titulo: 'Ahorro real frente al plan', categorias: sa.map(x => G.etiquetaMes(x.mes)), titulos: sa.map(x => G.mesLargo(x.mes) + (x.enCurso ? ' (en curso)' : '')),
    barras: [{ nombre: 'Aporte real', valores: sa.map(x => x.real), color: G.COLOR.real }],
    marcas: [{ nombre: 'Plan', valores: sa.map(x => x.plan), color: G.COLOR.plan }],
    vacio: 'Tu plan empieza en ' + mesTexto(cfg.fechaInicio) + '.' });
  h += '</div>' + G.leyenda([{ nombre: 'Aporte real', color: G.COLOR.real, forma: 'barra', etiqueta: 'REAL' }, { nombre: 'Plan del mes', color: G.COLOR.plan }]);
  if (sa.length) {
    const u = sa[sa.length - 1];
    const dif = u.acumuladoReal - u.acumuladoPlan;
    h += '<p id="resumenAportes">Desde ' + mesTexto(sa[0].mes) + ' aportaste <b>' + pesos(u.acumuladoReal) + '</b> y tu plan sumaba <b>' + pesos(u.acumuladoPlan) + '</b>: ' +
      (dif >= 0 ? 'vas ' + pesos(dif) + ' por encima del plan.' : 'vas ' + pesos(-dif) + ' por debajo del plan.') + (u.enCurso ? ' El mes actual todavía está en curso.' : '') + '</p>';
    h += G.tabla(['Mes', 'Aporte real', 'Plan'], sa.map(x => [G.mesLargo(x.mes), pesos2(x.real), pesos2(x.plan)]));
  }
  h += explicacion('¿Qué cuenta como aporte?', 'Depósitos y aguinaldos suman; retiros restan. Los rendimientos y comisiones no se cuentan acá porque no son ahorro tuyo sino resultado de dónde está el dinero (sí se suman al capital real).');
  h += '</section>';

  // 3. Progreso hacia el precio
  const sp = C.serieProgreso(estado, cfg.plazoPrincipal, hoy);
  const idxHoy = sp.findIndex(x => x.mes === mesHoy);
  const hayReserva = (cfg.reservaEmergencia || 0) > 0;
  const series = [
    { nombre: 'Capital real', valores: sp.map(x => x.real), color: G.COLOR.real, punto: true },
    { nombre: 'Capital estimado con tu plan', valores: sp.map(x => x.proyectado), color: G.COLOR.proyectado, discontinua: true, punto: false },
    { nombre: 'Precio de la Kangoo', valores: sp.map(x => x.precio), color: G.COLOR.precio, escalon: true, punto: false, notaEn: i => sp[i].precioSupuesto ? 'supuesto: sin cambios' : '' }
  ];
  if (hayReserva) series.push({ nombre: 'Precio + reserva', valores: sp.map(x => x.necesario), color: G.COLOR.plan, discontinua: true, escalon: true, punto: false });
  h += '<section class="card"><h3>Progreso hacia el precio</h3>' + chipsPlazo() + '<p class="sub">Hasta ' + mesTexto(C.sumarMeses(cfg.fechaInicio, cfg.plazoPrincipal)) + '. Después de "hoy" todo es estimado y el precio se supone constante.</p><div class="graf">';
  h += G.lineas({ id: 'gProgreso', titulo: 'Progreso hacia el precio de la Kangoo', meses: sp.map(x => x.mes), series, indiceHoy: idxHoy });
  h += '</div>' + G.leyenda([{ nombre: 'Capital real', color: G.COLOR.real, etiqueta: 'REAL' }, { nombre: 'Estimado con tu plan', color: G.COLOR.proyectado, discontinua: true, etiqueta: 'ESTIMADO' },
    { nombre: 'Precio de la Kangoo', color: G.COLOR.precio }].concat(hayReserva ? [{ nombre: 'Precio + reserva', color: G.COLOR.plan, discontinua: true }] : []));
  if (!C.precioVigente(estado.precios)) h += '<p class="msg neutro">Cargá un precio en Metas para ver la línea naranja.</p>';
  h += G.tabla(['Mes', 'Real', 'Estimado', 'Precio'], sp.map(x => [G.mesLargo(x.mes), x.real === null ? '—' : pesos2(x.real), x.proyectado === null ? '—' : pesos2(x.proyectado), x.precio === null ? '—' : pesos2(x.precio) + (x.precioSupuesto ? ' (supuesto)' : '')]));
  h += explicacion('¿Cómo se lee?', 'Cuando la línea azul llega a la naranja (o a la gris, si tenés reserva), tu capital alcanzaría el precio. Si en la vida real el precio sube, la línea naranja también sube y el cruce se aleja.');
  h += '</section>';

  // 4. Comparación de metas
  const cm = C.comparacionMetas(estado, cfg.plazos, hoy);
  const nec = C.necesarioPara(estado);
  h += '<section class="card"><h3>Comparación de plazos ' + etiqueta('ESTIMADO') + '</h3><p class="sub">Cuánto podrías tener al final de cada plazo. El tuyo está remarcado.</p><div class="graf">';
  h += G.barras({ id: 'gMetas', titulo: 'Comparación de metas según el plazo', categorias: cm.map(x => x.plazoMeses + ' m'),
    titulos: cm.map(x => x.plazoMeses + ' meses (' + G.mesLargo(x.mesObjetivo) + ')'),
    barras: [{ nombre: 'Capital real hoy', valores: cm.map(x => x.capitalReal), color: G.COLOR.real }, { nombre: 'Ahorro estimado', valores: cm.map(x => C.r2(x.total - x.capitalReal)), color: G.COLOR.real, clara: true }],
    referencia: nec !== null ? { nombre: 'Necesitás (precio + reserva)', valor: nec, color: G.COLOR.precio } : null,
    seleccion: cm.findIndex(x => x.plazoMeses === cfg.plazoPrincipal),
    extras: i => cm[i].diferencia === null ? [] : [{ nombre: cm[i].diferencia < 0 ? 'faltarían' : 'sobrarían', valor: Math.abs(cm[i].diferencia), color: '#ffffff' }] });
  h += '</div>' + G.leyenda([{ nombre: 'Capital real hoy', color: G.COLOR.real, forma: 'barra', etiqueta: 'REAL' }, { nombre: 'Ahorro estimado', color: G.COLOR.real, forma: 'barra', clara: true, etiqueta: 'ESTIMADO' }]
    .concat(nec !== null ? [{ nombre: 'Necesitás (precio + reserva)', color: G.COLOR.precio, discontinua: true }] : []));
  h += G.tabla(['Plazo', 'Podrías tener', 'Diferencia'], cm.map(x => [x.plazoMeses + ' meses (' + G.mesLargo(x.mesObjetivo) + ')', pesos2(x.total), x.diferencia === null ? '—' : (x.diferencia < 0 ? 'faltarían ' : 'sobrarían ') + pesos2(Math.abs(x.diferencia))]));
  h += explicacion('¿Conviene el plazo más largo?', 'Un plazo más largo junta más dinero, pero también da más tiempo a que la Kangoo aumente. Por eso conviene volver a cargar el precio seguido y comparar.');
  h += '</section>';
  main.innerHTML = h;
  activarChips(main);
  G.activar(main);
}

/* ---------- Mis ahorros ---------- */
let borrador = null;

function opcionesCuenta(sel) {
  return estado.config.cuentas.map(c => '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '<option value="__otra">Otra cuenta…</option>';
}

function renderAhorros(main) {
  const movs = estado.movimientos;
  const { porId, efectiva, sinEfecto } = C.analizarAnulaciones(movs);
  const imp = C.importes(movs);
  const saldos = C.saldoPorCuenta(movs);
  const b = borrador || { tipo: 'deposito', fecha: hoyISO(), monto: '', cuenta: estado.config.cuentas[0], obs: '' };

  let h = '<div class="card"><h3>Nuevo movimiento</h3><form id="fMov" autocomplete="off">';
  h += '<label>Tipo<select name="tipo">' + Object.keys(C.TIPOS).filter(k => k !== 'anulacion').map(k => '<option value="' + k + '"' + (k === b.tipo ? ' selected' : '') + '>' + C.TIPOS[k].label + '</option>').join('') + '</select></label>';
  h += '<label>Fecha<input type="date" name="fecha" required max="' + hoyISO() + '" value="' + esc(b.fecha) + '"></label>';
  h += '<label>Monto en pesos<input name="monto" inputmode="decimal" required placeholder="Ej: 400.000" value="' + esc(b.monto) + '"></label>';
  h += '<label>¿Dónde está el dinero?<select name="cuenta">' + opcionesCuenta(b.cuenta) + '</select></label>';
  h += '<label id="lOtra" hidden>Nombre de la cuenta nueva<input name="otra" maxlength="60" placeholder="Ej: Plazo fijo Banco X"></label>';
  h += '<label>Observaciones (opcional)<input name="obs" maxlength="500" value="' + esc(b.obs) + '"></label>';
  h += '<p class="sub">No anotes claves, números de tarjeta ni datos bancarios.</p>';
  h += '<button class="btn primario" type="submit">Guardar movimiento</button>';
  if (borrador) h += '<button class="btn" type="button" id="bLimpiar">Limpiar formulario</button>';
  h += '</form></div>';

  const cuentas = Object.keys(saldos);
  if (cuentas.length) {
    h += '<div class="card"><h3>Saldo por cuenta</h3>' + cuentas.map(c => '<div class="fila"><span>' + esc(c) + '</span><b>' + pesos2(saldos[c]) + '</b></div>').join('');
    h += '<div class="fila total"><span>Capital real</span><b id="capitalAhorros">' + pesos2(C.capitalReal(movs)) + '</b></div></div>';
  }

  h += '<div class="card"><h3>Movimientos (<span id="cantMov">' + movs.length + '</span>)</h3>';
  if (!movs.length) h += '<p>Todavía no hay movimientos. Tu capital real es $0.</p>';
  movs.slice().sort((a, b) => (b.fecha + b.registrado).localeCompare(a.fecha + a.registrado)).forEach(m => {
    const v = imp.get(m.id);
    const anulado = efectiva.has(m.id);
    h += '<div class="mov' + (anulado ? ' anulado' : '') + (m.tipo === 'anulacion' ? ' es-anul' : '') + '" data-id="' + esc(m.id) + '">';
    h += '<div class="mov-top"><span>' + fechaTexto(m.fecha) + ' · ' + esc((C.TIPOS[m.tipo] || { label: m.tipo }).label) + '</span><b class="' + (v >= 0 ? 'pos' : 'neg') + '">' + (v >= 0 ? '+ ' : '− ') + pesos2(Math.abs(v)) + '</b></div>';
    h += '<div class="sub">' + esc(m.cuenta) + (m.obs ? ' · ' + esc(m.obs) : '') + '</div>';
    if (m.tipo === 'anulacion') { const o = porId[m.anulaA]; h += '<div class="sub">Anula: ' + (o ? fechaTexto(o.fecha) + ' ' + esc((C.TIPOS[o.tipo] || { label: o.tipo }).label) + ' ' + pesos2(o.monto) : 'movimiento no encontrado') + '</div>'; }
    if (sinEfecto.has(m.id)) h += '<div class="sub"><b>CORRECCIÓN REPETIDA: sin efecto</b> (no se suma ni se resta)</div>';
    if (anulado) h += '<div class="sub"><b>ANULADO</b> (queda en el historial)</div>';
    else if (m.tipo !== 'anulacion') h += '<button class="btn chico" type="button" data-corregir="' + esc(m.id) + '">Corregir</button>';
    h += '</div>';
  });
  h += '</div>';
  main.innerHTML = h;

  const f = $('#fMov');
  f.cuenta.addEventListener('change', () => { $('#lOtra').hidden = f.cuenta.value !== '__otra'; });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    if (ocupado) return;
    const monto = C.parsearMonto(f.monto.value);
    if (!(monto > 0)) return aviso('Revisá el monto. Escribilo así: 400.000 o 400000 (decimales con coma).', true);
    if (!C.esFechaValida(f.fecha.value) || f.fecha.value > hoyISO()) return aviso('Revisá la fecha: no puede ser futura, solo se registra dinero real.', true);
    let cuenta = f.cuenta.value;
    if (cuenta === '__otra') {
      cuenta = f.otra.value.trim().replace(/\s+/g, ' ');
      if (!cuenta) return aviso('Escribí el nombre de la cuenta nueva.', true);
    }
    const tipo = f.tipo.value;
    if (!C.TIPOS[tipo] || tipo === 'anulacion') return aviso('Tipo de movimiento inválido.', true);
    if (C.TIPOS[tipo].signo < 0) {
      const saldo = C.saldoPorCuenta(estado.movimientos)[cuenta] || 0;
      if (monto > saldo && !confirm('Este ' + C.TIPOS[tipo].label.toLowerCase() + ' deja "' + cuenta + '" en negativo (saldo actual ' + pesos2(saldo) + '). ¿Guardarlo igual?')) return;
    }
    const mov = { id: nuevoId(), fecha: f.fecha.value, tipo, monto, cuenta, obs: f.obs.value.trim(), registrado: ahoraISO(), anulaA: null };
    const ok = await aplicarCambio(n => {
      if (!n.config.cuentas.includes(cuenta)) n.config.cuentas.push(cuenta);
      n.movimientos.push(mov); return n;
    });
    if (!ok) return;
    borrador = null;
    aviso(C.TIPOS[tipo].label + ' de ' + pesos2(monto) + ' guardado.');
    render();
  });
  const bl = $('#bLimpiar');
  if (bl) bl.addEventListener('click', () => { borrador = null; render(); });
  main.querySelectorAll('[data-corregir]').forEach(btn => btn.addEventListener('click', () => { btn.disabled = true; corregir(btn.dataset.corregir).finally(() => { btn.disabled = false; }); }));
}

async function corregir(id) {
  if (ocupado) { aviso('Esperá: se está guardando el cambio anterior.', true); return false; }
  const chequeo = C.puedeAnular(estado.movimientos, id);
  if (!chequeo.ok) { aviso(chequeo.motivo, true); render(); return false; }
  const o = estado.movimientos.find(m => m.id === id);
  if (!confirm('Vas a anular este movimiento:\n' + fechaTexto(o.fecha) + ' · ' + C.TIPOS[o.tipo].label + ' · ' + pesos2(o.monto) + '\n\nNo se borra: se agrega una corrección que lo compensa y queda en el historial. Después podés cargar el dato correcto.\n\n¿Continuar?')) return false;
  const motivo = (prompt('Motivo de la corrección (opcional):', '') || '').trim().slice(0, 400);
  const fecha = hoyISO() >= o.fecha ? hoyISO() : o.fecha;
  const ok = await aplicarCambio(n => {
    const c2 = C.puedeAnular(n.movimientos, id);
    if (!c2.ok) throw new ErrorValidacion(c2.motivo);
    n.movimientos.push({ id: nuevoId(), fecha, tipo: 'anulacion', monto: o.monto, cuenta: o.cuenta, obs: motivo ? 'Corrección: ' + motivo : 'Corrección', registrado: ahoraISO(), anulaA: o.id });
    return n;
  });
  if (!ok) { render(); return false; }
  borrador = { tipo: o.tipo, fecha: o.fecha, monto: String(o.monto).replace('.', ','), cuenta: o.cuenta, obs: o.obs };
  aviso('Movimiento anulado. Revisá el formulario y cargá el dato correcto.');
  render();
  window.scrollTo(0, 0);
  return true;
}

/* ---------- Metas ---------- */
function renderMetas(main) {
  const c = estado.config;
  const hoy = new Date();
  const mesHoy = C.mesClave(hoy);
  const plan = C.planVigente(c, mesHoy);
  const opciones = [...new Set(C.PLAZOS_SUGERIDOS.concat(c.plazos))].sort((a, b) => a - b);

  // Plazos
  let h = '<form id="fPlazos" class="card" autocomplete="off" novalidate><h3>Plazo de tu meta</h3>';
  h += '<p class="sub">Elegí el plazo principal y cuáles querés comparar. El plazo se cuenta desde el inicio del plan (' + mesTexto(c.fechaInicio) + ').</p>';
  h += '<fieldset><legend>Plazo principal</legend><div class="chips">' + opciones.map(p => '<label class="chip-radio"><input type="radio" name="principal" value="' + p + '"' + (p === c.plazoPrincipal ? ' checked' : '') + '><span>' + p + ' meses</span></label>').join('') + '</div></fieldset>';
  h += '<fieldset><legend>Plazos para comparar</legend><div class="chips">' + opciones.map(p => '<label class="chip-radio"><input type="checkbox" name="comparar" value="' + p + '"' + (c.plazos.includes(p) ? ' checked' : '') + '><span>' + p + ' meses</span></label>').join('') + '</div></fieldset>';
  h += '<label>Otro plazo (meses, de 1 a ' + C.MAX_PLAZO + ')<input type="number" name="otro" min="1" max="' + C.MAX_PLAZO + '" step="1" inputmode="numeric" placeholder="Ej: 30"></label>';
  h += '<label class="check"><input type="checkbox" name="otroPrincipal" checked> Usarlo como plazo principal</label>';
  h += '<button class="btn primario" type="submit">Guardar plazos</button></form>';

  // Plan de ahorro con historial
  h += '<form id="fPlan" class="card" autocomplete="off"><h3>Tu plan de ahorro</h3>';
  h += '<p>Hoy rige: <b>' + pesos(plan.ahorroMensual) + '</b> por mes y <b>' + pesos(plan.aguinaldo) + '</b> de aguinaldo (desde ' + mesTexto(plan.desde) + ').</p>';
  h += '<label>Ahorro mensual planeado<input name="ahorroMensual" inputmode="decimal" value="' + montoInput(plan.ahorroMensual) + '" placeholder="0"></label>';
  h += '<label>Aguinaldo estimado (cada vez que cobrás)<input name="aguinaldo" inputmode="decimal" value="' + montoInput(plan.aguinaldo) + '" placeholder="0"></label>';
  h += '<label>¿Desde qué mes rige este cambio?<input type="month" name="desde" required value="' + mesHoy + '" min="' + esc(c.fechaInicio) + '"></label>';
  h += '<p class="sub">Los meses anteriores conservan el plan que tenían, así la comparación "real frente al plan" sigue siendo justa. Son supuestos: no se suman a tu capital real.</p>';
  h += '<button class="btn primario" type="submit">Guardar plan</button>';
  const hist = c.planHistorial.slice().sort((a, b) => (b.desde + b.registrado).localeCompare(a.desde + a.registrado));
  h += '<details class="explica"><summary>Historial del plan (' + hist.length + ')</summary><ul id="histPlan">' + hist.map(p => '<li>Desde ' + mesTexto(p.desde) + ': ' + pesos(p.ahorroMensual) + ' por mes, aguinaldo ' + pesos(p.aguinaldo) + ' <span class="sub">(cargado ' + fechaHoraTexto(p.registrado) + ')</span></li>').join('') + '</ul></details>';
  h += '</form>';

  // Precio de la Kangoo con historial
  const hp = C.historialPrecios(estado.precios);
  const { anulados } = C.analizarPrecios(estado.precios);
  const vig = C.precioVigente(estado.precios);
  h += '<form id="fPrecio" class="card" autocomplete="off"><h3>Precio de la Kangoo</h3>';
  h += vig ? '<p>Precio en uso: <b>' + pesos(vig.precio) + '</b> ' + etiqueta(C.estadoDePrecio(vig, hoy)) + ' (' + (vig.fecha ? fechaTexto(vig.fecha) : 'fecha desconocida') + ').</p>' : '<p>Todavía no cargaste un precio.</p>';
  h += '<p class="sub">Cargá solo precios que viste en una fuente real (Renault Argentina, una concesionaria o una publicación). En usados es un precio pedido, no el precio final. Cada precio nuevo se agrega al historial; el anterior no se borra.</p>';
  h += '<label>Precio<input name="precio" inputmode="decimal" required placeholder="Ej: 25.000.000"></label>';
  h += '<label>¿Qué vehículo es?<input name="descripcion" maxlength="120" value="' + esc(vig ? vig.descripcion : '') + '" placeholder="Ej: Kangoo Stepway 2021, 60.000 km"></label>';
  h += '<label>Fuente o enlace<input name="fuente" maxlength="300" placeholder="Ej: renault.com.ar o enlace de la publicación"></label>';
  h += '<label>Fecha de consulta<input type="date" name="fecha" required max="' + hoyISO() + '" value="' + hoyISO() + '"></label>';
  h += '<label>Estado del dato<select name="estado">' + C.ESTADOS_PRECIO.map(e => '<option' + (e === 'SIN VERIFICAR' ? ' selected' : '') + '>' + e + '</option>').join('') + '</select></label>';
  h += '<p class="sub">VERIFICADO: viste la fuente con fecha. ESTIMADO: lo calculaste. SIN VERIFICAR: te lo dijeron o no estás seguro. Pasados ' + C.DIAS_DESACTUALIZADO + ' días se marca DESACTUALIZADO.</p>';
  h += '<button class="btn primario" type="submit">Agregar precio</button>';
  h += '<h3 class="mt">Historial de precios (<span id="cantPrecios">' + hp.length + '</span>)</h3>';
  if (!estado.precios.length) h += '<p class="sub">Sin precios cargados.</p>';
  estado.precios.filter(p => p.tipo === 'precio').slice().sort((a, b) => ((b.fecha || '') + b.registrado).localeCompare((a.fecha || '') + a.registrado)).forEach(p => {
    const an = anulados.has(p.id);
    h += '<div class="mov' + (an ? ' anulado' : '') + '"><div class="mov-top"><span>' + (p.fecha ? fechaTexto(p.fecha) : 'fecha desconocida') + ' ' + (an ? '' : etiqueta(C.estadoDePrecio(p, hoy))) + '</span><b>' + pesos(p.precio) + '</b></div>';
    h += '<div class="sub">' + esc(p.descripcion || 'sin descripción') + (p.fuente ? ' · ' + esc(p.fuente) : '') + '</div>';
    if (an) { const a = estado.precios.find(x => x.anulaA === p.id); h += '<div class="sub"><b>ANULADO</b>' + (a && a.motivo ? ': ' + esc(a.motivo) : '') + ' (queda en el historial)</div>'; }
    else h += '<button class="btn chico" type="button" data-anular-precio="' + esc(p.id) + '">Anular (error de carga)</button>';
    h += '</div>';
  });
  h += '</form>';

  // Otros datos
  h += '<form id="fCfg" class="card" autocomplete="off"><h3>Otros datos del plan</h3>';
  h += '<fieldset><legend>Meses en que cobrás aguinaldo</legend><label class="check"><input type="checkbox" name="ag6"' + (c.aguinaldoMeses.includes(6) ? ' checked' : '') + '> Junio</label><label class="check"><input type="checkbox" name="ag12"' + (c.aguinaldoMeses.includes(12) ? ' checked' : '') + '> Diciembre</label></fieldset>';
  h += '<label>Mes de inicio del plan<input type="month" name="fechaInicio" required value="' + esc(c.fechaInicio) + '"></label>';
  h += '<label>Reserva de emergencia (no se usa para el auto)<input name="reservaEmergencia" inputmode="decimal" value="' + montoInput(c.reservaEmergencia) + '" placeholder="0"></label>';
  h += explicacion('¿Para qué sirve la reserva?', 'Es dinero que no tocás para el auto: cubre imprevistos (salud, trabajo, arreglos). Si comprás usando la reserva, cualquier imprevisto te obliga a endeudarte.');
  h += '<label>Tus cuentas (una por línea)<textarea name="cuentas" rows="4">' + esc(c.cuentas.join('\n')) + '</textarea></label>';
  h += '<p class="sub">Solo un nombre, por ejemplo "Mercado Pago" o "Plazo fijo". Nunca claves ni números de cuenta. Las cuentas que ya tienen movimientos no se pueden quitar.</p>';
  h += '<button class="btn primario" type="submit">Guardar</button></form>';
  main.innerHTML = h;

  $('#fPlazos').addEventListener('submit', async e => {
    e.preventDefault(); if (ocupado) return;
    const f = e.target;
    let principal = Number((f.querySelector('input[name=principal]:checked') || {}).value);
    const comparar = [...f.querySelectorAll('input[name=comparar]:checked')].map(x => Number(x.value));
    const otroTxt = f.otro.value.trim();
    if (otroTxt) {
      const otro = Number(otroTxt);
      if (!C.esPlazoValido(otro)) return aviso('El otro plazo debe ser un número entero de meses entre 1 y ' + C.MAX_PLAZO + '.', true);
      comparar.push(otro);
      if (f.otroPrincipal.checked) principal = otro;
    }
    if (!C.esPlazoValido(principal)) return aviso('Elegí un plazo principal.', true);
    const plazos = [...new Set(comparar.concat([principal]))].sort((a, b) => a - b);
    if (plazos.length > C.MAX_PLAZOS) return aviso('Podés comparar hasta ' + C.MAX_PLAZOS + ' plazos.', true);
    if (await aplicarCambio(n => { n.config.plazos = plazos; n.config.plazoPrincipal = principal; return n; })) { aviso('Plazos guardados.'); render(); }
  });

  $('#fPlan').addEventListener('submit', async e => {
    e.preventDefault(); if (ocupado) return;
    const f = e.target;
    const leer = (txt, nombre) => { if (!txt.trim()) return 0; const v = C.parsearMonto(txt); if (!(v >= 0)) throw new Error('Revisá: ' + nombre); return v; };
    let ahorroMensual, aguinaldo;
    try { ahorroMensual = leer(f.ahorroMensual.value, 'ahorro mensual'); aguinaldo = leer(f.aguinaldo.value, 'aguinaldo'); } catch (err) { return aviso(err.message, true); }
    const desde = f.desde.value;
    if (!C.esMesValido(desde)) return aviso('Revisá el mes desde el que rige.', true);
    if (desde < c.fechaInicio) return aviso('El cambio no puede regir antes del inicio del plan (' + mesTexto(c.fechaInicio) + ').', true);
    const actual = C.planVigente(c, desde);
    if (actual.ahorroMensual === ahorroMensual && actual.aguinaldo === aguinaldo) return aviso('No hay cambios: ese plan ya rige desde ' + mesTexto(actual.desde) + '.');
    if (await aplicarCambio(n => { n.config.planHistorial.push({ id: nuevoId(), desde, ahorroMensual, aguinaldo, registrado: ahoraISO() }); return n; })) {
      aviso('Plan guardado desde ' + mesTexto(desde) + '.'); render();
    }
  });

  $('#fPrecio').addEventListener('submit', async e => {
    e.preventDefault(); if (ocupado) return;
    const f = e.target;
    const precio = C.parsearMonto(f.precio.value);
    if (!(precio > 0)) return aviso('Revisá el precio. Escribilo así: 25.000.000', true);
    if (!C.esFechaValida(f.fecha.value) || f.fecha.value > hoyISO()) return aviso('Indicá la fecha en que consultaste el precio (no puede ser futura).', true);
    const fuente = f.fuente.value.trim(), descripcion = f.descripcion.value.trim(), est = f.estado.value;
    if (est === 'VERIFICADO' && !fuente) return aviso('Para marcarlo VERIFICADO indicá la fuente.', true);
    if (await aplicarCambio(n => { n.precios.push({ id: nuevoId(), tipo: 'precio', fecha: f.fecha.value, precio, descripcion, fuente, estado: est, registrado: ahoraISO(), anulaA: null }); return n; })) {
      aviso('Precio agregado al historial.'); render();
    }
  });
  main.querySelectorAll('[data-anular-precio]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.anularPrecio;
    const ch = C.puedeAnularPrecio(estado.precios, id);
    if (!ch.ok) return aviso(ch.motivo, true);
    const p = estado.precios.find(x => x.id === id);
    if (!confirm('¿Anular el precio de ' + pesos(p.precio) + ' del ' + (p.fecha ? fechaTexto(p.fecha) : 'fecha desconocida') + '?\n\nÚsalo solo si fue un error de carga. Si el precio cambió, agregá uno nuevo: así se conserva la historia.')) return;
    const motivo = (prompt('Motivo (opcional):', '') || '').trim().slice(0, 300);
    btn.disabled = true;
    const ok = await aplicarCambio(n => {
      const c2 = C.puedeAnularPrecio(n.precios, id);
      if (!c2.ok) throw new ErrorValidacion(c2.motivo);
      n.precios.push({ id: nuevoId(), tipo: 'anulacion', anulaA: id, fecha: hoyISO(), motivo, registrado: ahoraISO() });
      return n;
    });
    btn.disabled = false;
    if (ok) { aviso('Precio anulado (queda en el historial).'); render(); }
  }));

  $('#fCfg').addEventListener('submit', async e => {
    e.preventDefault(); if (ocupado) return;
    const f = e.target;
    let reserva;
    const txt = f.reservaEmergencia.value.trim();
    if (!txt) reserva = 0; else { reserva = C.parsearMonto(txt); if (!(reserva >= 0)) return aviso('Revisá la reserva de emergencia.', true); }
    const fechaInicio = f.fechaInicio.value;
    if (!C.esMesValido(fechaInicio)) return aviso('Revisá el mes de inicio.', true);
    const cuentas = [...new Set(f.cuentas.value.split('\n').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean))];
    if (cuentas.some(x => x.length > 60)) return aviso('Cada nombre de cuenta puede tener hasta 60 caracteres.', true);
    estado.movimientos.forEach(mv => { if (!cuentas.includes(mv.cuenta)) cuentas.push(mv.cuenta); });
    if (!cuentas.length) cuentas.push('Caja de ahorro');
    const aguinaldoMeses = [f.ag6.checked && 6, f.ag12.checked && 12].filter(Boolean);
    const ok = await aplicarCambio(n => {
      n.config.aguinaldoMeses = aguinaldoMeses; n.config.reservaEmergencia = reserva; n.config.cuentas = cuentas;
      if (fechaInicio !== n.config.fechaInicio) {
        // el plan más antiguo pasa a regir desde el nuevo inicio si este es anterior
        n.config.fechaInicio = fechaInicio;
        const primero = n.config.planHistorial.slice().sort((a, b) => a.desde.localeCompare(b.desde))[0];
        if (primero && fechaInicio < primero.desde) n.config.planHistorial.push({ id: nuevoId(), desde: fechaInicio, ahorroMensual: primero.ahorroMensual, aguinaldo: primero.aguinaldo, registrado: ahoraISO() });
      }
      return n;
    });
    if (ok) { aviso('Cambios guardados.'); render(); }
  });
}

/* ---------- Respaldo ---------- */
function descargar(nombre, contenido, tipo) {
  const blob = new Blob([contenido], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const sello = () => { const d = new Date(); return hoyISO() + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0'); };
function textoRespaldo() {
  const r = C.resumen(estado.movimientos); r.cantidadPrecios = estado.precios.length;
  return JSON.stringify({ app: 'mi-kangoo-finanzas', version: APP_VERSION, esquema: C.ESQUEMA_ACTUAL, exportado: ahoraISO(), resumen: r, datos: estado }, null, 2);
}
async function marcarRespaldo() { await aplicarCambio(n => { n.ultimoRespaldo = ahoraISO(); return n; }); }

async function renderRespaldo(main) {
  let previo = null, premig = null;
  try { previo = await dbLeer(K_PREVIO); } catch (e) { /* nada */ }
  try { premig = await dbLeer(K_PREMIG); } catch (e) { /* nada */ }
  let persist = 'no disponible en este navegador';
  try { if (navigator.storage && navigator.storage.persisted) persist = (await navigator.storage.persisted()) ? 'sí (el navegador no lo borra solo)' : 'no confirmado (hacé copias seguido)'; } catch (e) { /* nada */ }
  if (pantallaActual() !== 'respaldo') return;

  let h = '<div class="card"><h3>¿Dónde están tus datos?</h3>';
  h += '<p>Solo en <b>este dispositivo y este navegador</b> (' + (usaLocalStorage ? 'localStorage' : 'IndexedDB') + '). No se envían a ningún servidor y <b>no hay sincronización</b> entre tu celular y tu computadora.</p>';
  h += '<p class="sub">Almacenamiento persistente: ' + esc(persist) + '. Si borrás los datos del navegador o desinstalás la app, se pierden. Por eso: copia de seguridad.</p>';
  h += '<p class="sub">Última copia generada: ' + fechaHoraTexto(estado.ultimoRespaldo) + ' · Movimientos: ' + estado.movimientos.length + ' · Precios: ' + estado.precios.length + '</p></div>';

  h += '<div class="card"><h3>Exportar</h3>';
  h += '<button class="btn primario" type="button" id="bExp">Descargar copia de seguridad</button>';
  if (navigator.canShare) h += '<button class="btn" type="button" id="bShare">Enviar copia (Drive, mail, WhatsApp…)</button>';
  h += '<button class="btn" type="button" id="bCsv">Descargar movimientos para Excel (CSV)</button>';
  h += '<button class="btn" type="button" id="bCsvPrecios">Descargar historial de precios (CSV)</button>';
  h += '<p class="sub">La copia (.json) sirve para restaurar o pasar tus datos a otro dispositivo. Incluye un resumen de control para detectar archivos dañados o modificados. Los CSV son solo para mirar en Excel; no sirven para restaurar.</p></div>';

  h += '<div class="card"><h3>Restaurar una copia</h3>';
  h += '<label class="btn" for="fileImp">Elegir archivo de copia (.json)</label><input type="file" id="fileImp" accept=".json,application/json" hidden>';
  h += '<p class="sub">Acepta copias de esta versión y de las versiones 1.0.x (se convierten sin cambiar tus movimientos).</p>';
  h += '<div id="impPrev"></div>';
  if (previo) h += '<p class="sub">Antes de la última restauración guardamos tus datos anteriores (' + fechaHoraTexto(previo.guardado) + ').</p><button class="btn" type="button" id="bDeshacer">Deshacer última restauración</button>';
  h += '</div>';
  if (premig) {
    h += '<div class="card"><h3>Datos de antes de la actualización</h3><p class="sub">Al pasar a la versión 1.1 (' + fechaHoraTexto(premig.guardado) + ') guardamos una copia intacta de tus datos anteriores (' + (premig.datos && Array.isArray(premig.datos.movimientos) ? premig.datos.movimientos.length : '?') + ' movimientos). No la necesitás si todo se ve bien.</p>';
    h += '<button class="btn" type="button" id="bPremig">Descargar esa copia</button></div>';
  }
  h += '<p class="sub centro">Mi Kangoo Finanzas v' + esc(APP_VERSION) + ' · Etapa 1</p>';
  main.innerHTML = h;

  $('#bExp').addEventListener('click', async () => {
    descargar('mi-kangoo-respaldo_' + sello() + '.json', textoRespaldo(), 'application/json');
    await marcarRespaldo();
    aviso('Copia generada. Verificá que esté en Descargas y guardala también fuera del teléfono.'); render();
  });
  const bs = $('#bShare');
  if (bs) bs.addEventListener('click', async () => {
    try {
      const file = new File([textoRespaldo()], 'mi-kangoo-respaldo_' + sello() + '.json', { type: 'application/json' });
      if (!navigator.canShare({ files: [file] })) return aviso('Tu navegador no permite enviar archivos. Usá "Descargar".', true);
      await navigator.share({ files: [file], title: 'Copia Mi Kangoo Finanzas' });
      await marcarRespaldo(); render();
    } catch (e) { if (e.name !== 'AbortError') aviso('No se pudo enviar. Usá "Descargar".', true); }
  });
  $('#bCsv').addEventListener('click', () => { descargar('mi-kangoo-movimientos_' + sello() + '.csv', C.generarCSV(estado.movimientos), 'text/csv;charset=utf-8'); aviso('CSV generado.'); });
  $('#bCsvPrecios').addEventListener('click', () => { descargar('mi-kangoo-precios_' + sello() + '.csv', C.generarCSVPrecios(estado.precios), 'text/csv;charset=utf-8'); aviso('CSV generado.'); });
  const bp = $('#bPremig');
  if (bp) bp.addEventListener('click', () => {
    const d = premig.datos;
    const r = Array.isArray(d.movimientos) ? C.resumen(d.movimientos) : undefined;
    descargar('mi-kangoo-antes-de-1.1_' + sello() + '.json', JSON.stringify({ app: 'mi-kangoo-finanzas', version: 'anterior a 1.1', esquema: 1, exportado: ahoraISO(), resumen: r, datos: d }, null, 2), 'application/json');
  });

  $('#fileImp').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    const box = $('#impPrev');
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { box.innerHTML = '<p class="msg malo" id="impError">No se puede restaurar: el archivo es demasiado grande. Tus datos no cambiaron.</p>'; return; }
    let obj;
    try { obj = JSON.parse(await file.text()); } catch (err) { box.innerHTML = '<p class="msg malo" id="impError">No se puede restaurar: el archivo no se puede leer (no es un JSON válido). Tus datos no cambiaron.</p>'; return; }
    const v = C.validarRespaldo(obj, hoyISO());
    if (v.errores.length) {
      box.innerHTML = '<p class="msg malo" id="impError">No se puede restaurar esta copia. Tus datos no cambiaron.</p><ul>' + v.errores.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' + (v.totalErrores > v.errores.length ? '<p class="sub">…y ' + (v.totalErrores - v.errores.length) + ' problema(s) más.</p>' : '');
      return;
    }
    const candidato = C.cargarEstado(obj.datos, ahoraISO()).estado;
    const cap = C.capitalReal(candidato.movimientos);
    box.innerHTML = '<div class="mov"><p><b>Copia del ' + fechaHoraTexto(obj.exportado) + '</b></p><p>' + candidato.movimientos.length + ' movimientos · capital real ' + pesos2(cap) + ' · ' + candidato.precios.length + ' precios</p>' +
      (v.advertencias.length ? '<ul>' + v.advertencias.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
      '<p class="msg malo">Esto reemplaza TODOS tus datos actuales (' + estado.movimientos.length + ' movimientos, capital ' + pesos2(C.capitalReal(estado.movimientos)) + '). Tus datos actuales se guardan para poder deshacer.</p>' +
      '<button class="btn primario" type="button" id="bConfImp">Sí, restaurar esta copia</button><button class="btn" type="button" id="bCancImp">Cancelar</button></div>';
    $('#bCancImp').addEventListener('click', () => { box.innerHTML = ''; });
    $('#bConfImp').addEventListener('click', async ev => {
      ev.target.disabled = true;
      const anterior = clonar(estado);
      const ok = await aplicarCambio(() => clonar(candidato), { modo: 'reemplazo', extra: () => ({ k: K_PREVIO, v: { guardado: ahoraISO(), datos: anterior } }) });
      if (!ok) { ev.target.disabled = false; box.insertAdjacentHTML('afterbegin', '<p class="msg malo" id="impFallo">No se restauró nada. Tus datos actuales siguen igual.</p>'); return; }
      aviso('Copia restaurada y verificada.');
      if (location.hash === '#inicio') render(); else location.hash = '#inicio';
    });
  });
  const bd = $('#bDeshacer');
  if (bd) bd.addEventListener('click', async () => {
    if (!confirm('¿Volver a los datos que tenías antes de la última restauración?')) return;
    let p;
    try { p = await dbLeer(K_PREVIO); } catch (e) { return aviso('No se pudo leer la copia anterior.', true); }
    if (!p || !p.datos) return aviso('No hay datos anteriores guardados.', true);
    let anteriores;
    try { anteriores = C.cargarEstado(clonar(p.datos), ahoraISO()).estado; } catch (e) { return aviso('La copia anterior no se puede leer.', true); }
    const actual = clonar(estado);
    const ok = await aplicarCambio(() => anteriores, { modo: 'cambio', extra: () => ({ k: K_PREVIO, v: { guardado: ahoraISO(), datos: actual } }) });
    if (!ok) return;
    aviso('Restauración deshecha.');
    render();
  });
}

/* ---------- Arranque y migración ---------- */
function pantallaError(msg, crudo) {
  $('#main').innerHTML = '<div class="card"><p class="msg malo">' + esc(msg) + '</p>' + (crudo ? '<button class="btn" type="button" id="bCrudo">Descargar mis datos tal como están</button>' : '') + '</div>';
  if (crudo) $('#bCrudo').addEventListener('click', () => descargar('mi-kangoo-datos-sin-convertir_' + sello() + '.json', JSON.stringify({ app: 'mi-kangoo-finanzas', version: 'sin convertir', esquema: crudo.esquema, exportado: ahoraISO(), datos: crudo }, null, 2), 'application/json'));
}

async function migrarSiHaceFalta(guardado) {
  const r = C.cargarEstado(guardado, ahoraISO());
  if (!r.migrado) return r.estado;
  // Comprobaciones antes de escribir: mismos movimientos y mismo capital.
  const mismos = JSON.stringify(r.estado.movimientos) === JSON.stringify(C.limpiarEstadoV1(guardado, ahoraISO()).movimientos);
  if (!mismos || C.capitalReal(r.estado.movimientos) !== C.capitalReal(C.limpiarEstadoV1(guardado, ahoraISO()).movimientos)) throw new Error('La conversión no conserva los movimientos');
  const nuevo = r.estado;
  const revAnterior = Number.isInteger(guardado.rev) ? guardado.rev : 0;
  nuevo.rev = revAnterior + 1;
  // Datos viejos y convertidos se guardan juntos (o no se guarda nada).
  await dbConfirmar(nuevo, revAnterior, { k: K_PREMIG, v: { guardado: ahoraISO(), versionNueva: APP_VERSION, datos: guardado } });
  setTimeout(() => aviso('App actualizada a la versión ' + APP_VERSION + '. Tus ' + nuevo.movimientos.length + ' movimientos se conservaron.'), 300);
  return nuevo;
}

async function iniciar() {
  try { await abrirDB(); } catch (e) {
    try { localStorage.setItem('mkf_test', '1'); localStorage.removeItem('mkf_test'); usaLocalStorage = true; }
    catch (e2) { pantallaError('Este navegador no permite guardar datos (¿modo incógnito?). Abrí la app en una ventana normal.'); return; }
  }
  let guardado;
  try { guardado = await dbLeer(K_ESTADO); }
  catch (e) { pantallaError('No se pudieron leer tus datos. No cargues nada nuevo: cerrá y volvé a abrir la app. Si sigue, restaurá una copia.'); return; }
  try {
    if (guardado) estado = await migrarSiHaceFalta(guardado);
    else { const ini = C.estadoBase(ahoraISO()); await dbConfirmar(ini, 0, null); estado = ini; }
  } catch (e) {
    console.warn(e);
    if (e instanceof ErrorConflicto) { pantallaError('Otra ventana de la app está actualizando tus datos. Cerrá las demás ventanas y volvé a abrir la app.'); return; }
    pantallaError('No se pudieron preparar tus datos para esta versión (' + (e && e.message ? e.message : 'error') + '). No se modificó nada. Podés descargar tus datos tal como están y escribirnos.', guardado || null);
    return;
  }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* nada */ }
  render();
}

/* ---------- Actualizaciones (service worker) ---------- */
function vigilarActualizaciones(reg) {
  const ofrecer = w => mostrarBanner('Hay una versión nueva de la app. Tus datos no se tocan.', 'Actualizar ahora', () => {
    if (ocupado) return aviso('Esperá a que termine de guardar.', true);
    w.postMessage({ tipo: 'SKIP_WAITING' });
  });
  if (reg.waiting && navigator.serviceWorker.controller) ofrecer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    if (!w) return;
    w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ofrecer(w); });
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
}
if ('serviceWorker' in navigator) {
  let recargando = false;
  let tieneControlador = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // La primera vez que el service worker toma control (primera instalación) no hace falta recargar.
    // Cualquier cambio posterior es una versión nueva: se recarga para no mezclar archivos.
    if (!tieneControlador) { tieneControlador = true; return; }
    if (recargando) return;
    recargando = true; location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => { vigilarActualizaciones(reg); reg.update().catch(() => {}); })
      .catch(() => { /* sin modo offline */ });
  });
}
iniciar();

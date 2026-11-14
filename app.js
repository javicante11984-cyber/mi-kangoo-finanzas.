/* Mi Kangoo Finanzas — interfaz y almacenamiento */
'use strict';
const C = Calc;
const APP_VERSION = self.MKF_VERSION || '?';
const DB_NAME = 'mi-kangoo-finanzas';
const STORE = 'kv';
const K_ESTADO = 'estado';
const K_PREVIO = 'respaldo_previo';

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

function estadoInicial() {
  const hoy = new Date();
  return {
    esquema: 1, rev: 0,
    creado: hoy.toISOString(), actualizado: hoy.toISOString(), ultimoRespaldo: null,
    config: {
      ahorroMensual: 400000, aguinaldo: 600000, aguinaldoMeses: [6, 12], fechaInicio: C.mesClave(hoy),
      plazoCorto: 18, plazoLargo: 24, reservaEmergencia: 0,
      precioRef: 0, precioRefDescripcion: '', precioRefFuente: '', precioRefFecha: '', precioRefEstado: 'SIN VERIFICAR',
      cuentas: ['Caja de ahorro', 'Efectivo']
    },
    movimientos: []
  };
}

let estado = null;
let ocupado = false;
const clonar = o => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const canal = ('BroadcastChannel' in window) ? new BroadcastChannel('mkf') : null;

function erroresDe(e) { return C.validarConfig(e.config).concat(C.validarMovimientos(e.movimientos, hoyISO())); }

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
    nuevo.actualizado = new Date().toISOString();
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
    if (g) estado = C.limpiarEstado(g, estadoInicial());
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
const PANTALLAS = { inicio: 'Inicio', ahorros: 'Mis ahorros', metas: 'Metas', respaldo: 'Respaldo' };
function pantallaActual() { const h = location.hash.replace('#', ''); return PANTALLAS[h] ? h : 'inicio'; }
function render() {
  if (!estado) return;
  const p = pantallaActual();
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('activo', a.dataset.p === p));
  $('#titulo').textContent = PANTALLAS[p];
  const main = $('#main');
  ({ inicio: renderInicio, ahorros: renderAhorros, metas: renderMetas, respaldo: renderRespaldo })[p](main);
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

/* ---------- Inicio ---------- */
function tarjetaMeta(p, nombre) {
  const cfg = estado.config;
  let h = '<div class="card"><h3>' + esc(nombre) + ' (' + p.plazoMeses + ' meses)</h3>';
  h += '<p class="sub">Objetivo: ' + mesTexto(p.mesObjetivo) + ' · faltan ' + p.mesesRestantes + ' meses</p>';
  h += '<div class="fila"><span>Capital real hoy</span><b>' + pesos(p.capitalReal) + '</b></div>';
  h += '<div class="fila"><span>Ahorro mensual proyectado</span><b>+ ' + pesos(p.ahorroProyectado) + '</b></div>';
  h += '<div class="fila"><span>Aguinaldos proyectados (' + p.cantAguinaldos + ')</span><b>+ ' + pesos(p.aguinaldoProyectado) + '</b></div>';
  h += '<div class="fila total"><span>Podrías tener ' + etiqueta('ESTIMADO') + '</span><b>' + pesos(p.total) + '</b></div>';
  if (p.necesario != null) {
    h += '<div class="fila"><span>Necesitás (precio + reserva)</span><b>' + pesos(p.necesario) + '</b></div>';
    if (p.diferencia < 0) h += '<p class="msg malo">Faltarían ' + pesos(-p.diferencia) + ' si el precio no cambia.</p>';
    else h += '<p class="msg bueno">Alcanzaría, con ' + pesos(p.diferencia) + ' de margen, si el precio no cambia.</p>';
    if (p.ahorroMensualNecesario != null) h += '<p class="sub">Para llegar a tiempo necesitarías ahorrar ' + pesos(p.ahorroMensualNecesario) + ' por mes (hoy planeás ' + pesos(cfg.ahorroMensual) + ').</p>';
  } else h += '<p class="sub">Cargá un precio de referencia en Metas para calcular cuánto faltaría.</p>';
  return h + '</div>';
}

function renderInicio(main) {
  const hoy = new Date();
  const cfg = estado.config;
  const movs = estado.movimientos;
  const capital = C.capitalReal(movs);
  const mes = C.netoDelMes(movs, C.mesClave(hoy));
  const rec = C.recomendar(estado, hoy);
  const ep = C.estadoPrecio(cfg, hoy);
  const disponible = capital - (cfg.reservaEmergencia || 0);
  const pct = cfg.precioRef > 0 ? Math.max(0, Math.min(100, disponible / cfg.precioRef * 100)) : 0;
  const problemas = erroresDe(estado);

  let h = '';
  if (problemas.length) h += '<div class="card"><p class="msg malo"><b>Revisá tus datos:</b> se detectaron ' + problemas.length + ' problema(s) en registros anteriores. No afectan el cálculo del capital (las correcciones repetidas no se cuentan), pero conviene exportar una copia.</p><ul>' + problemas.slice(0, 5).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
  h += '<div class="card rec rec-' + esc(rec.codigo.split(' ')[0].toLowerCase()) + '"><p class="rec-cod">' + esc(rec.codigo) + '</p><p>' + esc(rec.texto) + '</p></div>';
  h += '<div class="card"><p class="sub">Capital real acumulado (según tus registros)</p><p class="grande" id="capital">' + pesos(capital) + '</p>';
  if (mes > 0) h += '<p>Este mes ahorraste <b>' + pesos(mes) + '</b>.</p>';
  else if (mes < 0) h += '<p>Este mes tu capital bajó <b>' + pesos(-mes) + '</b>.</p>';
  else h += '<p>Este mes todavía no registraste ahorro.</p>';
  if (cfg.reservaEmergencia > 0) h += '<p class="sub">Reserva de emergencia: ' + pesos(cfg.reservaEmergencia) + ' (no se usa para el auto). Disponible para la Kangoo: ' + pesos(Math.max(0, disponible)) + '.</p>';
  h += '</div>';

  h += '<div class="card"><h3>Precio de referencia de la Kangoo</h3>';
  if (cfg.precioRef > 0) {
    h += '<p class="grande">' + pesos(cfg.precioRef) + ' ' + etiqueta(ep) + '</p>';
    if (cfg.precioRefDescripcion) h += '<p>' + esc(cfg.precioRefDescripcion) + '</p>';
    h += '<p class="sub">Fuente: ' + (cfg.precioRefFuente ? esc(cfg.precioRefFuente) : 'sin indicar') + ' · consultado: ' + fechaTexto(cfg.precioRefFecha) + '</p>';
    h += '<div class="barra" role="progressbar" aria-valuenow="' + Math.round(pct) + '" aria-valuemin="0" aria-valuemax="100"><div style="width:' + pct.toFixed(1) + '%"></div></div>';
    h += '<p>Progreso: <b>' + pct.toFixed(1).replace('.', ',') + '%</b></p>';
    const dif = disponible - cfg.precioRef;
    h += dif < 0 ? '<p>Diferencia: te faltan <b>' + pesos(-dif) + '</b>.</p>' : '<p>Diferencia: te sobran <b>' + pesos(dif) + '</b> sobre el precio (sin gastos extra).</p>';
  } else h += '<p>No cargaste un precio todavía. ' + etiqueta('SIN DATO') + '</p><p><a class="btn" href="#metas">Cargar precio</a></p>';
  h += '</div>';

  h += tarjetaMeta(C.proyectarMeta(capital, cfg, cfg.plazoCorto, hoy), 'Meta corta');
  h += tarjetaMeta(C.proyectarMeta(capital, cfg, cfg.plazoLargo, hoy), 'Meta larga');

  h += '<div class="card nota"><p><b>Importante:</b> lo "proyectado" es una estimación, no dinero que tengas. Todavía no considera inflación ni aumentos del precio de la Kangoo (eso llega en la Etapa 3).</p>';
  h += '<p class="sub">Última modificación guardada: ' + fechaHoraTexto(estado.actualizado) + ' · Última copia de seguridad generada: ' + fechaHoraTexto(estado.ultimoRespaldo) + '</p>';
  const diasResp = estado.ultimoRespaldo ? C.diasDesde(estado.ultimoRespaldo.slice(0, 10), hoy) : null;
  if (movs.length && (diasResp === null || diasResp > 30)) h += '<p class="msg malo">Hace mucho que no hacés una copia de seguridad. <a href="#respaldo">Hacerla ahora</a>.</p>';
  h += '</div>';
  main.innerHTML = h;
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
    const mov = { id: nuevoId(), fecha: f.fecha.value, tipo, monto, cuenta, obs: f.obs.value.trim(), registrado: new Date().toISOString(), anulaA: null };
    const ok = await aplicarCambio(n => {
      if (!n.config.cuentas.includes(cuenta)) n.config.cuentas.push(cuenta);
      n.movimientos.push(mov); return n;
    });
    if (!ok) return; // el formulario conserva lo escrito y nada se muestra como guardado
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
    const c2 = C.puedeAnular(n.movimientos, id);       // se vuelve a comprobar sobre los datos actuales
    if (!c2.ok) throw new ErrorValidacion(c2.motivo);
    n.movimientos.push({ id: nuevoId(), fecha, tipo: 'anulacion', monto: o.monto, cuenta: o.cuenta, obs: motivo ? 'Corrección: ' + motivo : 'Corrección', registrado: new Date().toISOString(), anulaA: o.id });
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
  const m = n => n ? String(n).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '';
  let h = '<form id="fCfg" autocomplete="off">';
  h += '<div class="card"><h3>Tu plan de ahorro</h3>';
  h += '<label>Ahorro mensual planeado<input name="ahorroMensual" inputmode="decimal" value="' + m(c.ahorroMensual) + '"></label>';
  h += '<label>Aguinaldo estimado (cada vez que cobrás)<input name="aguinaldo" inputmode="decimal" value="' + m(c.aguinaldo) + '"></label>';
  h += '<fieldset><legend>Meses en que cobrás aguinaldo</legend><label class="check"><input type="checkbox" name="ag6"' + (c.aguinaldoMeses.includes(6) ? ' checked' : '') + '> Junio</label><label class="check"><input type="checkbox" name="ag12"' + (c.aguinaldoMeses.includes(12) ? ' checked' : '') + '> Diciembre</label></fieldset>';
  h += '<label>Mes de inicio del plan<input type="month" name="fechaInicio" required value="' + esc(c.fechaInicio) + '"></label>';
  h += '<label>Meta corta (meses)<input type="number" name="plazoCorto" min="1" max="120" required value="' + c.plazoCorto + '"></label>';
  h += '<label>Meta larga (meses)<input type="number" name="plazoLargo" min="1" max="120" required value="' + c.plazoLargo + '"></label>';
  h += '<label>Reserva de emergencia (no se usa para el auto)<input name="reservaEmergencia" inputmode="decimal" value="' + m(c.reservaEmergencia) + '" placeholder="0"></label>';
  h += '<p class="sub">Los montos planeados son supuestos. No se suman a tu capital real.</p></div>';

  h += '<div class="card"><h3>Precio de referencia de la Kangoo</h3>';
  h += '<p class="sub">Cargá solo precios que hayas visto en una fuente real (Renault Argentina, una concesionaria o una publicación). En usados es un precio pedido, no el precio final.</p>';
  h += '<label>Precio<input name="precioRef" inputmode="decimal" value="' + m(c.precioRef) + '" placeholder="Ej: 25.000.000"></label>';
  h += '<label>¿Qué vehículo es?<input name="precioRefDescripcion" maxlength="120" value="' + esc(c.precioRefDescripcion) + '" placeholder="Ej: Kangoo Stepway 2021, 60.000 km"></label>';
  h += '<label>Fuente o enlace<input name="precioRefFuente" maxlength="300" value="' + esc(c.precioRefFuente) + '" placeholder="Ej: renault.com.ar o enlace de la publicación"></label>';
  h += '<label>Fecha de consulta<input type="date" name="precioRefFecha" max="' + hoyISO() + '" value="' + esc(c.precioRefFecha) + '"></label>';
  h += '<label>Estado del dato<select name="precioRefEstado">' + C.ESTADOS_PRECIO.map(e => '<option' + (e === c.precioRefEstado ? ' selected' : '') + '>' + e + '</option>').join('') + '</select></label>';
  h += '<p class="sub">VERIFICADO: viste la fuente con fecha. ESTIMADO: lo calculaste. SIN VERIFICAR: te lo dijeron o no estás seguro. Pasados ' + C.DIAS_DESACTUALIZADO + ' días se marca DESACTUALIZADO.</p></div>';

  h += '<div class="card"><h3>Tus cuentas</h3><label>Una por línea<textarea name="cuentas" rows="4">' + esc(c.cuentas.join('\n')) + '</textarea></label>';
  h += '<p class="sub">Solo un nombre, por ejemplo "Mercado Pago" o "Plazo fijo". Nunca claves ni números de cuenta. Las cuentas que ya tienen movimientos no se pueden quitar.</p></div>';
  h += '<button class="btn primario" type="submit">Guardar cambios</button></form>';
  main.innerHTML = h;

  $('#fCfg').addEventListener('submit', async e => {
    e.preventDefault();
    if (ocupado) return;
    const f = e.target;
    const num = (campo, nombre) => {
      const txt = f[campo].value.trim();
      if (!txt) return 0;
      const v = C.parsearMonto(txt);
      if (!(v >= 0)) throw new Error('Revisá: ' + nombre);
      return v;
    };
    let nuevoCfg;
    try {
      nuevoCfg = {
        ahorroMensual: num('ahorroMensual', 'ahorro mensual'),
        aguinaldo: num('aguinaldo', 'aguinaldo'),
        aguinaldoMeses: [f.ag6.checked && 6, f.ag12.checked && 12].filter(Boolean),
        fechaInicio: f.fechaInicio.value,
        plazoCorto: parseInt(f.plazoCorto.value, 10),
        plazoLargo: parseInt(f.plazoLargo.value, 10),
        reservaEmergencia: num('reservaEmergencia', 'reserva de emergencia'),
        precioRef: num('precioRef', 'precio de referencia'),
        precioRefDescripcion: f.precioRefDescripcion.value.trim(),
        precioRefFuente: f.precioRefFuente.value.trim(),
        precioRefFecha: f.precioRefFecha.value,
        precioRefEstado: f.precioRefEstado.value,
        cuentas: [...new Set(f.cuentas.value.split('\n').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean))]
      };
      if (!C.esMesValido(nuevoCfg.fechaInicio)) throw new Error('Revisá el mes de inicio.');
      if (!(nuevoCfg.plazoCorto >= 1 && nuevoCfg.plazoCorto <= 120 && nuevoCfg.plazoLargo >= 1 && nuevoCfg.plazoLargo <= 120)) throw new Error('Los plazos deben estar entre 1 y 120 meses.');
      if (nuevoCfg.cuentas.some(x => x.length > 60)) throw new Error('Cada nombre de cuenta puede tener hasta 60 caracteres.');
      estado.movimientos.forEach(mv => { if (!nuevoCfg.cuentas.includes(mv.cuenta)) nuevoCfg.cuentas.push(mv.cuenta); });
      if (!nuevoCfg.cuentas.length) nuevoCfg.cuentas = ['Caja de ahorro'];
      if (nuevoCfg.precioRef > 0 && !nuevoCfg.precioRefFecha) throw new Error('Indicá la fecha en que consultaste el precio.');
      if (nuevoCfg.precioRefFecha && nuevoCfg.precioRefFecha > hoyISO()) throw new Error('La fecha de consulta no puede ser futura.');
      if (nuevoCfg.precioRefEstado === 'VERIFICADO' && nuevoCfg.precioRef > 0 && !nuevoCfg.precioRefFuente) throw new Error('Para marcarlo VERIFICADO indicá la fuente.');
    } catch (err) { return aviso(err.message, true); }
    const ok = await aplicarCambio(n => { n.config = nuevoCfg; return n; });
    if (!ok) return;
    aviso('Cambios guardados.');
    location.hash = '#inicio';
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
  return JSON.stringify({ app: 'mi-kangoo-finanzas', version: APP_VERSION, esquema: 1, exportado: new Date().toISOString(),
    resumen: C.resumen(estado.movimientos), datos: estado }, null, 2);
}
async function marcarRespaldo() {
  await aplicarCambio(n => { n.ultimoRespaldo = new Date().toISOString(); return n; });
}

async function renderRespaldo(main) {
  let previo = null;
  try { previo = await dbLeer(K_PREVIO); } catch (e) { /* nada */ }
  let persist = 'no disponible en este navegador';
  try { if (navigator.storage && navigator.storage.persisted) persist = (await navigator.storage.persisted()) ? 'sí (el navegador no lo borra solo)' : 'no confirmado (hacé copias seguido)'; } catch (e) { /* nada */ }
  if (pantallaActual() !== 'respaldo') return;

  let h = '<div class="card"><h3>¿Dónde están tus datos?</h3>';
  h += '<p>Solo en <b>este dispositivo y este navegador</b> (' + (usaLocalStorage ? 'localStorage' : 'IndexedDB') + '). No se envían a ningún servidor y <b>no hay sincronización</b> entre tu celular y tu computadora.</p>';
  h += '<p class="sub">Almacenamiento persistente: ' + esc(persist) + '. Si borrás los datos del navegador o desinstalás la app, se pierden. Por eso: copia de seguridad.</p>';
  h += '<p class="sub">Última copia generada: ' + fechaHoraTexto(estado.ultimoRespaldo) + ' · Movimientos: ' + estado.movimientos.length + '</p></div>';

  h += '<div class="card"><h3>Exportar</h3>';
  h += '<button class="btn primario" type="button" id="bExp">Descargar copia de seguridad</button>';
  if (navigator.canShare) h += '<button class="btn" type="button" id="bShare">Enviar copia (Drive, mail, WhatsApp…)</button>';
  h += '<button class="btn" type="button" id="bCsv">Descargar movimientos para Excel (CSV)</button>';
  h += '<p class="sub">La copia (.json) sirve para restaurar o pasar tus datos a otro dispositivo. Incluye un resumen de control para detectar archivos dañados o modificados. El CSV es solo para mirar en Excel; no sirve para restaurar.</p></div>';

  h += '<div class="card"><h3>Restaurar una copia</h3>';
  h += '<label class="btn" for="fileImp">Elegir archivo de copia (.json)</label><input type="file" id="fileImp" accept=".json,application/json" hidden>';
  h += '<div id="impPrev"></div>';
  if (previo) h += '<p class="sub">Antes de la última restauración guardamos tus datos anteriores (' + fechaHoraTexto(previo.guardado) + ').</p><button class="btn" type="button" id="bDeshacer">Deshacer última restauración</button>';
  h += '</div>';
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
    const candidato = C.limpiarEstado(obj.datos, estadoInicial());
    const cap = C.capitalReal(candidato.movimientos);
    box.innerHTML = '<div class="mov"><p><b>Copia del ' + fechaHoraTexto(obj.exportado) + '</b></p><p>' + candidato.movimientos.length + ' movimientos · capital real ' + pesos2(cap) + '</p>' +
      (v.advertencias.length ? '<ul>' + v.advertencias.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
      '<p class="msg malo">Esto reemplaza TODOS tus datos actuales (' + estado.movimientos.length + ' movimientos, capital ' + pesos2(C.capitalReal(estado.movimientos)) + '). Tus datos actuales se guardan para poder deshacer.</p>' +
      '<button class="btn primario" type="button" id="bConfImp">Sí, restaurar esta copia</button><button class="btn" type="button" id="bCancImp">Cancelar</button></div>';
    $('#bCancImp').addEventListener('click', () => { box.innerHTML = ''; });
    $('#bConfImp').addEventListener('click', async ev => {
      ev.target.disabled = true;
      const anterior = clonar(estado);
      const ok = await aplicarCambio(() => clonar(candidato), { modo: 'reemplazo', extra: () => ({ k: K_PREVIO, v: { guardado: new Date().toISOString(), datos: anterior } }) });
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
    const anterior = clonar(estado);
    const ok = await aplicarCambio(() => C.limpiarEstado(clonar(p.datos), estadoInicial()), { modo: 'cambio', extra: () => ({ k: K_PREVIO, v: { guardado: new Date().toISOString(), datos: anterior } }) });
    if (!ok) return;
    aviso('Restauración deshecha.');
    render();
  });
}

/* ---------- Arranque ---------- */
async function iniciar() {
  try { await abrirDB(); } catch (e) {
    try { localStorage.setItem('mkf_test', '1'); localStorage.removeItem('mkf_test'); usaLocalStorage = true; }
    catch (e2) { $('#main').innerHTML = '<div class="card"><p class="msg malo">Este navegador no permite guardar datos (¿modo incógnito?). Abrí la app en una ventana normal.</p></div>'; return; }
  }
  try {
    const guardado = await dbLeer(K_ESTADO);
    if (guardado) estado = C.limpiarEstado(guardado, estadoInicial());
    else {
      const ini = estadoInicial();
      await dbConfirmar(ini, 0, null);
      estado = ini;
    }
  } catch (e) {
    $('#main').innerHTML = '<div class="card"><p class="msg malo">No se pudieron leer ni preparar tus datos. No cargues nada nuevo: cerrá y volvé a abrir la app. Si sigue, restaurá una copia.</p></div>';
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
  const habiaControlador = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!habiaControlador || recargando) return; // primera instalación: no hace falta recargar
    recargando = true; location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => { vigilarActualizaciones(reg); reg.update().catch(() => {}); })
      .catch(() => { /* sin modo offline */ });
  });
}
iniciar();

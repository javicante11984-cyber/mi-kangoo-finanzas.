/* Mi Kangoo Finanzas — cálculos, migración y validaciones puras (sin pantalla).
 * Se prueban con Node:  node --test tests/calc.test.js */
'use strict';

const TIPOS = {
  deposito:    { label: 'Depósito',               signo: 1,  aporte: true },
  aguinaldo:   { label: 'Aguinaldo',              signo: 1,  aporte: true },
  rendimiento: { label: 'Rendimiento',            signo: 1,  aporte: false },
  retiro:      { label: 'Retiro',                 signo: -1, aporte: true },
  comision:    { label: 'Comisión o pérdida',     signo: -1, aporte: false },
  anulacion:   { label: 'Corrección (anulación)', signo: 0,  aporte: false }
};

const ESQUEMA_ACTUAL = 2;
const DIAS_DESACTUALIZADO = 30;
const MAX_MONTO = 1e12;
const MAX_MOVIMIENTOS = 100000;
const MAX_PLAZO = 240;              // 20 años
const MAX_PLAZOS = 10;
const MAX_MESES_ESTIMACION = 600;   // 50 años: más allá se informa "no se alcanza"
const PLAZOS_SUGERIDOS = [12, 18, 24, 36, 48];
const ESTADOS_PRECIO = ['VERIFICADO', 'ESTIMADO', 'SIN VERIFICAR'];
const RE_ID = /^[A-Za-z0-9-]{1,64}$/;
const RE_CONTROL = /[\u0000-\u001f\u007f]/;

function r2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
function indexarPorId(lista) { const m = {}; lista.forEach(x => { m[x.id] = x; }); return m; }

/* ---------- Validadores básicos ---------- */
function esFechaValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function esMesValido(s) { return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && +s.slice(0, 4) >= 2000 && +s.slice(0, 4) <= 2100; }
function tieneHastaDosDecimales(n) { return Math.abs(Math.round(n * 100) - n * 100) < 1e-6; }
function esMontoValido(n) { return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_MONTO && tieneHastaDosDecimales(n); }
function esImporteConfigValido(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_MONTO && tieneHastaDosDecimales(n); }
function esTextoValido(s, min, max) { return typeof s === 'string' && s.length >= min && s.length <= max && !RE_CONTROL.test(s); }
function esISOValido(s) { return typeof s === 'string' && s.length <= 40 && !isNaN(Date.parse(s)); }
function esPlazoValido(n) { return Number.isInteger(n) && n >= 1 && n <= MAX_PLAZO; }
function esObjeto(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

/* ---------- Fechas ---------- */
function mesClave(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function fechaClave(d) { return mesClave(d) + '-' + String(d.getDate()).padStart(2, '0'); }
function sumarMeses(aaaamm, n) {
  const [y, m] = aaaamm.split('-').map(Number);
  const tot = y * 12 + (m - 1) + n;
  return Math.floor(tot / 12) + '-' + String((tot % 12) + 1).padStart(2, '0');
}
function difMeses(desde, hasta) {
  const [y1, m1] = desde.split('-').map(Number);
  const [y2, m2] = hasta.split('-').map(Number);
  return (y2 * 12 + m2) - (y1 * 12 + m1);
}
function rangoMeses(desde, hasta) { const out = []; for (let i = 0, n = difMeses(desde, hasta); i <= n; i++) out.push(sumarMeses(desde, i)); return out; }
function diasDesde(fechaISO, hoy) {
  if (!fechaISO) return null;
  const d = new Date(fechaISO + (fechaISO.length === 10 ? 'T12:00:00' : ''));
  if (isNaN(d)) return null;
  return Math.floor((hoy - d) / 86400000);
}

/* =====================================================================
 * MOVIMIENTOS Y ANULACIONES
 * Solo la PRIMERA anulación válida de un movimiento tiene efecto.
 * ===================================================================== */
function analizarAnulaciones(movs) {
  const porId = indexarPorId(movs);
  const efectiva = new Map();   // idOriginal -> idAnulación
  const sinEfecto = new Set();
  movs.forEach(m => {
    if (m.tipo !== 'anulacion') return;
    const o = porId[m.anulaA];
    if (!o || !TIPOS[o.tipo] || o.tipo === 'anulacion' || o.id === m.id || efectiva.has(o.id)) { sinEfecto.add(m.id); return; }
    efectiva.set(o.id, m.id);
  });
  return { porId, efectiva, sinEfecto };
}
function importes(movs) {
  const { porId, sinEfecto } = analizarAnulaciones(movs);
  const res = new Map();
  movs.forEach(m => {
    if (m.tipo === 'anulacion') res.set(m.id, sinEfecto.has(m.id) ? 0 : -TIPOS[porId[m.anulaA].tipo].signo * porId[m.anulaA].monto);
    else { const t = TIPOS[m.tipo]; res.set(m.id, t ? t.signo * m.monto : 0); }
  });
  return res;
}
function importeConSigno(mov, movs) { return importes(movs).get(mov.id) || 0; }
function idsAnulados(movs) { return new Set(analizarAnulaciones(movs).efectiva.keys()); }
function puedeAnular(movs, id) {
  const o = movs.find(m => m.id === id);
  if (!o) return { ok: false, motivo: 'El movimiento no existe.' };
  if (o.tipo === 'anulacion') return { ok: false, motivo: 'Una corrección no se puede anular.' };
  if (idsAnulados(movs).has(id)) return { ok: false, motivo: 'Este movimiento ya fue anulado.' };
  return { ok: true };
}
function capitalReal(movs) { let s = 0; importes(movs).forEach(v => { s += v; }); return r2(s); }
function saldoPorCuenta(movs) {
  const imp = importes(movs); const res = {};
  movs.forEach(m => { res[m.cuenta] = r2((res[m.cuenta] || 0) + imp.get(m.id)); });
  return res;
}
function resumen(movs) { return { cantidad: movs.length, capital: capitalReal(movs), saldos: saldoPorCuenta(movs) }; }

/* Movimientos "vigentes" para mirar la historia mes a mes:
 * un movimiento anulado y su anulación se cancelan entre sí, así que no se cuentan en ningún mes
 * (si un depósito de octubre fue un error, tu capital real de octubre no lo incluía). */
function vigentes(movs) {
  const { efectiva, sinEfecto } = analizarAnulaciones(movs);
  const anulaciones = new Set(efectiva.values());
  return movs.filter(m => !efectiva.has(m.id) && !anulaciones.has(m.id) && !sinEfecto.has(m.id) && TIPOS[m.tipo] && m.tipo !== 'anulacion');
}
function porMes(movs) {
  const out = {};
  vigentes(movs).forEach(m => {
    const k = m.fecha.slice(0, 7);
    const o = out[k] || (out[k] = { neto: 0, aportes: 0, rendimientos: 0 });
    const v = TIPOS[m.tipo].signo * m.monto;
    o.neto = r2(o.neto + v);
    if (TIPOS[m.tipo].aporte) o.aportes = r2(o.aportes + v); else o.rendimientos = r2(o.rendimientos + v);
  });
  return out;
}
function netoDelMes(movs, mes) { return (porMes(movs)[mes] || { neto: 0 }).neto; }

/* =====================================================================
 * PLAN DE AHORRO (con historial) Y PRECIOS (con historial)
 * ===================================================================== */
/* Plan vigente en un mes: el de "desde" más reciente que no sea posterior al mes.
 * Si hay dos con el mismo "desde", gana el registrado último. */
function planVigente(config, mes) {
  const h = (config.planHistorial || []).slice().sort((a, b) => (a.desde + a.registrado).localeCompare(b.desde + b.registrado));
  let res = null;
  h.forEach(p => { if (p.desde <= mes) res = p; });
  return res || h[0] || { ahorroMensual: 0, aguinaldo: 0, desde: mes };
}
function ahorroPlaneadoMes(config, mes) {
  const p = planVigente(config, mes);
  const conAg = (config.aguinaldoMeses || []).includes(Number(mes.slice(5)));
  return { ahorro: p.ahorroMensual, aguinaldo: conAg ? p.aguinaldo : 0, total: r2(p.ahorroMensual + (conAg ? p.aguinaldo : 0)) };
}

function analizarPrecios(precios) {
  const porId = indexarPorId(precios);
  const anulados = new Map(); const sinEfecto = new Set();
  precios.forEach(p => {
    if (p.tipo !== 'anulacion') return;
    const o = porId[p.anulaA];
    if (!o || o.tipo !== 'precio' || anulados.has(o.id)) { sinEfecto.add(p.id); return; }
    anulados.set(o.id, p.id);
  });
  return { porId, anulados, sinEfecto };
}
/* Precios válidos (no anulados), ordenados por fecha de consulta y luego por registro. */
function historialPrecios(precios) {
  const { anulados } = analizarPrecios(precios || []);
  return (precios || []).filter(p => p.tipo === 'precio' && !anulados.has(p.id))
    .sort((a, b) => ((a.fecha || '0000') + a.registrado).localeCompare((b.fecha || '0000') + b.registrado));
}
function precioVigente(precios) { const h = historialPrecios(precios); return h.length ? h[h.length - 1] : null; }
/* Precio vigente al final de un mes (para la historia). */
function precioAlMes(precios, mes) {
  let res = null;
  historialPrecios(precios).forEach(p => { if (p.fecha && p.fecha.slice(0, 7) <= mes) res = p; });
  return res;
}
function puedeAnularPrecio(precios, id) {
  const o = precios.find(p => p.id === id);
  if (!o || o.tipo !== 'precio') return { ok: false, motivo: 'El precio no existe.' };
  if (analizarPrecios(precios).anulados.has(id)) return { ok: false, motivo: 'Este precio ya fue anulado.' };
  return { ok: true };
}
function estadoDePrecio(p, hoy) {
  if (!p) return 'SIN DATO';
  if (!p.fecha) return 'SIN VERIFICAR';
  const dias = diasDesde(p.fecha, hoy);
  if (dias === null) return 'SIN VERIFICAR';
  if (dias > DIAS_DESACTUALIZADO) return 'DESACTUALIZADO';
  return p.estado || 'SIN VERIFICAR';
}
/* Compara cuánto cambió el precio y cuánto cambió tu capital entre el primer y el último precio registrado. */
function variacionPrecioVsCapital(estado) {
  const h = historialPrecios(estado.precios).filter(p => p.fecha);
  if (h.length < 2) return null;
  const a = h[0], b = h[h.length - 1];
  if (a.fecha === b.fecha) return null;
  const capA = capitalAlFecha(estado.movimientos, a.fecha), capB = capitalAlFecha(estado.movimientos, b.fecha);
  return {
    desde: a.fecha, hasta: b.fecha, precioDesde: a.precio, precioHasta: b.precio,
    variacionPrecio: r2(b.precio - a.precio), pctPrecio: r2((b.precio / a.precio - 1) * 100),
    capitalDesde: capA, capitalHasta: capB, variacionCapital: r2(capB - capA),
    mismoVehiculo: (a.descripcion || '').trim().toLowerCase() === (b.descripcion || '').trim().toLowerCase()
  };
}
function capitalAlFecha(movs, fecha) { return r2(vigentes(movs).filter(m => m.fecha <= fecha).reduce((s, m) => s + TIPOS[m.tipo].signo * m.monto, 0)); }

/* =====================================================================
 * METAS Y ESTIMACIONES (todo lo que sale de acá es ESTIMADO)
 * ===================================================================== */
function necesarioPara(estado) {
  const p = precioVigente(estado.precios);
  return p ? r2(p.precio + (estado.config.reservaEmergencia || 0)) : null;
}

/* Proyección hasta el mes objetivo (inicio del plan + plazo). Suma el plan de cada mes
 * desde el mes próximo, para no duplicar lo que ya cargaste este mes. */
function proyectarMeta(estado, plazoMeses, hoy) {
  const cfg = estado.config;
  const capital = capitalReal(estado.movimientos);
  const mesHoy = mesClave(hoy);
  const mesObjetivo = sumarMeses(cfg.fechaInicio, plazoMeses);
  const mesesRestantes = Math.max(0, difMeses(mesHoy, mesObjetivo));
  let ahorro = 0, ag = 0, cant = 0;
  for (let i = 1; i <= mesesRestantes; i++) {
    const a = ahorroPlaneadoMes(cfg, sumarMeses(mesHoy, i));
    ahorro += a.ahorro; ag += a.aguinaldo; if (a.aguinaldo > 0) cant++;
  }
  const out = { plazoMeses, mesObjetivo, mesesRestantes, cantAguinaldos: cant, capitalReal: capital,
    ahorroProyectado: r2(ahorro), aguinaldoProyectado: r2(ag), total: r2(capital + ahorro + ag),
    necesario: null, diferencia: null, ahorroMensualNecesario: null };
  const nec = necesarioPara(estado);
  if (nec !== null) {
    out.necesario = nec;
    out.diferencia = r2(out.total - nec);
    if (mesesRestantes > 0) out.ahorroMensualNecesario = r2(Math.max(0, (nec - capital - ag) / mesesRestantes));
  }
  return out;
}

/* ¿En cuántos meses alcanzarías lo necesario siguiendo tu plan? (precio constante) */
function mesesParaAlcanzar(estado, hoy) {
  const nec = necesarioPara(estado);
  if (nec === null) return { estado: 'sin-precio' };
  const capital = capitalReal(estado.movimientos);
  const falta = r2(nec - capital);
  if (falta <= 0) return { estado: 'alcanzado', falta: 0, meses: 0, mes: mesClave(hoy) };
  const mesHoy = mesClave(hoy);
  let acumulado = capital;
  for (let i = 1; i <= MAX_MESES_ESTIMACION; i++) {
    const mes = sumarMeses(mesHoy, i);
    acumulado += ahorroPlaneadoMes(estado.config, mes).total;
    if (acumulado >= nec - 0.005) return { estado: 'estimado', falta, meses: i, mes };
  }
  return { estado: 'no-alcanza', falta };
}

/* Promedio de aportes reales (depósitos + aguinaldos − retiros) de los últimos meses COMPLETOS.
 * Necesita al menos 3 meses completos desde el primer movimiento. */
function ritmoReal(movs, hoy, maxMeses = 6) {
  const vs = vigentes(movs);
  if (!vs.length) return null;
  const primero = vs.map(m => m.fecha.slice(0, 7)).sort()[0];
  const ultimoCompleto = sumarMeses(mesClave(hoy), -1);
  const disponibles = difMeses(primero, ultimoCompleto) + 1;
  if (disponibles < 3) return null;
  const n = Math.min(maxMeses, disponibles);
  const pm = porMes(movs);
  let s = 0;
  for (let i = 0; i < n; i++) s += (pm[sumarMeses(ultimoCompleto, -i)] || { aportes: 0 }).aportes;
  return { promedio: r2(s / n), meses: n, desde: sumarMeses(ultimoCompleto, -(n - 1)), hasta: ultimoCompleto };
}
function mesesAlRitmoReal(estado, hoy) {
  const nec = necesarioPara(estado);
  const ritmo = ritmoReal(estado.movimientos, hoy);
  if (nec === null || !ritmo) return null;
  const falta = r2(nec - capitalReal(estado.movimientos));
  if (falta <= 0) return { ritmo, meses: 0 };
  if (ritmo.promedio <= 0) return { ritmo, meses: null };
  const meses = Math.ceil(falta / ritmo.promedio - 1e-9);
  return { ritmo, meses: meses > MAX_MESES_ESTIMACION ? null : meses, mes: meses > MAX_MESES_ESTIMACION ? null : sumarMeses(mesClave(hoy), meses) };
}

/* Motor de recomendación — prudente: todavía no devuelve CONSIDERAR COMPRA (faltan gastos y financiación, Etapa 3). */
function recomendar(estado, hoy) {
  const cfg = estado.config;
  const movs = estado.movimientos;
  const capital = capitalReal(movs);
  const reserva = cfg.reservaEmergencia || 0;
  const p = precioVigente(estado.precios);
  const ep = estadoDePrecio(p, hoy);
  const fmt = n => '$' + Math.round(Math.abs(n)).toLocaleString('es-AR');
  if (!p) return { codigo: 'INFORMACIÓN INSUFICIENTE',
    texto: 'Faltan datos para recomendar. Cargá un precio de la Kangoo en la pantalla Metas, con la fuente y la fecha en que lo consultaste.' };
  if (movs.length === 0) return { codigo: 'INFORMACIÓN INSUFICIENTE',
    texto: 'Todavía no cargaste movimientos. Tu capital real registrado es $0. Cargá tus ahorros en "Mis ahorros" para empezar a medir tu progreso.' };
  const nota = ep === 'DESACTUALIZADO' ? ' Ojo: el precio tiene más de ' + DIAS_DESACTUALIZADO + ' días; volvé a consultarlo.'
    : (ep === 'VERIFICADO' ? '' : ' El precio que usamos está ' + ep + '.');
  if (capital < reserva) return { codigo: 'SEGUIR AHORRANDO',
    texto: 'Primero completá tu reserva de emergencia: te faltan ' + fmt(reserva - capital) + '. La reserva no se usa para comprar el auto.' + nota };
  if (capital - reserva < p.precio) return { codigo: 'SEGUIR AHORRANDO',
    texto: 'Te faltan ' + fmt(p.precio - (capital - reserva)) + ' para llegar al precio, sin tocar tu reserva. Comprar ahora implicaría endeudarte; seguir ahorrando reduce esa deuda.' + nota };
  return { codigo: 'INVESTIGAR OPORTUNIDAD',
    texto: 'Tu capital disponible ya cubre el precio. Antes de comprar falta calcular transferencia, seguro, patente y mantenimiento (llega en la Etapa 3). Verificá publicaciones reales y no apures la decisión.' + nota };
}

/* =====================================================================
 * SERIES PARA GRÁFICOS (datos puros; el dibujo está en graficos.js)
 * ===================================================================== */
/* Capital real al final de cada mes, desde el primer movimiento hasta el mes actual. */
function serieCapital(movs, hoy) {
  const vs = vigentes(movs);
  if (!vs.length) return [];
  const desde = vs.map(m => m.fecha.slice(0, 7)).sort()[0];
  const hasta = mesClave(hoy) > desde ? mesClave(hoy) : desde;
  const pm = porMes(movs);
  let acc = 0;
  return rangoMeses(desde, hasta).map(mes => { acc = r2(acc + (pm[mes] ? pm[mes].neto : 0)); return { mes, capital: acc }; });
}
/* Aportes reales de cada mes vs. lo planeado, desde el inicio del plan hasta el mes actual. */
function serieAportesVsPlan(estado, hoy) {
  const desde = estado.config.fechaInicio, hasta = mesClave(hoy);
  if (desde > hasta) return [];
  const pm = porMes(estado.movimientos);
  let accReal = 0, accPlan = 0;
  return rangoMeses(desde, hasta).map(mes => {
    const real = pm[mes] ? pm[mes].aportes : 0;
    const plan = ahorroPlaneadoMes(estado.config, mes).total;
    accReal = r2(accReal + real); accPlan = r2(accPlan + plan);
    return { mes, real, plan, acumuladoReal: accReal, acumuladoPlan: accPlan, enCurso: mes === hasta };
  });
}
/* Camino hacia la meta: pasado real, futuro estimado con el plan, y precio (historial + supuesto constante). */
function serieProgreso(estado, plazo, hoy) {
  const mesHoy = mesClave(hoy);
  const cap = serieCapital(estado.movimientos, hoy);
  const mesObjetivo = sumarMeses(estado.config.fechaInicio, plazo);
  const primerMes = [cap.length ? cap[0].mes : mesHoy, estado.config.fechaInicio].sort()[0];
  const ultimo = mesObjetivo > mesHoy ? mesObjetivo : mesHoy;
  const capPorMes = {}; cap.forEach(c => { capPorMes[c.mes] = c.capital; });
  const vigente = precioVigente(estado.precios);
  const reserva = estado.config.reservaEmergencia || 0;
  let proy = capitalReal(estado.movimientos);
  let ultimoReal = 0;
  return rangoMeses(primerMes, ultimo).map(mes => {
    const fila = { mes, real: null, proyectado: null, precio: null, necesario: null, precioSupuesto: false };
    if (mes <= mesHoy) { if (capPorMes[mes] !== undefined) ultimoReal = capPorMes[mes]; fila.real = ultimoReal; }
    if (mes === mesHoy) fila.proyectado = proy;
    if (mes > mesHoy) { proy = r2(proy + ahorroPlaneadoMes(estado.config, mes).total); fila.proyectado = proy; }
    const p = mes <= mesHoy ? precioAlMes(estado.precios, mes) : vigente;
    if (p) { fila.precio = p.precio; fila.necesario = r2(p.precio + reserva); fila.precioSupuesto = mes > mesHoy; }
    return fila;
  });
}
function comparacionMetas(estado, plazos, hoy) {
  return plazos.slice().sort((a, b) => a - b).map(pl => proyectarMeta(estado, pl, hoy));
}

/* =====================================================================
 * VALIDACIÓN
 * ===================================================================== */
function validarConfigV1(c) {
  const e = [];
  if (!esObjeto(c)) return ['Falta la configuración.'];
  [['ahorroMensual', 'ahorro mensual'], ['aguinaldo', 'aguinaldo'], ['reservaEmergencia', 'reserva de emergencia'], ['precioRef', 'precio de referencia']]
    .forEach(([k, n]) => { if (!esImporteConfigValido(c[k])) e.push('Configuración: ' + n + ' inválido.'); });
  validarComunes(c, e);
  ['plazoCorto', 'plazoLargo'].forEach(k => { if (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 120) e.push('Configuración: plazo inválido (' + k + ').'); });
  if (!ESTADOS_PRECIO.includes(c.precioRefEstado)) e.push('Configuración: estado del precio inválido.');
  if (!esTextoValido(c.precioRefDescripcion, 0, 120)) e.push('Configuración: descripción del vehículo inválida.');
  if (!esTextoValido(c.precioRefFuente, 0, 300)) e.push('Configuración: fuente del precio inválida.');
  if (!(c.precioRefFecha === '' || esFechaValida(c.precioRefFecha))) e.push('Configuración: fecha del precio inválida.');
  return e;
}
function validarComunes(c, e) {
  if (!esImporteConfigValido(c.reservaEmergencia)) { if (!e.some(x => x.includes('reserva'))) e.push('Configuración: reserva de emergencia inválido.'); }
  if (!Array.isArray(c.aguinaldoMeses) || !c.aguinaldoMeses.every(m => m === 6 || m === 12) || new Set(c.aguinaldoMeses).size !== c.aguinaldoMeses.length)
    e.push('Configuración: meses de aguinaldo inválidos.');
  if (!esMesValido(c.fechaInicio)) e.push('Configuración: mes de inicio inválido.');
  if (!Array.isArray(c.cuentas) || !c.cuentas.length || c.cuentas.length > 50 || !c.cuentas.every(x => esTextoValido(x, 1, 60) && x.trim() === x)
      || new Set(c.cuentas).size !== c.cuentas.length) e.push('Configuración: lista de cuentas inválida.');
}
function validarConfig(c) {
  const e = [];
  if (!esObjeto(c)) return ['Falta la configuración.'];
  validarComunes(c, e);
  if (!Array.isArray(c.plazos) || !c.plazos.length || c.plazos.length > MAX_PLAZOS || !c.plazos.every(esPlazoValido) || new Set(c.plazos).size !== c.plazos.length)
    e.push('Configuración: plazos inválidos (de 1 a ' + MAX_PLAZO + ' meses, sin repetir, hasta ' + MAX_PLAZOS + ').');
  else if (!c.plazos.includes(c.plazoPrincipal)) e.push('Configuración: el plazo elegido no está en la lista de plazos.');
  if (!Array.isArray(c.planHistorial) || !c.planHistorial.length || c.planHistorial.length > 500) e.push('Configuración: falta el plan de ahorro.');
  else {
    const ids = new Set();
    c.planHistorial.forEach((p, i) => {
      const n = 'Plan ' + (i + 1) + ': ';
      if (!esObjeto(p)) { e.push(n + 'formato inválido.'); return; }
      if (typeof p.id !== 'string' || !RE_ID.test(p.id) || ids.has(p.id)) e.push(n + 'identificador inválido o repetido.'); ids.add(p.id);
      if (!esMesValido(p.desde)) e.push(n + 'mes de inicio inválido.');
      if (!esImporteConfigValido(p.ahorroMensual)) e.push(n + 'ahorro mensual inválido.');
      if (!esImporteConfigValido(p.aguinaldo)) e.push(n + 'aguinaldo inválido.');
      if (!esISOValido(p.registrado)) e.push(n + 'fecha de registro inválida.');
    });
  }
  return e;
}

function validarMovimientos(movs, hoyISO) {
  const e = [];
  if (!Array.isArray(movs)) return ['Faltan los movimientos.'];
  if (movs.length > MAX_MOVIMIENTOS) return ['Demasiados movimientos.'];
  const limite = hoyISO ? fechaClave(new Date(new Date(hoyISO + 'T12:00:00').getTime() + 86400000)) : null;
  const ids = new Set(); const porId = {};
  movs.forEach((m, i) => {
    const n = 'Movimiento ' + (i + 1) + ': ';
    if (!esObjeto(m)) { e.push(n + 'formato inválido.'); return; }
    if (typeof m.id !== 'string' || !RE_ID.test(m.id)) e.push(n + 'identificador inválido.');
    else if (ids.has(m.id)) e.push(n + 'identificador repetido.');
    else { ids.add(m.id); porId[m.id] = m; }
    if (!Object.prototype.hasOwnProperty.call(TIPOS, m.tipo)) e.push(n + 'tipo desconocido.');
    if (!esFechaValida(m.fecha)) e.push(n + 'fecha inválida.');
    else if (limite && m.fecha > limite) e.push(n + 'fecha futura (solo se registra dinero real).');
    if (!esMontoValido(m.monto)) e.push(n + 'monto inválido (debe ser un número positivo, finito y con hasta 2 decimales).');
    if (!esTextoValido(m.cuenta, 1, 60)) e.push(n + 'cuenta inválida.');
    if (!(m.obs === undefined || esTextoValido(m.obs, 0, 500))) e.push(n + 'observaciones inválidas.');
    if (!esISOValido(m.registrado)) e.push(n + 'fecha de registro inválida.');
    if (m.tipo !== 'anulacion' && !(m.anulaA === null || m.anulaA === undefined)) e.push(n + 'solo una corrección puede anular otro movimiento.');
  });
  const anulados = new Set();
  movs.forEach((m, i) => {
    if (!esObjeto(m) || m.tipo !== 'anulacion') return;
    const n = 'Movimiento ' + (i + 1) + ' (corrección): ';
    const o = porId[m.anulaA];
    if (typeof m.anulaA !== 'string' || !o) { e.push(n + 'anula un movimiento que no existe.'); return; }
    if (o === m) { e.push(n + 'se anula a sí mismo.'); return; }
    if (o.tipo === 'anulacion') { e.push(n + 'anula otra corrección.'); return; }
    if (anulados.has(o.id)) { e.push(n + 'anulación duplicada del mismo movimiento.'); return; }
    anulados.add(o.id);
    if (m.monto !== o.monto) e.push(n + 'el monto no coincide con el movimiento anulado.');
    if (m.cuenta !== o.cuenta) e.push(n + 'la cuenta no coincide con el movimiento anulado.');
    if (esFechaValida(m.fecha) && esFechaValida(o.fecha) && m.fecha < o.fecha) e.push(n + 'tiene fecha anterior al movimiento que anula.');
  });
  return e;
}

function validarPrecios(precios, hoyISO) {
  const e = [];
  if (!Array.isArray(precios)) return ['Falta el historial de precios.'];
  if (precios.length > 5000) return ['Demasiados precios.'];
  const limite = hoyISO ? fechaClave(new Date(new Date(hoyISO + 'T12:00:00').getTime() + 86400000)) : null;
  const ids = new Set(); const porId = {};
  precios.forEach((p, i) => {
    const n = 'Precio ' + (i + 1) + ': ';
    if (!esObjeto(p)) { e.push(n + 'formato inválido.'); return; }
    if (typeof p.id !== 'string' || !RE_ID.test(p.id) || ids.has(p.id)) e.push(n + 'identificador inválido o repetido.');
    else { ids.add(p.id); porId[p.id] = p; }
    if (!esISOValido(p.registrado)) e.push(n + 'fecha de registro inválida.');
    if (p.tipo === 'precio') {
      if (!esMontoValido(p.precio)) e.push(n + 'precio inválido.');
      if (!(p.fecha === '' || esFechaValida(p.fecha))) e.push(n + 'fecha de consulta inválida.');
      else if (limite && p.fecha > limite) e.push(n + 'fecha de consulta futura.');
      if (!ESTADOS_PRECIO.includes(p.estado)) e.push(n + 'estado inválido.');
      if (!esTextoValido(p.descripcion, 0, 120)) e.push(n + 'descripción inválida.');
      if (!esTextoValido(p.fuente, 0, 300)) e.push(n + 'fuente inválida.');
      if (!(p.anulaA === null || p.anulaA === undefined)) e.push(n + 'un precio no puede anular a otro.');
    } else if (p.tipo === 'anulacion') {
      if (!esFechaValida(p.fecha)) e.push(n + 'fecha inválida.');
      if (!esTextoValido(p.motivo || '', 0, 300)) e.push(n + 'motivo inválido.');
    } else e.push(n + 'tipo desconocido.');
  });
  const anulados = new Set();
  precios.forEach((p, i) => {
    if (!esObjeto(p) || p.tipo !== 'anulacion') return;
    const n = 'Precio ' + (i + 1) + ' (anulación): ';
    const o = porId[p.anulaA];
    if (!o || o.tipo !== 'precio') { e.push(n + 'anula un precio que no existe.'); return; }
    if (anulados.has(o.id)) { e.push(n + 'anulación duplicada del mismo precio.'); return; }
    anulados.add(o.id);
  });
  return e;
}

function validarEstado(est, hoyISO) {
  if (!esObjeto(est)) return ['Datos inválidos.'];
  if (est.esquema !== ESQUEMA_ACTUAL) return ['Versión de datos inesperada.'];
  return validarConfig(est.config).concat(validarMovimientos(est.movimientos, hoyISO), validarPrecios(est.precios, hoyISO));
}

/* =====================================================================
 * LIMPIEZA Y MIGRACIÓN (esquema 1 = versiones 1.0.0 y 1.0.1 → esquema 2 = 1.1)
 * ===================================================================== */
const CONFIG_V1_BASE = { ahorroMensual: 400000, aguinaldo: 600000, aguinaldoMeses: [6, 12], fechaInicio: null, plazoCorto: 18, plazoLargo: 24,
  reservaEmergencia: 0, precioRef: 0, precioRefDescripcion: '', precioRefFuente: '', precioRefFecha: '', precioRefEstado: 'SIN VERIFICAR', cuentas: ['Caja de ahorro', 'Efectivo'] };

function limpiarMovimientos(movs) {
  return (Array.isArray(movs) ? movs : []).map(m => ({ id: m.id, fecha: m.fecha, tipo: m.tipo, monto: m.monto, cuenta: m.cuenta,
    obs: typeof m.obs === 'string' ? m.obs : '', registrado: m.registrado, anulaA: m.tipo === 'anulacion' ? m.anulaA : null }));
}
function agregarCuentasUsadas(cfg, movs) {
  movs.forEach(m => { if (typeof m.cuenta === 'string' && !cfg.cuentas.includes(m.cuenta)) cfg.cuentas = cfg.cuentas.concat([m.cuenta]); });
}
function camposComunes(d, ahora) {
  return { rev: Number.isInteger(d.rev) && d.rev >= 0 ? d.rev : 0,
    creado: esISOValido(d.creado) ? d.creado : ahora, actualizado: esISOValido(d.actualizado) ? d.actualizado : ahora,
    ultimoRespaldo: esISOValido(d.ultimoRespaldo) ? d.ultimoRespaldo : null };
}

/* Esquema 1, solo campos conocidos (igual que la 1.0.1). */
function limpiarEstadoV1(d, ahora) {
  const c = esObjeto(d.config) ? d.config : {};
  const cfg = {};
  Object.keys(CONFIG_V1_BASE).forEach(k => { cfg[k] = c[k] !== undefined ? c[k] : CONFIG_V1_BASE[k]; });
  if (cfg.fechaInicio === null) cfg.fechaInicio = mesClave(new Date(ahora));
  const movimientos = limpiarMovimientos(d.movimientos);
  agregarCuentasUsadas(cfg, movimientos);
  return Object.assign({ esquema: 1 }, camposComunes(d, ahora), { config: cfg, movimientos });
}

/* Migración pura: no cambia ningún movimiento; traslada la configuración al formato nuevo. */
function migrarV1aV2(v1, ahora) {
  const c = v1.config;
  const plazos = [...new Set([c.plazoCorto, c.plazoLargo].filter(esPlazoValido))];
  const registradoBase = esISOValido(v1.creado) ? v1.creado : ahora;
  const precios = [];
  if (typeof c.precioRef === 'number' && c.precioRef > 0) {
    precios.push({ id: 'precio-migrado-v1', tipo: 'precio', fecha: esFechaValida(c.precioRefFecha) ? c.precioRefFecha : '', precio: c.precioRef,
      descripcion: c.precioRefDescripcion || '', fuente: c.precioRefFuente || '', estado: ESTADOS_PRECIO.includes(c.precioRefEstado) ? c.precioRefEstado : 'SIN VERIFICAR',
      registrado: esISOValido(v1.actualizado) ? v1.actualizado : ahora, anulaA: null });
  }
  return {
    esquema: 2, rev: v1.rev, creado: v1.creado, actualizado: v1.actualizado, ultimoRespaldo: v1.ultimoRespaldo,
    migracion: { desdeEsquema: 1, fecha: ahora },
    config: {
      fechaInicio: c.fechaInicio, aguinaldoMeses: c.aguinaldoMeses.slice(), reservaEmergencia: c.reservaEmergencia, cuentas: c.cuentas.slice(),
      plazos: plazos.length ? plazos : [18, 24], plazoPrincipal: esPlazoValido(c.plazoCorto) ? c.plazoCorto : (plazos[0] || 18),
      planHistorial: [{ id: 'plan-migrado-v1', desde: c.fechaInicio, ahorroMensual: c.ahorroMensual, aguinaldo: c.aguinaldo, registrado: registradoBase }]
    },
    precios,
    movimientos: v1.movimientos.map(m => Object.assign({}, m))
  };
}

function limpiarEstadoV2(d, ahora, base) {
  const c = esObjeto(d.config) ? d.config : {};
  const cfg = {};
  Object.keys(base.config).forEach(k => { cfg[k] = c[k] !== undefined ? c[k] : base.config[k]; });
  if (Array.isArray(cfg.planHistorial)) cfg.planHistorial = cfg.planHistorial.map(p => esObjeto(p) ? { id: p.id, desde: p.desde, ahorroMensual: p.ahorroMensual, aguinaldo: p.aguinaldo, registrado: p.registrado } : p);
  const movimientos = limpiarMovimientos(d.movimientos);
  agregarCuentasUsadas(cfg, movimientos);
  const precios = (Array.isArray(d.precios) ? d.precios : []).map(p => !esObjeto(p) ? p : (p.tipo === 'anulacion'
    ? { id: p.id, tipo: 'anulacion', anulaA: p.anulaA, fecha: p.fecha, motivo: typeof p.motivo === 'string' ? p.motivo : '', registrado: p.registrado }
    : { id: p.id, tipo: p.tipo, fecha: p.fecha, precio: p.precio, descripcion: typeof p.descripcion === 'string' ? p.descripcion : '',
        fuente: typeof p.fuente === 'string' ? p.fuente : '', estado: p.estado, registrado: p.registrado, anulaA: null }));
  const out = Object.assign({ esquema: 2 }, camposComunes(d, ahora), { config: cfg, precios, movimientos });
  if (esObjeto(d.migracion) && d.migracion.desdeEsquema === 1 && esISOValido(d.migracion.fecha)) out.migracion = { desdeEsquema: 1, fecha: d.migracion.fecha };
  return out;
}

function estadoBase(ahora) {
  const mes = mesClave(new Date(ahora));
  return { esquema: 2, rev: 0, creado: ahora, actualizado: ahora, ultimoRespaldo: null,
    config: { fechaInicio: mes, aguinaldoMeses: [6, 12], reservaEmergencia: 0, cuentas: ['Caja de ahorro', 'Efectivo'],
      plazos: [18, 24], plazoPrincipal: 18,
      planHistorial: [{ id: 'plan-inicial', desde: mes, ahorroMensual: 400000, aguinaldo: 600000, registrado: ahora }] },
    precios: [], movimientos: [] };
}

/* Lee datos guardados de cualquier versión y devuelve { estado (esquema 2), migrado: bool }. */
function cargarEstado(d, ahora) {
  if (!esObjeto(d)) throw new Error('Datos ilegibles');
  if (d.esquema === 2) return { estado: limpiarEstadoV2(d, ahora, estadoBase(ahora)), migrado: false };
  if (d.esquema === 1 || d.esquema === undefined) return { estado: migrarV1aV2(limpiarEstadoV1(d, ahora), ahora), migrado: true };
  throw new Error('Los datos son de una versión más nueva de la app (esquema ' + String(d.esquema).slice(0, 5) + ').');
}

/* Respaldo: { errores, advertencias, totalErrores } */
function validarRespaldo(obj, hoyISO) {
  const err = [], adv = [];
  const fin = () => ({ errores: err.slice(0, 15), advertencias: adv, totalErrores: err.length });
  if (!esObjeto(obj)) { err.push('El archivo no es una copia válida.'); return fin(); }
  if (obj.app !== 'mi-kangoo-finanzas') err.push('El archivo no fue creado por Mi Kangoo Finanzas.');
  const d = obj.datos;
  if (!esObjeto(d)) { err.push('La copia no tiene datos.'); return fin(); }
  const esq = obj.esquema === undefined ? 1 : obj.esquema;
  if (esq !== 1 && esq !== 2) { err.push('La copia es de un formato que esta versión no conoce (esquema ' + String(obj.esquema).slice(0, 10) + ').'); return fin(); }
  if (d.esquema !== undefined && d.esquema !== esq) err.push('La versión de los datos no coincide con la del archivo.');
  if (esq === 1) { validarConfigV1(d.config).forEach(x => err.push(x)); adv.push('La copia es de una versión anterior (1.0.x). Se convertirá al formato nuevo sin cambiar tus movimientos.'); }
  else { validarConfig(d.config).forEach(x => err.push(x)); validarPrecios(d.precios, hoyISO).forEach(x => err.push(x)); }
  const em = validarMovimientos(d.movimientos, hoyISO);
  em.forEach(x => err.push(x));
  if (em.length || !Array.isArray(d.movimientos)) return fin();
  const real = resumen(d.movimientos);
  if (!Number.isFinite(real.capital) || Object.values(real.saldos).some(v => !Number.isFinite(v))) err.push('Los saldos calculados no son válidos.');
  const rs = obj.resumen;
  if (rs === undefined) adv.push('La copia no trae resumen de control (fue hecha con la versión 1.0.0). Se verificaron los movimientos uno por uno.');
  else if (!esObjeto(rs)) err.push('El resumen de control está dañado.');
  else {
    if (rs.cantidad !== real.cantidad) err.push('La cantidad de movimientos no coincide con el resumen de control (' + real.cantidad + ' en vez de ' + rs.cantidad + '). El archivo pudo haber sido modificado.');
    if (typeof rs.capital !== 'number' || !(Math.abs(rs.capital - real.capital) <= 0.005)) err.push('El capital no coincide con el resumen de control. El archivo pudo haber sido modificado.');
    const ks = esObjeto(rs.saldos) ? Object.keys(rs.saldos) : null;
    const distinto = k => !Object.prototype.hasOwnProperty.call(real.saldos, k) || typeof rs.saldos[k] !== 'number' || !(Math.abs(rs.saldos[k] - real.saldos[k]) <= 0.005);
    if (!ks || ks.length !== Object.keys(real.saldos).length || ks.some(distinto)) err.push('Los saldos por cuenta no coinciden con el resumen de control.');
    if (esq === 2 && rs.cantidadPrecios !== undefined && Array.isArray(d.precios) && rs.cantidadPrecios !== d.precios.length) err.push('La cantidad de precios no coincide con el resumen de control.');
  }
  Object.entries(real.saldos).forEach(([c, v]) => { if (v < 0) adv.push('La cuenta "' + c + '" queda con saldo negativo.'); });
  if (!err.length) {
    try {
      const est = cargarEstado(d, new Date().toISOString()).estado;
      const e2 = validarEstado(est, hoyISO);
      if (e2.length) err.push('Después de convertir la copia quedan datos inválidos: ' + e2[0]);
      else if (capitalReal(est.movimientos) !== real.capital) err.push('La conversión cambiaría el capital; no se restaura.');
    } catch (x) { err.push('No se pudo convertir la copia: ' + x.message); }
  }
  return fin();
}

/* ---------- CSV seguro para Excel ---------- */
function celdaTexto(s) {
  let t = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t\r＝＋－＠]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}
function celdaNumero(n) { return (typeof n !== 'number' || !Number.isFinite(n)) ? '""' : String(r2(n)).replace('.', ','); }
function generarCSV(movs) {
  const imp = importes(movs);
  const { efectiva, sinEfecto } = analizarAnulaciones(movs);
  const filas = [['Fecha', 'Tipo', 'Monto', 'Importe con signo', 'Cuenta', 'Observaciones', 'Estado', 'Anula a (id)', 'Id', 'Registrado'].map(celdaTexto).join(';')];
  movs.slice().sort((a, b) => (a.fecha + a.registrado).localeCompare(b.fecha + b.registrado)).forEach(m => {
    const est = efectiva.has(m.id) ? 'Anulado' : (sinEfecto.has(m.id) ? 'Corrección duplicada sin efecto' : 'Vigente');
    filas.push([celdaTexto(m.fecha), celdaTexto(TIPOS[m.tipo] ? TIPOS[m.tipo].label : m.tipo), celdaNumero(m.monto), celdaNumero(imp.get(m.id)),
      celdaTexto(m.cuenta), celdaTexto(m.obs), celdaTexto(est), celdaTexto(m.anulaA || ''), celdaTexto(m.id), celdaTexto(m.registrado)].join(';'));
  });
  return '﻿' + filas.join('\r\n');
}
function generarCSVPrecios(precios) {
  const { anulados } = analizarPrecios(precios);
  const filas = [['Fecha de consulta', 'Precio', 'Vehículo', 'Fuente', 'Estado del dato', 'Situación', 'Id', 'Registrado'].map(celdaTexto).join(';')];
  precios.filter(p => p.tipo === 'precio').slice().sort((a, b) => ((a.fecha || '') + a.registrado).localeCompare((b.fecha || '') + b.registrado)).forEach(p => {
    filas.push([celdaTexto(p.fecha || 'desconocida'), celdaNumero(p.precio), celdaTexto(p.descripcion), celdaTexto(p.fuente), celdaTexto(p.estado),
      celdaTexto(anulados.has(p.id) ? 'Anulado' : 'Vigente en el historial'), celdaTexto(p.id), celdaTexto(p.registrado)].join(';'));
  });
  return '﻿' + filas.join('\r\n');
}

/* Montos escritos a la argentina: "400.000", "1.234,56", "400000". */
function parsearMonto(txt) {
  if (typeof txt !== 'string') return NaN;
  let s = txt.trim().replace(/\$/g, '').replace(/\s/g, '');
  if (!s) return NaN;
  if (/,/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (/\./.test(s)) return NaN;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const n = r2(Number(s));
  return Number.isFinite(n) && n <= MAX_MONTO ? n : NaN;
}

const Calc = { TIPOS, ESQUEMA_ACTUAL, DIAS_DESACTUALIZADO, MAX_MONTO, MAX_PLAZO, MAX_PLAZOS, PLAZOS_SUGERIDOS, ESTADOS_PRECIO, MAX_MESES_ESTIMACION,
  r2, indexarPorId, esFechaValida, esMesValido, esMontoValido, esPlazoValido, mesClave, fechaClave, sumarMeses, difMeses, rangoMeses, diasDesde,
  analizarAnulaciones, importes, importeConSigno, idsAnulados, puedeAnular, capitalReal, saldoPorCuenta, resumen, vigentes, porMes, netoDelMes,
  planVigente, ahorroPlaneadoMes, analizarPrecios, historialPrecios, precioVigente, precioAlMes, puedeAnularPrecio, estadoDePrecio,
  variacionPrecioVsCapital, capitalAlFecha, necesarioPara, proyectarMeta, mesesParaAlcanzar, ritmoReal, mesesAlRitmoReal, recomendar,
  serieCapital, serieAportesVsPlan, serieProgreso, comparacionMetas,
  validarConfigV1, validarConfig, validarMovimientos, validarPrecios, validarEstado, validarRespaldo,
  limpiarEstadoV1, migrarV1aV2, limpiarEstadoV2, estadoBase, cargarEstado,
  celdaTexto, generarCSV, generarCSVPrecios, parsearMonto };

if (typeof module !== 'undefined') module.exports = Calc;

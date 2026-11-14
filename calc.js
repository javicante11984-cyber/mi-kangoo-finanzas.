/* Mi Kangoo Finanzas — cálculos y validaciones puras (sin pantalla). Se prueban con Node: node tests/calc.test.js */
'use strict';

const TIPOS = {
  deposito:    { label: 'Depósito',               signo: 1 },
  aguinaldo:   { label: 'Aguinaldo',              signo: 1 },
  rendimiento: { label: 'Rendimiento',            signo: 1 },
  retiro:      { label: 'Retiro',                 signo: -1 },
  comision:    { label: 'Comisión o pérdida',     signo: -1 },
  anulacion:   { label: 'Corrección (anulación)', signo: 0 }
};

const DIAS_DESACTUALIZADO = 30;
const MAX_MONTO = 1e12;            // tope de seguridad: un billón de pesos por movimiento
const MAX_MOVIMIENTOS = 100000;
const ESTADOS_PRECIO = ['VERIFICADO', 'ESTIMADO', 'SIN VERIFICAR'];
const RE_ID = /^[A-Za-z0-9-]{1,64}$/;
const RE_CONTROL = /[\u0000-\u001f\u007f]/;

function r2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

function indexarPorId(movs) {
  const m = {};
  movs.forEach(x => { m[x.id] = x; });
  return m;
}

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

/* ---------- Anulaciones ----------
 * Solo la PRIMERA anulación válida de un movimiento tiene efecto.
 * Cualquier anulación repetida (por ejemplo, de una versión anterior) vale $0 y se informa. */
function analizarAnulaciones(movs) {
  const porId = indexarPorId(movs);
  const efectiva = new Map();   // idOriginal -> idAnulación
  const sinEfecto = new Set();  // ids de anulaciones que no cuentan
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
    if (m.tipo === 'anulacion') {
      res.set(m.id, sinEfecto.has(m.id) ? 0 : -TIPOS[porId[m.anulaA].tipo].signo * porId[m.anulaA].monto);
    } else {
      const t = TIPOS[m.tipo];
      res.set(m.id, t ? t.signo * m.monto : 0);
    }
  });
  return res;
}

/* Compatibilidad: importe de un movimiento dentro de su lista. */
function importeConSigno(mov, movs) { return importes(movs).get(mov.id) || 0; }

function idsAnulados(movs) { return new Set(analizarAnulaciones(movs).efectiva.keys()); }

function puedeAnular(movs, id) {
  const o = movs.find(m => m.id === id);
  if (!o) return { ok: false, motivo: 'El movimiento no existe.' };
  if (o.tipo === 'anulacion') return { ok: false, motivo: 'Una corrección no se puede anular.' };
  if (idsAnulados(movs).has(id)) return { ok: false, motivo: 'Este movimiento ya fue anulado.' };
  return { ok: true };
}

function capitalReal(movs) {
  let s = 0; importes(movs).forEach(v => { s += v; }); return r2(s);
}

function saldoPorCuenta(movs) {
  const imp = importes(movs);
  const res = {};
  movs.forEach(m => { res[m.cuenta] = r2((res[m.cuenta] || 0) + imp.get(m.id)); });
  return res;
}

function netoDelMes(movs, mesAAAAMM) {
  const imp = importes(movs);
  return r2(movs.filter(m => (m.fecha || '').slice(0, 7) === mesAAAAMM).reduce((a, m) => a + imp.get(m.id), 0));
}

function resumen(movs) {
  return { cantidad: movs.length, capital: capitalReal(movs), saldos: saldoPorCuenta(movs) };
}

/* ---------- Fechas y metas ---------- */
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
function aguinaldosEntre(desde, hasta, mesesPago) {
  const n = difMeses(desde, hasta);
  let c = 0;
  for (let i = 1; i <= n; i++) if (mesesPago.includes(Number(sumarMeses(desde, i).slice(5)))) c++;
  return c;
}

/* Proyección hacia una meta. Todo lo proyectado es ESTIMADO: no es dinero disponible. */
function proyectarMeta(capital, cfg, plazoMeses, hoy) {
  const mesHoy = mesClave(hoy);
  const mesObjetivo = sumarMeses(cfg.fechaInicio, plazoMeses);
  const mesesRestantes = Math.max(0, difMeses(mesHoy, mesObjetivo));
  const cantAguinaldos = aguinaldosEntre(mesHoy, mesObjetivo, cfg.aguinaldoMeses);
  const ahorroProyectado = r2(cfg.ahorroMensual * mesesRestantes);
  const aguinaldoProyectado = r2(cfg.aguinaldo * cantAguinaldos);
  const total = r2(capital + ahorroProyectado + aguinaldoProyectado);
  const out = { plazoMeses, mesObjetivo, mesesRestantes, cantAguinaldos, capitalReal: capital,
    ahorroProyectado, aguinaldoProyectado, total, necesario: null, diferencia: null, ahorroMensualNecesario: null };
  if (cfg.precioRef > 0) {
    const necesario = r2(cfg.precioRef + (cfg.reservaEmergencia || 0));
    out.necesario = necesario;
    out.diferencia = r2(total - necesario);
    if (mesesRestantes > 0) out.ahorroMensualNecesario = r2(Math.max(0, (necesario - capital - aguinaldoProyectado) / mesesRestantes));
  }
  return out;
}

function diasDesde(fechaISO, hoy) {
  if (!fechaISO) return null;
  const d = new Date(fechaISO + (fechaISO.length === 10 ? 'T12:00:00' : ''));
  if (isNaN(d)) return null;
  return Math.floor((hoy - d) / 86400000);
}

function estadoPrecio(cfg, hoy) {
  if (!(cfg.precioRef > 0)) return 'SIN DATO';
  const dias = diasDesde(cfg.precioRefFecha, hoy);
  if (dias === null) return 'SIN VERIFICAR';
  if (dias > DIAS_DESACTUALIZADO) return 'DESACTUALIZADO';
  return cfg.precioRefEstado || 'SIN VERIFICAR';
}

/* Motor de recomendación — Etapa 1 (prudente: nunca devuelve CONSIDERAR COMPRA). */
function recomendar(estado, hoy) {
  const cfg = estado.config;
  const movs = estado.movimientos;
  const capital = capitalReal(movs);
  const reserva = cfg.reservaEmergencia || 0;
  const ep = estadoPrecio(cfg, hoy);
  const fmt = n => '$' + Math.round(Math.abs(n)).toLocaleString('es-AR');
  if (!(cfg.precioRef > 0)) return { codigo: 'INFORMACIÓN INSUFICIENTE',
    texto: 'Faltan datos para recomendar. Cargá un precio de referencia de la Kangoo en la pantalla Metas, con la fuente y la fecha en que lo consultaste.' };
  if (movs.length === 0) return { codigo: 'INFORMACIÓN INSUFICIENTE',
    texto: 'Todavía no cargaste movimientos. Tu capital real registrado es $0. Cargá tus ahorros en "Mis ahorros" para empezar a medir tu progreso.' };
  const notaPrecio = ep === 'DESACTUALIZADO' ? ' Ojo: el precio de referencia tiene más de ' + DIAS_DESACTUALIZADO + ' días; volvé a consultarlo.'
    : (ep === 'SIN VERIFICAR' ? ' El precio de referencia está SIN VERIFICAR.' : '');
  if (capital < reserva) return { codigo: 'SEGUIR AHORRANDO',
    texto: 'Primero completá tu reserva de emergencia: te faltan ' + fmt(reserva - capital) + '. La reserva no se usa para comprar el auto.' + notaPrecio };
  const disponible = capital - reserva;
  if (disponible < cfg.precioRef) return { codigo: 'SEGUIR AHORRANDO',
    texto: 'Te faltan ' + fmt(cfg.precioRef - disponible) + ' para llegar al precio de referencia, sin contar tu reserva. Comprar ahora implicaría endeudarte; seguir ahorrando reduce esa deuda.' + notaPrecio };
  return { codigo: 'INVESTIGAR OPORTUNIDAD',
    texto: 'Tu capital disponible ya cubre el precio de referencia. Antes de comprar falta calcular transferencia, seguro, patente y mantenimiento (llega en la Etapa 3). Verificá publicaciones reales y no apures la decisión.' + notaPrecio };
}

/* ---------- Validación estricta ---------- */
function validarConfig(c) {
  const e = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['Falta la configuración.'];
  [['ahorroMensual', 'ahorro mensual'], ['aguinaldo', 'aguinaldo'], ['reservaEmergencia', 'reserva de emergencia'], ['precioRef', 'precio de referencia']]
    .forEach(([k, n]) => { if (!esImporteConfigValido(c[k])) e.push('Configuración: ' + n + ' inválido.'); });
  if (!Array.isArray(c.aguinaldoMeses) || !c.aguinaldoMeses.every(m => m === 6 || m === 12) || new Set(c.aguinaldoMeses).size !== c.aguinaldoMeses.length)
    e.push('Configuración: meses de aguinaldo inválidos.');
  if (!esMesValido(c.fechaInicio)) e.push('Configuración: mes de inicio inválido.');
  ['plazoCorto', 'plazoLargo'].forEach(k => { if (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 120) e.push('Configuración: plazo inválido (' + k + ').'); });
  if (!ESTADOS_PRECIO.includes(c.precioRefEstado)) e.push('Configuración: estado del precio inválido.');
  if (!esTextoValido(c.precioRefDescripcion, 0, 120)) e.push('Configuración: descripción del vehículo inválida.');
  if (!esTextoValido(c.precioRefFuente, 0, 300)) e.push('Configuración: fuente del precio inválida.');
  if (!(c.precioRefFecha === '' || esFechaValida(c.precioRefFecha))) e.push('Configuración: fecha del precio inválida.');
  if (!Array.isArray(c.cuentas) || !c.cuentas.length || c.cuentas.length > 50 || !c.cuentas.every(x => esTextoValido(x, 1, 60) && x.trim() === x)
      || new Set(c.cuentas).size !== c.cuentas.length) e.push('Configuración: lista de cuentas inválida.');
  return e;
}

/* hoyISO: fecha local de hoy 'AAAA-MM-DD'. Se tolera un día por diferencias de zona horaria. */
function validarMovimientos(movs, hoyISO) {
  const e = [];
  if (!Array.isArray(movs)) return ['Faltan los movimientos.'];
  if (movs.length > MAX_MOVIMIENTOS) return ['Demasiados movimientos.'];
  const limite = hoyISO ? fechaClave(new Date(new Date(hoyISO + 'T12:00:00').getTime() + 86400000)) : null;
  const ids = new Set();
  const porId = {};
  movs.forEach((m, i) => {
    const n = 'Movimiento ' + (i + 1) + ': ';
    if (!m || typeof m !== 'object' || Array.isArray(m)) { e.push(n + 'formato inválido.'); return; }
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
  // Referencias de anulación (necesitan todos los ids)
  const anulados = new Set();
  movs.forEach((m, i) => {
    if (!m || m.tipo !== 'anulacion') return;
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

/* Devuelve { errores: [...], advertencias: [...] } */
function validarRespaldo(obj, hoyISO) {
  const err = [], adv = [];
  const fin = () => ({ errores: err.slice(0, 15), advertencias: adv, totalErrores: err.length });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { err.push('El archivo no es una copia válida.'); return fin(); }
  if (obj.app !== 'mi-kangoo-finanzas') err.push('El archivo no fue creado por Mi Kangoo Finanzas.');
  if (obj.esquema !== undefined && obj.esquema !== 1) err.push('La copia es de un formato que esta versión no conoce (esquema ' + String(obj.esquema).slice(0, 10) + ').');
  const d = obj.datos;
  if (!d || typeof d !== 'object' || Array.isArray(d)) { err.push('La copia no tiene datos.'); return fin(); }
  validarConfig(d.config).forEach(x => err.push(x));
  const em = validarMovimientos(d.movimientos, hoyISO);
  em.forEach(x => err.push(x));
  if (em.length || !Array.isArray(d.movimientos)) return fin();
  const cuentasMov = new Set(d.movimientos.map(m => m.cuenta));
  const real = resumen(d.movimientos);
  if (!Number.isFinite(real.capital) || Object.values(real.saldos).some(v => !Number.isFinite(v))) err.push('Los saldos calculados no son válidos.');
  const rs = obj.resumen;
  if (rs === undefined) adv.push('La copia no trae resumen de control (fue hecha con la versión 1.0.0). Se verificaron los movimientos uno por uno.');
  else if (!rs || typeof rs !== 'object') err.push('El resumen de control está dañado.');
  else {
    if (rs.cantidad !== real.cantidad) err.push('La cantidad de movimientos no coincide con el resumen de control (' + real.cantidad + ' en vez de ' + rs.cantidad + '). El archivo pudo haber sido modificado.');
    if (typeof rs.capital !== 'number' || Math.abs(rs.capital - real.capital) > 0.005) err.push('El capital no coincide con el resumen de control. El archivo pudo haber sido modificado.');
    const ks = rs.saldos && typeof rs.saldos === 'object' ? Object.keys(rs.saldos) : null;
    const distinto = k => !Object.prototype.hasOwnProperty.call(real.saldos, k) || typeof rs.saldos[k] !== 'number' || !(Math.abs(rs.saldos[k] - real.saldos[k]) <= 0.005);
    if (!ks || ks.length !== Object.keys(real.saldos).length || ks.some(distinto))
      err.push('Los saldos por cuenta no coinciden con el resumen de control.');
  }
  Object.entries(real.saldos).forEach(([c, v]) => { if (v < 0) adv.push('La cuenta "' + c + '" queda con saldo negativo.'); });
  if (d.config && Array.isArray(d.config.cuentas)) cuentasMov.forEach(c => { if (!d.config.cuentas.includes(c)) adv.push('La cuenta "' + c + '" aparece en movimientos pero no en tu lista de cuentas; se agregará.'); });
  return fin();
}

/* Deja solo los campos conocidos (descarta cualquier dato extra de un archivo). */
function limpiarEstado(d, base) {
  const c = d.config || {};
  const cfg = {};
  Object.keys(base.config).forEach(k => { cfg[k] = c[k] !== undefined ? c[k] : base.config[k]; });
  const movimientos = (d.movimientos || []).map(m => ({ id: m.id, fecha: m.fecha, tipo: m.tipo, monto: m.monto, cuenta: m.cuenta,
    obs: typeof m.obs === 'string' ? m.obs : '', registrado: m.registrado, anulaA: m.tipo === 'anulacion' ? m.anulaA : null }));
  movimientos.forEach(m => { if (!cfg.cuentas.includes(m.cuenta)) cfg.cuentas = cfg.cuentas.concat([m.cuenta]); });
  return {
    esquema: 1,
    rev: Number.isInteger(d.rev) && d.rev >= 0 ? d.rev : 0,
    creado: esISOValido(d.creado) ? d.creado : base.creado,
    actualizado: esISOValido(d.actualizado) ? d.actualizado : base.actualizado,
    ultimoRespaldo: esISOValido(d.ultimoRespaldo) ? d.ultimoRespaldo : null,
    config: cfg,
    movimientos
  };
}

/* ---------- CSV seguro para Excel ----------
 * Un texto que empieza con = + - @ (o tabulación / retorno) puede ser interpretado como fórmula.
 * Se le antepone un apóstrofo para que Excel lo muestre como texto. */
function celdaTexto(s) {
  let t = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t\r＝＋－＠]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}
function celdaNumero(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '""';
  return String(r2(n)).replace('.', ',');
}
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

/* Interpreta montos escritos a la argentina: "400.000", "1.234,56", "400000". */
function parsearMonto(txt) {
  if (typeof txt !== 'string') return NaN;
  let s = txt.trim().replace(/\$/g, '').replace(/\s/g, '');
  if (!s) return NaN;
  if (/,/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (/\./.test(s)) return NaN; // "400.00" es ambiguo: los decimales van con coma
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const n = r2(Number(s));
  return Number.isFinite(n) && n <= MAX_MONTO ? n : NaN;
}

const Calc = { TIPOS, DIAS_DESACTUALIZADO, MAX_MONTO, ESTADOS_PRECIO, r2, indexarPorId, esFechaValida, esMesValido, esMontoValido,
  analizarAnulaciones, importes, importeConSigno, idsAnulados, puedeAnular, capitalReal, saldoPorCuenta, netoDelMes, resumen,
  mesClave, fechaClave, sumarMeses, difMeses, aguinaldosEntre, proyectarMeta, diasDesde, estadoPrecio, recomendar,
  validarConfig, validarMovimientos, validarRespaldo, limpiarEstado, celdaTexto, generarCSV, parsearMonto };

if (typeof module !== 'undefined') module.exports = Calc;

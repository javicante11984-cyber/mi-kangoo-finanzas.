/* Pruebas de cálculos y validaciones. Ejecutar desde la carpeta de la app:  node --test tests/
 * No necesita instalar nada (usa el corredor de pruebas incluido en Node 18+). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../calc.js');

const HOY = '2026-11-14';
const REG = '2026-11-14T12:00:00.000Z';
const mov = (id, tipo, monto, extra = {}) => Object.assign({ id, fecha: '2026-11-01', tipo, monto, cuenta: 'Caja', obs: '', registrado: REG, anulaA: null }, extra);
const anul = (id, original, extra = {}) => mov(id, 'anulacion', original.monto, Object.assign({ anulaA: original.id, cuenta: original.cuenta, fecha: original.fecha }, extra));
const configBase = () => ({ ahorroMensual: 400000, aguinaldo: 600000, aguinaldoMeses: [6, 12], fechaInicio: '2026-11', plazoCorto: 18, plazoLargo: 24,
  reservaEmergencia: 0, precioRef: 0, precioRefDescripcion: '', precioRefFuente: '', precioRefFecha: '', precioRefEstado: 'SIN VERIFICAR', cuentas: ['Caja', 'MP'] });
const respaldo = (movs, cfg = configBase(), conResumen = true) => {
  const o = { app: 'mi-kangoo-finanzas', version: '1.0.1', esquema: 1, exportado: REG, datos: { esquema: 1, rev: 3, config: cfg, movimientos: movs } };
  if (conResumen) o.resumen = C.resumen(movs);
  return o;
};

/* ---------------- Capital ---------------- */
test('capital: suma depósitos, aguinaldos y rendimientos; resta retiros y comisiones', () => {
  const movs = [mov('a', 'deposito', 400000), mov('b', 'aguinaldo', 600000), mov('c', 'rendimiento', 1234.56, { cuenta: 'MP' }),
    mov('d', 'retiro', 50000), mov('e', 'comision', 500)];
  assert.equal(C.capitalReal(movs), 400000 + 600000 + 1234.56 - 50000 - 500);
  assert.deepEqual(C.saldoPorCuenta(movs), { Caja: 949500, MP: 1234.56 });
});
test('capital: sin movimientos es $0', () => { assert.equal(C.capitalReal([]), 0); });
test('capital: decimales sin error de redondeo (0,1 + 0,2)', () => {
  assert.equal(C.capitalReal([mov('a', 'deposito', 0.1), mov('b', 'deposito', 0.2)]), 0.3);
});
test('ahorro del mes: solo cuenta movimientos de ese mes', () => {
  const movs = [mov('a', 'deposito', 400000), mov('b', 'deposito', 100, { fecha: '2026-10-31' })];
  assert.equal(C.netoDelMes(movs, '2026-11'), 400000);
  assert.equal(C.netoDelMes(movs, '2026-10'), 100);
});

/* ---------------- Anulaciones ---------------- */
test('anulación: compensa exactamente el movimiento anulado (depósito y retiro)', () => {
  const d = mov('a', 'deposito', 99999), r = mov('b', 'retiro', 30000);
  const movs = [mov('x', 'deposito', 400000), d, r, anul('c', d), anul('e', r)];
  assert.equal(C.capitalReal(movs), 400000);
  assert.deepEqual([...C.idsAnulados(movs)].sort(), ['a', 'b']);
});
test('anulación duplicada: la segunda no tiene efecto en el capital', () => {
  const d = mov('a', 'deposito', 1000);
  const movs = [mov('x', 'deposito', 5000), d, anul('c1', d), anul('c2', d)];
  assert.equal(C.capitalReal(movs), 5000);
  const { sinEfecto } = C.analizarAnulaciones(movs);
  assert.ok(sinEfecto.has('c2') && !sinEfecto.has('c1'));
});
test('anulación inválida (de otra corrección, de sí misma o huérfana) no tiene efecto', () => {
  const d = mov('a', 'deposito', 1000);
  const c1 = anul('c1', d);
  const movs = [d, c1, mov('c2', 'anulacion', 1000, { anulaA: 'c1' }), mov('c3', 'anulacion', 5, { anulaA: 'c3' }), mov('c4', 'anulacion', 7, { anulaA: 'zzz' })];
  assert.equal(C.capitalReal(movs), 0);
});
test('puedeAnular: rechaza repetidos, correcciones e inexistentes', () => {
  const d = mov('a', 'deposito', 1000);
  assert.equal(C.puedeAnular([d], 'a').ok, true);
  assert.equal(C.puedeAnular([d, anul('c', d)], 'a').ok, false);
  assert.equal(C.puedeAnular([d, anul('c', d)], 'c').ok, false);
  assert.equal(C.puedeAnular([d], 'no-existe').ok, false);
});

/* ---------------- Validación de respaldos ---------------- */
test('respaldo válido se acepta sin errores', () => {
  const d = mov('a', 'deposito', 400000), r = mov('b', 'retiro', 1000);
  const v = C.validarRespaldo(respaldo([d, r, anul('c', r, { fecha: '2026-11-10' })]), HOY);
  assert.deepEqual(v.errores, []);
});
test('respaldo de la versión 1.0.0 (sin resumen) se acepta con advertencia', () => {
  const v = C.validarRespaldo(respaldo([mov('a', 'deposito', 1)], configBase(), false), HOY);
  assert.deepEqual(v.errores, []);
  assert.equal(v.advertencias.length, 1);
});

const casosInvalidos = [
  ['monto infinito (1e400 en el JSON)', () => JSON.parse(JSON.stringify(respaldo([mov('a', 'deposito', 1)], configBase(), false)).replace('"monto":1', '"monto":1e400'))],
  ['monto como texto', () => respaldo([mov('a', 'deposito', '400000')], configBase(), false)],
  ['monto negativo', () => respaldo([mov('a', 'deposito', -5)], configBase(), false)],
  ['monto cero', () => respaldo([mov('a', 'deposito', 0)], configBase(), false)],
  ['monto con 3 decimales', () => respaldo([mov('a', 'deposito', 1.234)], configBase(), false)],
  ['monto gigante', () => respaldo([mov('a', 'deposito', 1e15)], configBase(), false)],
  ['tipo desconocido', () => respaldo([mov('a', 'regalo', 5)], configBase(), false)],
  ['tipo heredado de Object (constructor)', () => respaldo([mov('a', 'constructor', 5)], configBase(), false)],
  ['fecha inexistente 30/02', () => respaldo([mov('a', 'deposito', 5, { fecha: '2026-02-30' })], configBase(), false)],
  ['fecha con formato incorrecto', () => respaldo([mov('a', 'deposito', 5, { fecha: '14/11/2026' })], configBase(), false)],
  ['fecha futura', () => respaldo([mov('a', 'deposito', 5, { fecha: '2027-01-01' })], configBase(), false)],
  ['identificador repetido', () => respaldo([mov('a', 'deposito', 5), mov('a', 'deposito', 6)], configBase(), false)],
  ['identificador con caracteres raros', () => respaldo([mov('=cmd|x', 'deposito', 5)], configBase(), false)],
  ['identificador vacío', () => respaldo([mov('', 'deposito', 5)], configBase(), false)],
  ['anulación duplicada', () => { const d = mov('a', 'deposito', 5); return respaldo([d, anul('b', d), anul('c', d)], configBase(), false); }],
  ['anulación huérfana', () => respaldo([mov('b', 'anulacion', 5, { anulaA: 'zzz' })], configBase(), false)],
  ['anulación de sí misma', () => respaldo([mov('b', 'anulacion', 5, { anulaA: 'b' })], configBase(), false)],
  ['anulación de una corrección', () => { const d = mov('a', 'deposito', 5); return respaldo([d, anul('b', d), mov('c', 'anulacion', 5, { anulaA: 'b' })], configBase(), false); }],
  ['anulación con monto distinto', () => { const d = mov('a', 'deposito', 5); return respaldo([d, anul('b', d, { monto: 6 })], configBase(), false); }],
  ['anulación con cuenta distinta', () => { const d = mov('a', 'deposito', 5); return respaldo([d, anul('b', d, { cuenta: 'MP' })], configBase(), false); }],
  ['anulación anterior al original', () => { const d = mov('a', 'deposito', 5); return respaldo([d, anul('b', d, { fecha: '2026-10-01' })], configBase(), false); }],
  ['movimiento común con anulaA', () => respaldo([mov('a', 'deposito', 5), mov('b', 'deposito', 5, { anulaA: 'a' })], configBase(), false)],
  ['cuenta vacía', () => respaldo([mov('a', 'deposito', 5, { cuenta: '' })], configBase(), false)],
  ['registrado inválido', () => respaldo([mov('a', 'deposito', 5, { registrado: 'ayer' })], configBase(), false)],
  ['resumen: capital alterado', () => { const o = respaldo([mov('a', 'deposito', 5)]); o.resumen.capital = 999; return o; }],
  ['resumen: cantidad alterada', () => { const o = respaldo([mov('a', 'deposito', 5)]); o.resumen.cantidad = 2; return o; }],
  ['resumen: saldo por cuenta alterado', () => { const o = respaldo([mov('a', 'deposito', 5)]); o.resumen.saldos.Caja = 4; return o; }],
  ['resumen: monto editado a mano en el archivo', () => { const o = respaldo([mov('a', 'deposito', 5)]); o.datos.movimientos[0].monto = 5000; return o; }],
  ['config: plazo 0', () => { const c = configBase(); c.plazoCorto = 0; return respaldo([], c); }],
  ['config: plazo con decimales', () => { const c = configBase(); c.plazoLargo = 2.5; return respaldo([], c); }],
  ['config: precio negativo', () => { const c = configBase(); c.precioRef = -1; return respaldo([], c); }],
  ['config: ahorro como texto', () => { const c = configBase(); c.ahorroMensual = '400000'; return respaldo([], c); }],
  ['config: estado de precio inventado', () => { const c = configBase(); c.precioRefEstado = 'CONFIRMADO'; return respaldo([], c); }],
  ['config: mes de aguinaldo 7', () => { const c = configBase(); c.aguinaldoMeses = [7]; return respaldo([], c); }],
  ['config: mes de inicio inválido', () => { const c = configBase(); c.fechaInicio = '2026-13'; return respaldo([], c); }],
  ['config: sin cuentas', () => { const c = configBase(); c.cuentas = []; return respaldo([], c); }],
  ['config: falta', () => { const o = respaldo([]); delete o.datos.config; return o; }],
  ['otra aplicación', () => { const o = respaldo([]); o.app = 'otra'; return o; }],
  ['esquema desconocido', () => { const o = respaldo([]); o.esquema = 2; return o; }],
  ['movimientos no es una lista', () => { const o = respaldo([]); o.datos.movimientos = {}; return o; }],
  ['archivo vacío / null', () => null],
  ['archivo es una lista', () => []]
];
casosInvalidos.forEach(([nombre, crear]) => {
  test('respaldo inválido se rechaza: ' + nombre, () => {
    const v = C.validarRespaldo(crear(), HOY);
    assert.ok(v.errores.length > 0, 'debió rechazarse');
  });
});
test('el caso "monto infinito" realmente contiene Infinity tras leer el JSON', () => {
  const o = JSON.parse(JSON.stringify(respaldo([mov('a', 'deposito', 1)])).replace('"monto":1', '"monto":1e400'));
  assert.equal(o.datos.movimientos[0].monto, Infinity);
});

test('limpiarEstado descarta campos desconocidos y __proto__', () => {
  const base = { creado: REG, actualizado: REG, config: configBase() };
  const sucio = JSON.parse('{"config":' + JSON.stringify(configBase()) + ',"movimientos":[{"id":"a","fecha":"2026-11-01","tipo":"deposito","monto":5,"cuenta":"Nueva","registrado":"' + REG + '","malicioso":"x","__proto__":{"admin":true}}],"__proto__":{"x":1},"extra":1}');
  const limpio = C.limpiarEstado(sucio, base);
  assert.equal(limpio.extra, undefined);
  assert.equal(limpio.movimientos[0].malicioso, undefined);
  assert.equal(({}).admin, undefined);
  assert.ok(limpio.config.cuentas.includes('Nueva'), 'agrega cuentas usadas en movimientos');
  assert.equal(limpio.movimientos[0].anulaA, null);
});

/* ---------------- CSV ---------------- */
test('CSV: neutraliza fórmulas (= + - @ tab) y escapa comillas y saltos de línea', () => {
  const movs = [mov('a', 'deposito', 1, { cuenta: '=HYPERLINK("http://x","clic")', obs: '+SUM(1,2)' }),
    mov('b', 'deposito', 2, { cuenta: '@cmd', obs: '-2+3' }), mov('c', 'retiro', 1.5, { cuenta: '\tTab', obs: 'línea1\nlínea2 "comillas"' })];
  const csv = C.generarCSV(movs);
  assert.ok(csv.startsWith('﻿'), 'BOM para que Excel lea acentos');
  const filas = csv.slice(1).split('\r\n');
  assert.equal(filas.length, 4);
  assert.ok(csv.includes('"\'=HYPERLINK(""http://x"",""clic"")"'));
  assert.ok(csv.includes('"\'+SUM(1,2)"'));
  assert.ok(csv.includes('"\'@cmd"'));
  assert.ok(csv.includes('"\'-2+3"'));
  assert.ok(csv.includes('"\'\tTab"'));
  assert.ok(csv.includes('"línea1 línea2 ""comillas"""'));
  assert.ok(filas[3].includes(';1,5;-1,5;'), 'números con coma decimal y signo');
  // Ninguna celda de texto empieza con un carácter peligroso
  filas.forEach(f => f.split(';').forEach(celda => { if (celda.startsWith('"')) assert.ok(!/^"[=+\-@\t]/.test(celda), 'celda peligrosa: ' + celda); }));
});
test('CSV: marca anulados y correcciones repetidas', () => {
  const d = mov('a', 'deposito', 1);
  const csv = C.generarCSV([d, anul('b', d), anul('c', d)]);
  assert.ok(csv.includes('"Anulado"') && csv.includes('"Corrección duplicada sin efecto"'));
});

/* ---------------- Montos escritos ---------------- */
test('parsearMonto: formatos argentinos y rechazos', () => {
  assert.equal(C.parsearMonto('400.000'), 400000);
  assert.equal(C.parsearMonto('$ 1.234,56'), 1234.56);
  assert.equal(C.parsearMonto('400000'), 400000);
  ['abc', '4.00', '-5', '1,234', '', '1e5', 'Infinity', '9'.repeat(400)].forEach(t => assert.ok(Number.isNaN(C.parsearMonto(t)), t));
});

/* ---------------- Metas ---------------- */
test('metas: 18 y 24 meses desde nov-2026 cuentan 3 y 4 aguinaldos', () => {
  const hoy = new Date(2026, 10, 14);
  const p18 = C.proyectarMeta(0, configBase(), 18, hoy);
  assert.equal(p18.mesObjetivo, '2028-05'); assert.equal(p18.cantAguinaldos, 3); assert.equal(p18.total, 9000000);
  assert.equal(C.proyectarMeta(0, configBase(), 24, hoy).cantAguinaldos, 4);
});

/* ---------------- Versión y archivos offline ---------------- */
test('version.js y sw.js declaran la misma versión, y la caché lista archivos que existen', () => {
  const raiz = path.join(__dirname, '..');
  const v = fs.readFileSync(path.join(raiz, 'version.js'), 'utf8').match(/MKF_VERSION\s*=\s*'([^']+)'/)[1];
  const sw = fs.readFileSync(path.join(raiz, 'sw.js'), 'utf8');
  assert.match(sw, new RegExp('Versión: ' + v.replace(/\./g, '\\.') + '\\b'));
  const lista = sw.match(/ARCHIVOS = \[([\s\S]*?)\]/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  lista.filter(f => f !== './').forEach(f => assert.ok(fs.existsSync(path.join(raiz, f)), 'falta ' + f));
  ['index.html', 'styles.css', 'version.js', 'calc.js', 'app.js'].forEach(f => assert.ok(lista.includes('./' + f), f + ' no está en la caché'));
});

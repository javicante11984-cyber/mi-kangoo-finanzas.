#!/usr/bin/env python3
"""
Pruebas de punta a punta en un Chrome real (sin ventana), con la app servida por HTTP local.

Requisitos (en una PC, no hacen falta para usar la app):
  pip install playwright   y   python -m playwright install chromium
  (o tener Google Chrome y pasar --chrome RUTA)

Uso, desde la carpeta de la app:
  python tests/e2e_navegador.py
  python tests/e2e_navegador.py --chrome "/usr/bin/google-chrome"

Cada prueba informa OK o FALLÓ con el motivo. El código de salida es 1 si alguna falla.
"""
import argparse, asyncio, json, os, shutil, sys, tempfile, threading, traceback, re
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright

RAIZ_APP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
RESULTADOS = []


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *a):
        pass


def servir(carpeta):
    srv = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=carpeta))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, 'http://127.0.0.1:%d/' % srv.server_address[1]


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


LEER_DB = """(clave) => new Promise((res, rej) => {
  const r = indexedDB.open('mi-kangoo-finanzas', 1);
  r.onsuccess = () => { const db = r.result; const q = db.transaction('kv').objectStore('kv').get(clave);
    q.onsuccess = () => { res(q.result === undefined ? null : q.result); db.close(); }; q.onerror = () => rej(q.error); };
  r.onerror = () => rej(r.error);
})"""
ROMPER_PUT = """() => { window.__putOriginal = window.__putOriginal || IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('fallo simulado', 'QuotaExceededError'); }; }"""
ARREGLAR_PUT = """() => { if (window.__putOriginal) IDBObjectStore.prototype.put = window.__putOriginal; }"""


class App:
    def __init__(self, ctx, url, errores):
        self.ctx, self.url, self.errores = ctx, url, errores
        self.pg = None

    async def abrir(self, hash_='inicio'):
        self.pg = await self.ctx.new_page()
        self.pg.on('pageerror', lambda e: self.errores.append('pageerror: ' + str(e)))
        self.pg.on('dialog', lambda d: asyncio.ensure_future(d.accept('prueba automatizada') if d.type == 'prompt' else d.accept()))
        await self.pg.goto(self.url + 'index.html#' + hash_)
        await self.pg.wait_for_selector('nav a.activo')
        await self.pg.wait_for_function("document.querySelector('#main').innerText.length > 50")
        return self

    async def ir(self, p):
        await self.pg.evaluate("p => { location.hash = '#' + p; }", p)
        await self.pg.wait_for_function("p => document.querySelector('nav a.activo')?.dataset.p === p", arg=p)
        await self.pg.wait_for_timeout(150)

    async def db(self, clave='estado'):
        return await self.pg.evaluate(LEER_DB, clave)

    async def toast(self):
        return await self.pg.inner_text('#toast')

    async def cargar(self, tipo, monto, cuenta_nueva=None, obs=''):
        await self.ir('ahorros')
        await self.pg.select_option('select[name=tipo]', tipo)
        await self.pg.fill('input[name=monto]', monto)
        if cuenta_nueva:
            await self.pg.select_option('select[name=cuenta]', '__otra')
            await self.pg.fill('input[name=otra]', cuenta_nueva)
        await self.pg.fill('input[name=obs]', obs)
        await self.pg.click('#fMov button[type=submit]')
        await self.pg.wait_for_timeout(400)


async def prueba(nombre, coro):
    try:
        await coro
        RESULTADOS.append((nombre, True, ''))
        print('OK      ' + nombre)
    except Exception as e:
        RESULTADOS.append((nombre, False, str(e)))
        print('FALLÓ   ' + nombre + '\n        ' + (str(e) or traceback.format_exc()).replace('\n', '\n        '))


# ---------------------------------------------------------------- pruebas
async def t_persistencia(b, url):
    errores = []
    ctx = await b.new_context()
    a = await App(ctx, url, errores).abrir()
    await a.cargar('deposito', '400.000')
    check('guardado' in await a.toast(), 'no apareció el aviso de guardado')
    await a.cargar('aguinaldo', '600.000')
    await a.cargar('retiro', '1.234,56')
    await a.pg.reload(); await a.pg.wait_for_selector('nav a.activo')
    await a.ir('inicio')
    cap = await a.pg.inner_text('#capital')
    check(cap.replace('\xa0', ' ') == '$ 998.765', 'capital tras recargar: ' + cap)
    a2 = await App(ctx, url, errores).abrir('ahorros')  # otra pestaña
    check(await a2.pg.inner_text('#cantMov') == '3', 'la otra pestaña no ve los 3 movimientos')
    st = await a.db()
    check(len(st['movimientos']) == 3 and st['rev'] >= 3, 'IndexedDB no tiene los 3 movimientos / rev: %s' % st.get('rev'))
    check(not errores, 'errores en la página: %s' % errores)
    await ctx.close()


async def t_anulacion_unica(b, url):
    errores = []
    ctx = await b.new_context()
    a = await App(ctx, url, errores).abrir()
    await a.cargar('deposito', '400.000')
    await a.cargar('retiro', '30.000')
    st = await a.db()
    id_retiro = [m for m in st['movimientos'] if m['tipo'] == 'retiro'][0]['id']
    # 1) doble clic rápido sobre "Corregir"
    await a.pg.dblclick('[data-corregir="%s"]' % id_retiro)
    await a.pg.wait_for_timeout(800)
    # 2) dos llamadas simultáneas por código
    await a.pg.evaluate("id => Promise.all([corregir(id), corregir(id)])", id_retiro)
    await a.pg.wait_for_timeout(500)
    # 3) llamada posterior sobre un movimiento ya anulado
    r = await a.pg.evaluate("id => corregir(id)", id_retiro)
    check(r is False, 'permitió anular un movimiento ya anulado')
    st = await a.db()
    anuls = [m for m in st['movimientos'] if m['tipo'] == 'anulacion']
    check(len(anuls) == 1, 'se guardaron %d anulaciones del mismo movimiento' % len(anuls))
    await a.ir('inicio')
    cap = (await a.pg.inner_text('#capital')).replace('\xa0', ' ')
    check(cap == '$ 400.000', 'capital después de anular el retiro: ' + cap)
    await a.ir('ahorros')
    check(await a.pg.locator('[data-corregir="%s"]' % id_retiro).count() == 0, 'sigue el botón Corregir en un anulado')
    check(not errores, 'errores en la página: %s' % errores)
    await ctx.close()


async def t_fallo_al_guardar(b, url):
    errores = []
    ctx = await b.new_context()
    a = await App(ctx, url, errores).abrir()
    await a.cargar('deposito', '100.000')
    antes = await a.db()
    await a.pg.evaluate(ROMPER_PUT)
    await a.cargar('deposito', '777.777', obs='no debe guardarse')
    t = await a.toast()
    check('No se guardó' in t, 'no avisó el fallo; aviso: ' + t)
    check(await a.pg.inner_text('#cantMov') == '1', 'la pantalla muestra el movimiento no guardado')
    check(await a.pg.input_value('input[name=monto]') == '777.777', 'se perdió lo escrito en el formulario')
    # fallo al anular
    id1 = antes['movimientos'][0]['id']
    await a.pg.click('[data-corregir="%s"]' % id1)
    await a.pg.wait_for_timeout(500)
    check(await a.pg.locator('.mov.anulado').count() == 0, 'la pantalla muestra una anulación no guardada')
    # fallo al guardar Metas
    await a.ir('metas')
    await a.pg.fill('input[name=ahorroMensual]', '1')
    await a.pg.click('#fCfg button[type=submit]'); await a.pg.wait_for_timeout(400)
    check('No se guardó' in await a.toast(), 'no avisó el fallo en Metas')
    await a.pg.evaluate(ARREGLAR_PUT)
    despues = await a.db()
    check(json.dumps(antes, sort_keys=True) == json.dumps(despues, sort_keys=True), 'los datos guardados cambiaron pese al fallo')
    await a.pg.reload(); await a.pg.wait_for_selector('nav a.activo')
    await a.ir('ahorros')
    check(await a.pg.inner_text('#cantMov') == '1', 'tras recargar aparece un movimiento que falló')
    # y después del fallo se puede seguir guardando normalmente
    await a.cargar('deposito', '5')
    check(await a.pg.inner_text('#cantMov') == '2', 'no se pudo guardar después de recuperarse')
    check(not errores, 'errores en la página: %s' % errores)
    await ctx.close()


async def t_conflicto_pestanas(b, url):
    errores = []
    ctx = await b.new_context()
    a = await App(ctx, url, errores).abrir()
    bb = await App(ctx, url, errores).abrir()
    await a.cargar('deposito', '1.000')
    await bb.cargar('deposito', '2.000')
    check('otra ventana' in await bb.toast(), 'la segunda pestaña no detectó el conflicto: ' + await bb.toast())
    st = await a.db()
    check(len(st['movimientos']) == 1 and st['movimientos'][0]['monto'] == 1000, 'una pestaña pisó los datos de la otra')
    await bb.pg.click('#banner button'); await bb.pg.wait_for_timeout(300)
    await bb.cargar('deposito', '2.000')
    st = await a.db()
    check(len(st['movimientos']) == 2, 'después de recargar no se pudo guardar')
    await ctx.close()


async def t_restauracion(b, url, tmp):
    errores = []
    ctx = await b.new_context(accept_downloads=True)
    a = await App(ctx, url, errores).abrir()
    await a.cargar('deposito', '400.000')
    await a.cargar('retiro', '10.000')
    await a.cargar('rendimiento', '1.234,56', cuenta_nueva='Plazo fijo')
    await a.ir('respaldo')
    async with a.pg.expect_download() as di:
        await a.pg.click('#bExp')
    d = await di.value
    ruta = os.path.join(tmp, 'respaldo.json'); await d.save_as(ruta)
    copia = json.load(open(ruta, encoding='utf-8'))
    check(copia['resumen']['cantidad'] == 3 and abs(copia['resumen']['capital'] - 391234.56) < 0.001, 'resumen de control incorrecto: %s' % copia['resumen'])
    # "Otro dispositivo": contexto nuevo, sin datos
    ctx2 = await b.new_context()
    o = await App(ctx2, url, errores).abrir('ahorros')
    await o.cargar('deposito', '5')  # dato previo que debe poder recuperarse con "Deshacer"
    await o.ir('respaldo')
    await o.pg.set_input_files('#fileImp', ruta)
    await o.pg.wait_for_selector('#bConfImp')
    await o.pg.click('#bConfImp')
    await o.pg.wait_for_function("location.hash === '#inicio'")
    await o.pg.wait_for_timeout(300)
    cap = (await o.pg.inner_text('#capital')).replace('\xa0', ' ')
    check(cap == '$ 391.235', 'capital restaurado: ' + cap)
    st = await o.db()
    check([m['id'] for m in st['movimientos']] == [m['id'] for m in copia['datos']['movimientos']], 'los movimientos restaurados no son los mismos')
    previo = await o.db('respaldo_previo')
    check(previo and len(previo['datos']['movimientos']) == 1, 'no se guardaron los datos anteriores para deshacer')
    await o.ir('respaldo')
    await o.pg.click('#bDeshacer'); await o.pg.wait_for_timeout(500)
    st = await o.db()
    check(len(st['movimientos']) == 1 and st['movimientos'][0]['monto'] == 5, 'deshacer no devolvió los datos anteriores')
    check(not errores, 'errores en la página: %s' % errores)
    await ctx2.close(); await ctx.close()
    return copia


def variantes_invalidas(copia):
    import copy
    v = []
    def mod(nombre, f):
        c = copy.deepcopy(copia); f(c); v.append((nombre, json.dumps(c, ensure_ascii=False)))
    movs = lambda c: c['datos']['movimientos']
    mod('monto alterado (no coincide con el resumen)', lambda c: movs(c)[0].__setitem__('monto', 9999999))
    mod('monto texto', lambda c: (movs(c)[0].__setitem__('monto', '400000'), c.pop('resumen')))
    mod('monto negativo', lambda c: (movs(c)[0].__setitem__('monto', -400000), c.pop('resumen')))
    mod('fecha inválida', lambda c: (movs(c)[0].__setitem__('fecha', '2026-02-30'), c.pop('resumen')))
    mod('fecha futura', lambda c: (movs(c)[0].__setitem__('fecha', '2099-01-01'), c.pop('resumen')))
    mod('tipo desconocido', lambda c: (movs(c)[0].__setitem__('tipo', 'premio'), c.pop('resumen')))
    mod('id repetido', lambda c: (movs(c)[1].__setitem__('id', movs(c)[0]['id']), c.pop('resumen')))
    def dup_anul(c):
        o = movs(c)[0]
        for i in (1, 2):
            movs(c).append({'id': 'anul-%d' % i, 'fecha': o['fecha'], 'tipo': 'anulacion', 'monto': o['monto'], 'cuenta': o['cuenta'], 'obs': '', 'registrado': o['registrado'], 'anulaA': o['id']})
        c['resumen'] = None; c.pop('resumen')
    mod('anulación duplicada', dup_anul)
    mod('anulación huérfana', lambda c: (movs(c).append({'id': 'x1', 'fecha': '2026-11-01', 'tipo': 'anulacion', 'monto': 5, 'cuenta': 'Caja de ahorro', 'obs': '', 'registrado': '2026-11-01T00:00:00Z', 'anulaA': 'no-existe'}), c.pop('resumen')))
    mod('configuración inválida', lambda c: c['datos']['config'].__setitem__('plazoCorto', 0))
    mod('saldo por cuenta alterado', lambda c: c['resumen']['saldos'].__setitem__('Caja de ahorro', 1))
    v.append(('monto infinito (1e400)', json.dumps(copia).replace('"monto": %s' % json.dumps(copia['datos']['movimientos'][0]['monto']), '"monto": 1e400', 1)))
    v.append(('JSON roto', '{"app": "mi-kangoo-finanzas", '))
    v.append(('archivo de otra app', json.dumps({'app': 'otra', 'datos': {}})))
    return v


async def t_restauracion_rechazada(b, url, tmp, copia):
    errores = []
    ctx = await b.new_context()
    a = await App(ctx, url, errores).abrir()
    await a.cargar('deposito', '123')
    antes = json.dumps(await a.db(), sort_keys=True)
    fallas = []
    for i, (nombre, contenido) in enumerate(variantes_invalidas(copia)):
        ruta = os.path.join(tmp, 'mala_%d.json' % i)
        open(ruta, 'w', encoding='utf-8').write(contenido)
        await a.ir('respaldo')
        await a.pg.set_input_files('#fileImp', ruta)
        await a.pg.wait_for_timeout(300)
        txt = await a.pg.inner_text('#impPrev')
        if await a.pg.locator('#bConfImp').count() > 0 or ('No se puede' not in txt):
            fallas.append(nombre)
    check(not fallas, 'se aceptaron copias inválidas: %s' % fallas)
    check(json.dumps(await a.db(), sort_keys=True) == antes, 'los datos cambiaron al rechazar copias')
    check(not errores, 'errores en la página: %s' % errores)
    await ctx.close()


async def t_fallo_al_restaurar(b, url, tmp):
    errores = []
    ctx = await b.new_context()
    a = await App(ctx, url, errores).abrir()
    await a.cargar('deposito', '50')
    antes = json.dumps(await a.db(), sort_keys=True)
    await a.ir('respaldo')
    await a.pg.set_input_files('#fileImp', os.path.join(tmp, 'respaldo.json'))
    await a.pg.wait_for_selector('#bConfImp')
    await a.pg.evaluate(ROMPER_PUT)
    await a.pg.click('#bConfImp'); await a.pg.wait_for_timeout(500)
    check(await a.pg.locator('#impFallo').count() == 1, 'no avisó que la restauración falló')
    await a.pg.evaluate(ARREGLAR_PUT)
    check(json.dumps(await a.db(), sort_keys=True) == antes, 'los datos cambiaron pese al fallo')
    check(await a.db('respaldo_previo') is None, 'se escribió el respaldo previo sin completar la restauración (no es atómico)')
    await a.ir('inicio')
    check((await a.pg.inner_text('#capital')).replace('\xa0', ' ') == '$ 50', 'la pantalla muestra datos no restaurados')
    check(not errores, 'errores en la página: %s' % errores)
    await ctx.close()


async def t_csv(b, url, tmp):
    errores = []
    ctx = await b.new_context(accept_downloads=True)
    a = await App(ctx, url, errores).abrir()
    await a.cargar('deposito', '100', cuenta_nueva='=HYPERLINK("http://ejemplo.invalid","clic")', obs='+SUM(1;2)')
    await a.cargar('deposito', '200', obs='@cmd')
    await a.cargar('retiro', '1,50', obs='-2+3')
    await a.ir('respaldo')
    async with a.pg.expect_download() as di:
        await a.pg.click('#bCsv')
    ruta = os.path.join(tmp, 'mov.csv'); await (await di.value).save_as(ruta)
    raw = open(ruta, 'rb').read()
    check(raw.startswith(b'\xef\xbb\xbf'), 'falta BOM UTF-8')
    txt = raw.decode('utf-8-sig')
    filas = txt.split('\r\n')
    check(len(filas) == 4, 'cantidad de filas: %d' % len(filas))
    peligrosas = [c for f in filas for c in f.split(';') if re.match(r'^"[=+\-@\t]', c) or re.match(r'^[=+@\t]', c)]
    check(not peligrosas, 'celdas que Excel ejecutaría: %s' % peligrosas)
    for esperado in ['"\'=HYPERLINK(""http://ejemplo.invalid"",""clic"")"', '"\'+SUM(1;2)"', '"\'@cmd"', '"\'-2+3"', ';1,5;-1,5;']:
        check(esperado in txt, 'no se encontró ' + esperado)
    await ctx.close()


async def t_offline_y_actualizacion(b, url, carpeta):
    errores = []
    ctx = await b.new_context()
    a = await App(ctx, url, errores).abrir()
    await a.pg.wait_for_function("navigator.serviceWorker.controller !== null", timeout=10000)
    await a.cargar('deposito', '321')
    claves = await a.pg.evaluate("caches.keys()")
    check(claves == ['mkf-1.0.1'], 'cachés: %s' % claves)
    # Sin conexión
    await ctx.set_offline(True)
    await a.pg.reload(); await a.pg.wait_for_selector('nav a.activo')
    await a.ir('ahorros')
    check(await a.pg.inner_text('#cantMov') == '1', 'sin conexión no muestra los datos')
    await ctx.set_offline(False)
    # Publicar una "versión nueva" en el servidor
    for f in ('version.js', 'sw.js'):
        p = os.path.join(carpeta, f); s = open(p, encoding='utf-8').read().replace('1.0.1', '1.0.2-prueba'); open(p, 'w', encoding='utf-8').write(s)
    p = os.path.join(carpeta, 'app.js'); open(p, 'a', encoding='utf-8').write('\nwindow.__marcaNueva = true;\n')
    await a.pg.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
    await a.pg.wait_for_selector('#banner:not([hidden])', timeout=10000)
    check('versión nueva' in await a.pg.inner_text('#banner'), 'no se ofreció la actualización')
    check(await a.pg.evaluate("self.MKF_VERSION") == '1.0.1', 'la versión cambió sin que el usuario lo pidiera')
    # Una pestaña nueva sigue recibiendo la versión vieja completa (no mezcla archivos)
    a2 = await App(ctx, url, errores).abrir()
    check(await a2.pg.evaluate("self.MKF_VERSION") == '1.0.1' and not await a2.pg.evaluate("!!window.__marcaNueva"), 'se mezclaron archivos de dos versiones')
    await a2.pg.close()
    async with a.pg.expect_navigation():
        await a.pg.click('#banner button')
    await a.pg.wait_for_selector('nav a.activo')
    check(await a.pg.evaluate("self.MKF_VERSION") == '1.0.2-prueba', 'no se aplicó la versión nueva')
    check(await a.pg.evaluate("!!window.__marcaNueva"), 'app.js no se actualizó junto con la versión')
    claves = await a.pg.evaluate("caches.keys()")
    check(claves == ['mkf-1.0.2-prueba'], 'no se borró la caché vieja: %s' % claves)
    await a.ir('ahorros')
    check(await a.pg.inner_text('#cantMov') == '1', 'se perdieron datos al actualizar')
    check(not errores, 'errores en la página: %s' % errores)
    await ctx.close()


ESCRIBIR_DB = """(v) => new Promise((res, rej) => {
  const r = indexedDB.open('mi-kangoo-finanzas', 1);
  r.onsuccess = () => { const db = r.result; const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, 'estado');
    tx.oncomplete = () => { db.close(); res(); }; tx.onabort = () => rej(tx.error); };
})"""


async def t_migracion_100(b, url):
    """Datos guardados por la versión 1.0.0 (sin 'rev', con una anulación repetida por doble toque)."""
    errores = []
    ctx = await b.new_context()
    a = await App(ctx, url, errores).abrir()
    dep = {'id': 'dep-1', 'fecha': '2026-11-02', 'tipo': 'deposito', 'monto': 400000, 'cuenta': 'Caja de ahorro', 'obs': '', 'registrado': '2026-11-02T12:00:00.000Z', 'anulaA': None}
    ret = {'id': 'ret-1', 'fecha': '2026-11-03', 'tipo': 'retiro', 'monto': 30000, 'cuenta': 'Caja de ahorro', 'obs': '', 'registrado': '2026-11-03T12:00:00.000Z', 'anulaA': None}
    an = lambda i: {'id': 'an-%d' % i, 'fecha': '2026-11-04', 'tipo': 'anulacion', 'monto': 30000, 'cuenta': 'Caja de ahorro', 'obs': 'Corrección', 'registrado': '2026-11-04T12:00:0%d.000Z' % i, 'anulaA': 'ret-1'}
    viejo = {'version': 1, 'esquema': 1, 'creado': '2026-11-01T12:00:00.000Z', 'actualizado': '2026-11-04T12:00:00.000Z', 'ultimoRespaldo': None,
             'config': {'ahorroMensual': 400000, 'aguinaldo': 600000, 'aguinaldoMeses': [6, 12], 'fechaInicio': '2026-11', 'plazoCorto': 18, 'plazoLargo': 24,
                        'reservaEmergencia': 0, 'precioRef': 0, 'precioRefDescripcion': '', 'precioRefFuente': '', 'precioRefFecha': '', 'precioRefEstado': 'SIN VERIFICAR',
                        'cuentas': ['Caja de ahorro', 'Efectivo']},
             'movimientos': [dep, ret, an(1), an(2)]}
    await a.pg.evaluate(ESCRIBIR_DB, viejo)
    await a.pg.reload(); await a.pg.wait_for_selector('nav a.activo'); await a.ir('inicio')
    cap = (await a.pg.inner_text('#capital')).replace('\xa0', ' ')
    check(cap == '$ 400.000', 'la anulación repetida se contó dos veces: ' + cap)
    check('Revisá tus datos' in await a.pg.inner_text('#main'), 'no se avisó del problema en los datos viejos')
    await a.cargar('deposito', '1.000')
    check('guardado' in await a.toast(), 'no se puede seguir guardando con datos de la 1.0.0: ' + await a.toast())
    st = await a.db()
    check(len(st['movimientos']) == 5 and st['rev'] == 1, 'migración incorrecta: rev=%s' % st.get('rev'))
    await a.ir('ahorros')
    check('CORRECCIÓN REPETIDA' in await a.pg.inner_text('#main'), 'no se marca la corrección repetida')
    check(not errores, 'errores en la página: %s' % errores)
    await ctx.close()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chrome', default=None, help='ruta a Chrome/Chromium (opcional)')
    args = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix='mkf-pruebas-')
    carpeta = os.path.join(tmp, 'app')
    shutil.copytree(RAIZ_APP, carpeta, ignore=shutil.ignore_patterns('tests', '*.zip'))
    srv, url = servir(carpeta)
    # servidor aparte para la prueba de actualización (se modifican sus archivos)
    carpeta2 = os.path.join(tmp, 'app2'); shutil.copytree(carpeta, carpeta2)
    srv2, url2 = servir(carpeta2)
    try:
        async with async_playwright() as p:
            opts = {'args': ['--no-sandbox']}
            if args.chrome: opts['executable_path'] = args.chrome
            b = await p.chromium.launch(**opts)
            await prueba('Persistencia: los datos siguen tras recargar y en otra pestaña', t_persistencia(b, url))
            await prueba('Capital y anulaciones: no se puede anular dos veces (doble clic y llamadas simultáneas)', t_anulacion_unica(b, url))
            await prueba('Fallo al guardar: no se muestra como guardado y no cambia nada', t_fallo_al_guardar(b, url))
            await prueba('Dos pestañas: una no pisa los datos de la otra', t_conflicto_pestanas(b, url))
            copia = {}
            async def _rest():
                copia.update(await t_restauracion(b, url, tmp))
            await prueba('Restauración: copia válida en "otro dispositivo" + deshacer', _rest())
            if copia:
                await prueba('Restauración: se rechazan copias inválidas o alteradas', t_restauracion_rechazada(b, url, tmp, copia))
                await prueba('Fallo al restaurar: no cambia nada (atómico)', t_fallo_al_restaurar(b, url, tmp))
            await prueba('Datos de la versión 1.0.0: se leen, se marca la anulación repetida y se puede seguir guardando', t_migracion_100(b, url))
            await prueba('Exportación CSV: protegida contra fórmulas de Excel', t_csv(b, url, tmp))
            await prueba('Service worker: funciona sin conexión y se actualiza solo cuando el usuario lo acepta', t_offline_y_actualizacion(b, url2, carpeta2))
            await b.close()
    finally:
        srv.shutdown(); srv2.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    ok = sum(1 for r in RESULTADOS if r[1])
    print('\nResultado: %d de %d pruebas OK' % (ok, len(RESULTADOS)))
    sys.exit(0 if ok == len(RESULTADOS) else 1)


if __name__ == '__main__':
    asyncio.run(main())

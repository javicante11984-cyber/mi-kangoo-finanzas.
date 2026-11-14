/* Mi Kangoo Finanzas — gráficos propios en SVG.
 * Sin librerías ni servicios externos: funcionan sin internet.
 * Las funciones de dibujo son puras (devuelven texto SVG) y se prueban con Node.
 * La interacción (tooltip con dedo, mouse o teclado) está en activar(). */
'use strict';

const Graficos = (function () {
  const COLOR = {
    real: '#2a78d6',        // capital real: azul sólido
    proyectado: '#6da7ec',  // estimación: mismo azul, más claro y punteado
    precio: '#eb6834',      // precio de la Kangoo: naranja
    plan: '#52514e',        // plan: gris oscuro (marca fina)
    grilla: '#e6e9ed', eje: '#c3c9d0', texto: '#52514e', superficie: '#ffffff'
  };
  const W = 360, H = 220, M = { izq: 62, der: 14, sup: 14, inf: 30 };
  const REG = {};   // datos de cada gráfico para el tooltip y las pruebas

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = n => Math.round(n * 10) / 10;
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const MESES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function etiquetaMes(aaaamm) { const [y, m] = aaaamm.split('-'); return MESES[+m - 1] + ' ' + y.slice(2); }
  function mesLargo(aaaamm) { const [y, m] = aaaamm.split('-'); return MESES_LARGO[+m - 1] + ' ' + y; }

  function pesos(n) { return '$ ' + Math.round(n).toLocaleString('es-AR'); }
  function pesosCorto(n) {
    const a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e6) return s + '$ ' + (Math.round(a / 1e5) / 10).toLocaleString('es-AR') + ' M';
    if (a >= 1e3) return s + '$ ' + Math.round(a / 1e3).toLocaleString('es-AR') + ' mil';
    return s + '$ ' + Math.round(a).toLocaleString('es-AR');
  }

  /* Escala "linda": de 3 a 6 marcas redondas que cubren [min, max]. */
  function marcas(min, max, n = 4) {
    if (!(isFinite(min) && isFinite(max))) return [0, 1];
    if (min === max) { if (max === 0) return [0, 1]; min = Math.min(0, min); max = Math.max(0, max); if (min === max) max = min + 1; }
    const paso0 = (max - min) / n;
    const pot = Math.pow(10, Math.floor(Math.log10(paso0)));
    const f = paso0 / pot;
    const paso = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pot;
    const ini = Math.floor(min / paso) * paso, fin = Math.ceil(max / paso) * paso;
    const out = [];
    for (let v = ini; v <= fin + paso / 2; v += paso) out.push(Math.round(v / paso) * paso);
    return out;
  }

  function marco(id, titulo, ys, sy, xLabels, xs) {
    let s = '<svg class="grafico" id="' + esc(id) + '" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="group" tabindex="0" aria-label="' + esc(titulo) + '. Tocá o usá las flechas para ver cada valor." focusable="true">';
    s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + COLOR.superficie + '"/>';
    ys.forEach(v => {
      const y = num(sy(v));
      s += '<line x1="' + M.izq + '" x2="' + (W - M.der) + '" y1="' + y + '" y2="' + y + '" stroke="' + (v === 0 ? COLOR.eje : COLOR.grilla) + '" stroke-width="1"/>';
      s += '<text x="' + (M.izq - 6) + '" y="' + num(y + 4) + '" text-anchor="end" font-size="11" fill="' + COLOR.texto + '">' + esc(pesosCorto(v)) + '</text>';
    });
    // Etiquetas del eje X sin encimarse: la última siempre (alineada a la derecha), las demás solo si hay lugar.
    const n = xLabels.length, ultima = n - 1, sep = 50;
    const paso = Math.max(1, Math.ceil(n / 5));
    let previa = -Infinity;
    xLabels.forEach((l, i) => {
      if (i !== ultima && i % paso !== 0) return;
      if (i !== ultima && (xs[i] - previa < sep || xs[ultima] - xs[i] < sep)) return;
      const ancla = i === ultima && n > 1 ? 'end' : (i === 0 && n > 1 ? 'start' : 'middle');
      const x = i === ultima && n > 1 ? Math.min(xs[i] + 6, W - 2) : (i === 0 && n > 1 ? Math.max(xs[i] - 6, M.izq - 8) : xs[i]);
      s += '<text x="' + num(x) + '" y="' + (H - 10) + '" text-anchor="' + ancla + '" font-size="11" fill="' + COLOR.texto + '">' + esc(l) + '</text>';
      previa = xs[i];
    });
    return s;
  }
  function cierre(id, xs) {
    return '<line class="cruz" x1="0" x2="0" y1="' + M.sup + '" y2="' + (H - M.inf) + '" stroke="' + COLOR.texto + '" stroke-width="1" visibility="hidden"/>' +
      '<rect class="zona" x="' + M.izq + '" y="0" width="' + (W - M.izq - M.der) + '" height="' + H + '" fill="transparent"/></svg>';
  }
  function vacio(id, texto) {
    REG[id] = null;
    return '<p class="graf-vacio" id="' + esc(id) + '">' + esc(texto) + '</p>';
  }

  /*
   * Gráfico de líneas.
   * series: [{ nombre, valores: [número|null], color, discontinua, escalon, tipo: 'real'|'estimado'|'precio' }]
   */
  function lineas(o) {
    const { id, titulo, meses, series } = o;
    const todos = [];
    series.forEach(s => s.valores.forEach(v => { if (v !== null && v !== undefined && isFinite(v)) todos.push(v); }));
    if (!meses.length || !todos.length) return vacio(id, o.vacio || 'Todavía no hay datos para este gráfico.');
    const mx = Math.max(...todos), mn = Math.min(0, ...todos);
    const ys = marcas(mn, mx + (mx - mn) * 0.06);
    const y0 = ys[0], y1 = ys[ys.length - 1];
    const ancho = W - M.izq - M.der, alto = H - M.sup - M.inf;
    const n = meses.length;
    const xs = meses.map((_, i) => n === 1 ? M.izq + ancho / 2 : M.izq + i * ancho / (n - 1));
    const sy = v => M.sup + alto - (v - y0) / (y1 - y0) * alto;
    let s = marco(id, titulo, ys, sy, meses.map(etiquetaMes), xs);
    if (o.indiceHoy !== undefined && o.indiceHoy !== null && o.indiceHoy < n - 1) {
      const x = num(xs[o.indiceHoy]);
      s += '<line x1="' + x + '" x2="' + x + '" y1="' + M.sup + '" y2="' + (H - M.inf) + '" stroke="' + COLOR.eje + '" stroke-width="1" stroke-dasharray="3 3"/>';
      s += '<text x="' + num(x + 4) + '" y="' + (M.sup + 10) + '" font-size="11" fill="' + COLOR.texto + '">hoy</text>';
    }
    series.forEach(se => {
      let d = '', abierto = false, prev = null;
      se.valores.forEach((v, i) => {
        if (v === null || v === undefined || !isFinite(v)) { abierto = false; prev = null; return; }
        const x = num(xs[i]), y = num(sy(v));
        if (!abierto) { d += 'M' + x + ' ' + y; abierto = true; }
        else if (se.escalon) d += 'H' + x + 'V' + y;
        else d += 'L' + x + ' ' + y;
        prev = v;
      });
      if (!d) return;
      s += '<path class="serie" data-serie="' + esc(se.nombre) + '" d="' + d + '" fill="none" stroke="' + se.color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"' + (se.discontinua ? ' stroke-dasharray="6 4"' : '') + '/>';
      // un único punto visible en el último valor (no un número en cada punto)
      let ult = -1; se.valores.forEach((v, i) => { if (v !== null && v !== undefined && isFinite(v)) ult = i; });
      if (ult >= 0 && se.punto !== false) s += '<circle cx="' + num(xs[ult]) + '" cy="' + num(sy(se.valores[ult])) + '" r="4" fill="' + se.color + '" stroke="' + COLOR.superficie + '" stroke-width="2"/>';
      void prev;
    });
    s += cierre(id, xs);
    REG[id] = {
      xs, titulos: meses.map(mesLargo),
      filas: meses.map((_, i) => series.filter(se => se.valores[i] !== null && se.valores[i] !== undefined)
        .map(se => ({ nombre: se.nombre + (se.notaEn && se.notaEn(i) ? ' (' + se.notaEn(i) + ')' : ''), valor: se.valores[i], color: se.color, discontinua: !!se.discontinua })))
    };
    return s;
  }

  /*
   * Gráfico de barras por categoría.
   * barras: [{ nombre, valores, color, apilada: true|false, clara: bool }] — las "apiladas" se suman (con 2px de separación)
   * marcas: [{ nombre, valores, color }] — una línea fina horizontal sobre cada categoría (ej. el plan)
   * referencia: { nombre, valor, color } — línea horizontal en todo el ancho (ej. lo necesario)
   */
  function barras(o) {
    const { id, titulo, categorias } = o;
    const bs = o.barras || [], mk = o.marcas || [];
    const n = categorias.length;
    const tot = [];
    for (let i = 0; i < n; i++) {
      let pos = 0, neg = 0;
      bs.forEach(b => { const v = b.valores[i] || 0; if (v >= 0) pos += v; else neg += v; });
      tot.push(pos, neg);
      mk.forEach(m => { if (isFinite(m.valores[i])) tot.push(m.valores[i]); });
    }
    if (o.referencia && isFinite(o.referencia.valor)) tot.push(o.referencia.valor);
    if (!n || !tot.some(v => v !== 0)) return vacio(id, o.vacio || 'Todavía no hay datos para este gráfico.');
    const mxb = Math.max(0, ...tot), mnb = Math.min(0, ...tot);
    const ys = marcas(mnb, mxb + (mxb - mnb) * 0.06);
    const y0 = ys[0], y1 = ys[ys.length - 1];
    const ancho = W - M.izq - M.der, alto = H - M.sup - M.inf;
    const banda = ancho / n;
    const xs = categorias.map((_, i) => M.izq + banda * (i + 0.5));
    const sy = v => M.sup + alto - (v - y0) / (y1 - y0) * alto;
    const anchoBarra = Math.max(4, Math.min(34, banda * 0.62));
    let s = marco(id, titulo, ys, sy, categorias, xs);
    bs.forEach((b, k) => {
      if (!b.clara) return;
      b._patron = 'ray-' + String(id).replace(/[^A-Za-z0-9-]/g, '') + '-' + k;
      s += '<defs><pattern id="' + b._patron + '" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="' + b.color + '" fill-opacity="0.35"/><line x1="0" y1="0" x2="0" y2="6" stroke="' + b.color + '" stroke-width="2"/></pattern></defs>';
    });
    for (let i = 0; i < n; i++) {
      const x = num(xs[i] - anchoBarra / 2);
      let basePos = 0, baseNeg = 0;
      const segs = bs.map(b => ({ b, v: b.valores[i] || 0 })).filter(z => z.v !== 0);
      segs.forEach((z, k) => {
        const desde = z.v >= 0 ? basePos : baseNeg, hasta = desde + z.v;
        if (z.v >= 0) basePos = hasta; else baseNeg = hasta;
        const esUltimo = !segs.slice(k + 1).some(w => (w.v >= 0) === (z.v >= 0));
        let ya = sy(desde), yb = sy(hasta);
        if (k > 0) { if (z.v >= 0) ya -= 2; else ya += 2; }   // 2px de separación entre segmentos
        const top = Math.min(ya, yb), h = Math.abs(yb - ya);
        if (h < 0.5) return;
        const sel = o.seleccion === i;
        s += rectRedondeado(x, num(top), num(anchoBarra), num(h), esUltimo ? 4 : 0, z.v >= 0, z.b.color, z.b.clara ? z.b._patron : null, sel, z.b.nombre);
      });
      mk.forEach(m => {
        const v = m.valores[i]; if (!isFinite(v)) return;
        const y = num(sy(v));
        s += '<line class="marca" data-serie="' + esc(m.nombre) + '" x1="' + num(x - 3) + '" x2="' + num(x + anchoBarra + 3) + '" y1="' + y + '" y2="' + y + '" stroke="' + m.color + '" stroke-width="2.5" stroke-linecap="round"/>';
      });
    }
    if (o.referencia && isFinite(o.referencia.valor)) {
      const y = num(sy(o.referencia.valor));
      s += '<line class="referencia" x1="' + M.izq + '" x2="' + (W - M.der) + '" y1="' + y + '" y2="' + y + '" stroke="' + o.referencia.color + '" stroke-width="2" stroke-dasharray="6 4"/>';
    }
    s += cierre(id, xs);
    REG[id] = {
      xs, titulos: o.titulos || categorias,
      filas: categorias.map((_, i) => bs.map(b => ({ nombre: b.nombre, valor: b.valores[i] || 0, color: b.color, clara: !!b.clara }))
        .concat(mk.map(m => ({ nombre: m.nombre, valor: m.valores[i], color: m.color, marca: true })))
        .concat(o.referencia ? [{ nombre: o.referencia.nombre, valor: o.referencia.valor, color: o.referencia.color, discontinua: true }] : [])
        .concat(o.extras ? o.extras(i) : []))
    };
    return s;
  }
  function rectRedondeado(x, y, w, h, r, haciaArriba, color, patron, sel, nombre) {
    r = Math.min(r, w / 2, h);
    let d;
    if (r <= 0) d = 'M' + x + ' ' + y + 'h' + w + 'v' + h + 'h' + (-w) + 'Z';
    else if (haciaArriba) d = 'M' + x + ' ' + num(y + h) + 'V' + num(y + r) + 'Q' + x + ' ' + y + ' ' + num(x + r) + ' ' + y + 'H' + num(x + w - r) + 'Q' + num(x + w) + ' ' + y + ' ' + num(x + w) + ' ' + num(y + r) + 'V' + num(y + h) + 'Z';
    else d = 'M' + x + ' ' + y + 'V' + num(y + h - r) + 'Q' + x + ' ' + num(y + h) + ' ' + num(x + r) + ' ' + num(y + h) + 'H' + num(x + w - r) + 'Q' + num(x + w) + ' ' + num(y + h) + ' ' + num(x + w) + ' ' + num(y + h - r) + 'V' + y + 'Z';
    return '<path class="barra" data-serie="' + esc(nombre) + '" d="' + d + '" fill="' + (patron ? 'url(#' + patron + ')' : color) + '"' +
      (sel ? ' stroke="#0b0b0b" stroke-width="2"' : (patron ? ' stroke="' + color + '" stroke-width="1"' : '')) + '/>';
  }

  /* Leyenda HTML (siempre presente si hay 2 o más series). */
  function leyenda(items) {
    return '<ul class="leyenda">' + items.map(it => '<li><svg width="22" height="12" aria-hidden="true">' +
      (it.forma === 'barra' ? '<rect x="2" y="1" width="18" height="10" rx="2" fill="' + it.color + '"' + (it.clara ? ' fill-opacity="0.45" stroke="' + it.color + '"' : '') + '/>'
        : '<line x1="1" x2="21" y1="6" y2="6" stroke="' + it.color + '" stroke-width="2.5"' + (it.discontinua ? ' stroke-dasharray="5 3"' : '') + '/>') +
      '</svg>' + esc(it.nombre) + (it.etiqueta ? ' <span class="tag tag-' + esc(it.etiqueta.toLowerCase().replace(/\s/g, '-')) + '">' + esc(it.etiqueta) + '</span>' : '') + '</li>').join('') + '</ul>';
  }

  /* Tabla con los mismos números (para leer sin tocar el gráfico). */
  function tabla(cabeceras, filas) {
    return '<details class="tabla-datos"><summary>Ver los números</summary><div class="tabla-scroll"><table><thead><tr>' + cabeceras.map(c => '<th>' + esc(c) + '</th>').join('') +
      '</tr></thead><tbody>' + filas.map(f => '<tr>' + f.map((c, i) => '<td' + (i ? ' class="num"' : '') + '>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></details>';
  }

  /* ---------- Interacción ---------- */
  function activar(raiz) {
    raiz.querySelectorAll('svg.grafico').forEach(svg => {
      if (svg.dataset.activo) return;
      svg.dataset.activo = '1';
      const caja = svg.parentElement;
      let tip = caja.querySelector('.graf-tip');
      if (!tip) { tip = document.createElement('div'); tip.className = 'graf-tip'; tip.hidden = true; caja.appendChild(tip); }
      const cruz = svg.querySelector('.cruz');
      let actual = -1;
      const mostrar = i => {
        const d = REG[svg.id]; if (!d) return;
        i = Math.max(0, Math.min(d.xs.length - 1, i)); actual = i;
        cruz.setAttribute('x1', d.xs[i]); cruz.setAttribute('x2', d.xs[i]); cruz.setAttribute('visibility', 'visible');
        tip.textContent = '';
        const t = document.createElement('div'); t.className = 'graf-tip-titulo'; t.textContent = d.titulos[i]; tip.appendChild(t);
        d.filas[i].forEach(f => {
          const fila = document.createElement('div'); fila.className = 'graf-tip-fila';
          const k = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); k.setAttribute('width', '16'); k.setAttribute('height', '10');
          const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          l.setAttribute('x1', '1'); l.setAttribute('x2', '15'); l.setAttribute('y1', '5'); l.setAttribute('y2', '5'); l.setAttribute('stroke', f.color); l.setAttribute('stroke-width', '3');
          if (f.discontinua || f.clara) l.setAttribute('stroke-dasharray', '4 2');
          k.appendChild(l);
          const v = document.createElement('b'); v.textContent = typeof f.valor === 'number' ? pesos(f.valor) : String(f.valor);
          const n = document.createElement('span'); n.textContent = ' ' + f.nombre;
          fila.append(k, v, n); tip.appendChild(fila);
        });
        tip.hidden = false;
        const rs = svg.getBoundingClientRect(), rc = caja.getBoundingClientRect();
        const px = rs.left - rc.left + d.xs[i] / W * rs.width;
        const izquierda = px > rc.width / 2;
        tip.style.left = izquierda ? '' : Math.round(px + 10) + 'px';
        tip.style.right = izquierda ? Math.round(rc.width - px + 10) + 'px' : '';
      };
      const ocultar = () => { tip.hidden = true; cruz.setAttribute('visibility', 'hidden'); actual = -1; };
      const indice = ev => {
        const d = REG[svg.id]; if (!d) return -1;
        const r = svg.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width * W;
        let mejor = 0; d.xs.forEach((xx, i) => { if (Math.abs(xx - x) < Math.abs(d.xs[mejor] - x)) mejor = i; });
        return mejor;
      };
      svg.addEventListener('pointermove', ev => mostrar(indice(ev)));
      svg.addEventListener('pointerdown', ev => mostrar(indice(ev)));
      svg.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse') ocultar(); });
      svg.addEventListener('focus', () => mostrar(actual >= 0 ? actual : (REG[svg.id] ? REG[svg.id].xs.length - 1 : 0)));
      svg.addEventListener('blur', ocultar);
      svg.addEventListener('keydown', ev => {
        if (ev.key === 'ArrowLeft') { mostrar(actual - 1); ev.preventDefault(); }
        else if (ev.key === 'ArrowRight') { mostrar(actual + 1); ev.preventDefault(); }
        else if (ev.key === 'Escape') ocultar();
      });
    });
  }

  return { COLOR, W, H, REG, marcas, pesosCorto, etiquetaMes, mesLargo, lineas, barras, leyenda, tabla, activar, esc };
})();

if (typeof module !== 'undefined') module.exports = Graficos;

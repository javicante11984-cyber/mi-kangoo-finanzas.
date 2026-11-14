# Mi Kangoo Finanzas — v1.1.1

PWA (aplicación web instalable) sin servidor propio ni servicios pagos.
Tus datos quedan **solo en el dispositivo** donde la usás (IndexedDB del navegador).
No hay sincronización entre celular y computadora: para pasar datos, usá la copia de seguridad.

## Archivos (todos sueltos, sin subcarpetas: se suben juntos de una vez)
- `index.html`, `styles.css` — la página y su diseño
- `version.js` — número de versión (único lugar, junto con la línea "Versión" de `sw.js`)
- `calc.js` — cálculos, migración de datos, validación de copias, CSV seguro
- `graficos.js` — gráficos propios en SVG (sin librerías ni internet)
- `instalacion.js` — revisión de instalación (Respaldo → "Revisar instalación")
- `app.js` — pantallas, guardado, exportar/importar
- `sw.js` — permite usar la app sin internet y actualizarla de forma segura
- `manifest.webmanifest` — datos para instalarla
- `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `favicon-48.png`, `icon.svg` — ícono propio
- `tests/` — pruebas automatizadas (opcional: no hace falta subirla a GitHub)

## Publicarla gratis con GitHub Pages (una sola vez, desde la computadora)
1. Creá una cuenta en https://github.com (gratis).
2. Botón **New repository** → nombre `mi-kangoo` → **Public** → **Create repository**.
3. Hacé clic en **uploading an existing file** y arrastrá todos los archivos sueltos de esta carpeta
   (la carpeta `tests` es opcional). Luego **Commit changes**.
4. Entrá a **Settings → Pages**. En *Branch* elegí `main` y `/ (root)` → **Save**.
5. Esperá 1–2 minutos. Tu dirección será `https://TU-USUARIO.github.io/mi-kangoo/`.

El repositorio público contiene solo el código, nunca tus datos.

## Probar en Android
1. Abrí la dirección en **Chrome**.
2. Menú ⋮ → **Instalar app** (o **Agregar a pantalla principal**).
3. Abrila desde el ícono. Cargá un movimiento, cerrala y volvé a abrirla: debe seguir ahí.
4. Activá el modo avión y abrila: debe funcionar igual.

## Probar en Windows
1. Abrí la dirección en **Chrome** o **Edge**.
2. Hacé clic en el ícono de instalar en la barra de direcciones (o menú → *Instalar Mi Kangoo Finanzas*).
3. Queda en el menú Inicio como una app más.

## Pasar datos del celular a la PC (o al revés)
Respaldo → **Descargar copia de seguridad** (o **Enviar copia**) → en el otro equipo:
Respaldo → **Elegir archivo de copia** → **Sí, restaurar**. Esto reemplaza los datos de ese equipo
(se guardan los anteriores para poder deshacer).

## Publicar la versión 1.1.1 (procedimiento seguro)
**Antes de empezar, en el celular:** Respaldo → **Descargar copia de seguridad** y mandala a Drive o a tu mail.

1. En la PC, descomprimí el ZIP.
2. En GitHub, entrá a tu repositorio → **Add file → Upload files**.
3. Seleccioná **todos los archivos sueltos** (15 archivos: 1 `.html`, 1 `.css`, 7 `.js`, 1 `.webmanifest`, 5 `.png` y 1 `.svg`; los `.md` son opcionales).
   Los íconos ahora están sueltos, junto a `index.html`: no hay que subir carpetas.
   **No borres nada en GitHub**: la carpeta vieja `icons` (si existe) puede quedar, no molesta.
4. Tocá **Commit changes** y esperá que en la pestaña **Actions** la publicación quede en verde (1 a 3 minutos).
5. **Comprobación desde la PC:** abrí `https://TU-USUARIO.github.io/TU-REPO/icon-192.png`. Tiene que verse el ícono
   (la furgoneta con la moneda). Si ves "404", el archivo no se subió: repetí el paso 3 con ese archivo.
6. En el celular, abrí la app como siempre (el acceso directo viejo sirve). Tocá **Actualizar ahora** cuando aparezca.
   Si no aparece, cerrala del todo y volvé a abrirla.
7. Verificá: Respaldo → al pie dice **v1.1.1**; misma cantidad de movimientos y mismo capital que antes.
8. Respaldo → **Revisar instalación**. Tiene que decir "Todo listo". Si algo sale con ❌, dice qué archivo subir.
9. Recién ahí: mantené apretado el acceso directo viejo (la "G" gris) → **Quitar**. Eso borra solo el acceso
   directo, **no tus datos** (los datos están guardados en Chrome para esta dirección).
10. En Chrome, abrí la app → menú ⋮ → **Instalar app** (o el botón "Instalar app" en Respaldo).
11. Abrí la app desde el ícono nuevo y comprobá otra vez movimientos y capital.

**Nunca** uses "Borrar datos del sitio", "Borrar almacenamiento" ni "Borrar datos de navegación" de Chrome: eso sí borra
tus movimientos. Si en algún paso algo no coincide, no cargues datos nuevos y restaurá la copia del paso inicial.

Para publicar una versión futura: cambiá el número en `version.js` y en la línea "Versión" de `sw.js`.

## Pruebas automatizadas (opcional, en una PC)
- Cálculos, migración y gráficos (necesita Node.js 18 o superior): `node --test tests/calc.test.js tests/graficos.test.js`
- Navegador real (necesita Python y Playwright): `pip install playwright`, `python -m playwright install chromium`,
  luego `python tests/e2e_navegador.py` (incluye la actualización real desde la 1.0.1, guardada en `tests/fixtures/`)

# Mi Kangoo Finanzas — v1.1.0

PWA (aplicación web instalable) sin servidor propio ni servicios pagos.
Tus datos quedan **solo en el dispositivo** donde la usás (IndexedDB del navegador).
No hay sincronización entre celular y computadora: para pasar datos, usá la copia de seguridad.

## Archivos
- `index.html` — estructura de la app
- `styles.css` — diseño
- `version.js` — número de versión (único lugar, junto con la línea "Versión" de `sw.js`)
- `calc.js` — cálculos (capital, metas, estimaciones, migración de datos, validación de copias, CSV seguro)
- `graficos.js` — gráficos propios en SVG (sin librerías ni internet)
- `app.js` — pantallas, guardado, exportar/importar
- `sw.js` — permite usar la app sin internet
- `manifest.webmanifest` + `icons/` — permite instalarla

## Publicarla gratis con GitHub Pages (una sola vez, desde la computadora)
1. Creá una cuenta en https://github.com (gratis).
2. Botón **New repository** → nombre `mi-kangoo` → **Public** → **Create repository**.
3. Hacé clic en **uploading an existing file** y arrastrá TODO el contenido de esta carpeta
   (incluida la carpeta `icons`). Luego **Commit changes**.
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

## Actualizar la app en GitHub Pages (por ejemplo, de 1.0.1 a 1.1.0)
1. **Antes**, en el celular: Respaldo → Descargar copia de seguridad (y guardala fuera del teléfono).
2. En la PC, descomprimí el ZIP nuevo.
3. En GitHub, entrá a tu repositorio → **Add file → Upload files**.
4. Arrastrá **todos** los archivos de la carpeta (incluida `graficos.js`, que es nueva, y la carpeta `icons`).
   La carpeta `tests` no hace falta subirla. Tocá **Commit changes**.
5. Esperá a que termine la publicación: pestaña **Actions**, la tarea "pages build and deployment" en verde (1 a 3 minutos).
6. En el celular, abrí la app. Aparece "Hay una versión nueva" → **Actualizar ahora**.
   Si no aparece, cerrala del todo (sacala de las apps recientes) y volvé a abrirla; puede hacer falta dos veces.
7. Comprobá: Respaldo → al pie dice **v1.1.0**; misma cantidad de movimientos y mismo capital que antes.

La 1.1 convierte tus datos al formato nuevo **sin cambiar ningún movimiento** y guarda una copia intacta de los
datos anteriores (Respaldo → "Datos de antes de la actualización"). Si algo no se ve bien, no cargues nada nuevo,
descargá esa copia y avisá.

Para publicar una versión futura: cambiá el número en `version.js` y en la línea "Versión" de `sw.js`.

## Pruebas automatizadas (opcional, en una PC)
- Cálculos, migración y gráficos (necesita Node.js 18 o superior): `node --test tests/calc.test.js tests/graficos.test.js`
- Navegador real (necesita Python y Playwright): `pip install playwright`, `python -m playwright install chromium`,
  luego `python tests/e2e_navegador.py` (incluye la actualización real desde la 1.0.1, guardada en `tests/fixtures/`)

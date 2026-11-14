# Mi Kangoo Finanzas — Etapa 1 (v1.0.1)

PWA (aplicación web instalable) sin servidor propio ni servicios pagos.
Tus datos quedan **solo en el dispositivo** donde la usás (IndexedDB del navegador).
No hay sincronización entre celular y computadora: para pasar datos, usá la copia de seguridad.

## Archivos
- `index.html` — estructura de la app
- `styles.css` — diseño
- `version.js` — número de versión (único lugar, junto con la línea "Versión" de `sw.js`)
- `calc.js` — cálculos (capital, metas, recomendación, validación de copias, CSV seguro)
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

## Actualizar la app (por ejemplo, de 1.0.0 a 1.0.1)
1. **Antes**, en cada dispositivo: Respaldo → Descargar copia de seguridad.
2. Subí al repositorio todos los archivos nuevos (reemplazan a los viejos). La carpeta `tests` es opcional.
3. Abrí la app: en unos segundos aparece "Hay una versión nueva" → **Actualizar ahora**.
   Si no aparece, cerrala del todo y volvé a abrirla.
4. Verificá en Respaldo que al pie diga **v1.0.1** y que tus movimientos sigan ahí.

Para publicar una versión futura: cambiá el número en `version.js` y en la línea "Versión" de `sw.js`.

## Pruebas automatizadas (opcional, en una PC)
- Cálculos y validaciones (necesita Node.js 18 o superior): `node --test tests/calc.test.js`
- Navegador real (necesita Python y Playwright): `pip install playwright`, `python -m playwright install chromium`,
  luego `python tests/e2e_navegador.py`

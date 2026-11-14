# Cambios

## 1.1.1 — 14/11/2026 (instalación en Android; sin cambios en tus datos)
- Íconos sueltos junto a index.html (antes en la carpeta `icons/`): si esa carpeta no llega a GitHub, Chrome no tiene
  ícono, dice "no se puede instalar" y crea un acceso directo con una letra gris. Ahora se suben todos los archivos juntos.
- Ícono propio: furgoneta familiar de pasajeros (3 ventanillas laterales, cinco asientos) que es una alcancía,
  con una moneda entrando por el techo. Versión "maskable" para Android con el dibujo dentro de la zona segura.
- Manifest con "id", rutas relativas que funcionan en la subcarpeta de GitHub Pages y página de inicio dentro del alcance.
- Respaldo → "Instalar la app": botón "Instalar app" cuando Chrome lo permite y "Revisar instalación", que consulta
  el sitio publicado (no la copia guardada) y dice qué archivo falta o está mal. "Copiar informe" para compartirlo.
- Service worker: si faltan los íconos en el sitio, la app igual se instala para uso sin conexión.
- Datos: mismo formato que la 1.1.0 (no hay migración). Las copias de 1.0.x y 1.1.0 se siguen restaurando.

## 1.1.0 — 14/11/2026 (seguimiento del capital; sin noticias ni créditos)
- Metas de 12, 18, 24, 36 y 48 meses o cualquier plazo de 1 a 240 meses; se pueden comparar hasta 10.
- Plan de ahorro (ahorro mensual y aguinaldo) editable "desde tal mes", con historial: los meses pasados
  conservan el plan que tenían.
- Precio de la Kangoo con historial: cada precio nuevo se agrega; uno cargado por error se anula sin borrarse.
  Aviso cuando la Kangoo aumentó más que tu capital.
- Cuánto falta en dinero y en meses: con tu plan y, con 3 meses de datos, a tu ritmo real (ESTIMADO).
- Pantalla Gráficos (propios, sin internet): evolución del capital real, ahorro real frente al plan,
  progreso hacia el precio y comparación de plazos. Con tooltip (dedo, mouse o flechas) y tabla de números.
- Distinción visual: REAL (azul sólido), ESTIMADO (azul claro / punteado), precio (naranja) con su estado.
- Explicaciones breves en cada sección.
- Datos: formato nuevo (esquema 2) con migración automática y comprobada desde 1.0.x; se guarda una copia
  intacta de los datos anteriores. Las copias de seguridad de 1.0.x se pueden restaurar.
- CSV del historial de precios.
- Corrección: una pestaña abierta antes de la primera instalación ahora también se recarga al actualizar.
- Cambio de criterio: "Este mes ahorraste" ya no cuenta un movimiento anulado ni su corrección (se cancelan en el
  mes del movimiento original). El capital total no cambia.

## 1.0.1 — 14/11/2026 (confiabilidad; sin funciones nuevas de la Etapa 2)
- No se puede anular dos veces el mismo movimiento (doble toque, dos pestañas o llamadas simultáneas).
  Datos viejos con una anulación repetida: la repetida no se cuenta y se marca "CORRECCIÓN REPETIDA: sin efecto".
- Restauración con validación estricta: montos finitos, positivos y con hasta 2 decimales; tipos; fechas reales
  y no futuras; identificadores únicos; anulaciones válidas (existe el original, misma cuenta y monto, sin duplicados);
  configuración; y resumen de control (cantidad, capital y saldo por cuenta) para detectar archivos alterados.
- Las copias nuevas incluyen ese resumen de control. Las copias de la 1.0.0 se aceptan con una advertencia.
- CSV: los textos que empiezan con = + - @ o tabulación se exportan con apóstrofo para que Excel no los ejecute.
- Guardado seguro: cada cambio se valida, se guarda en una sola transacción, se vuelve a leer para verificarlo
  y recién entonces se muestra. Si falla, se avisa y la pantalla y los datos quedan como estaban.
- Restaurar y deshacer son atómicos (los datos anteriores y los nuevos se guardan juntos o no se guarda nada).
- Dos pestañas abiertas: una no puede pisar los cambios de la otra; se ofrece "Recargar datos".
- Service worker: caché por versión (version.js), descarga completa antes de instalar, sin mezclar archivos
  de versiones distintas, y la actualización se aplica solo cuando el usuario toca "Actualizar ahora".
- Pruebas automatizadas en `tests/`.

## 1.0.0 — 14/11/2026
- Primera versión: Inicio, Mis ahorros, Metas, Respaldo, offline e instalable.

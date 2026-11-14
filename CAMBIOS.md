# Cambios

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

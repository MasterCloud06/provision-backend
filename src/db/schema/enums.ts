import { pgEnum } from 'drizzle-orm/pg-core';

// Los valores nuevos se agregan al final: Postgres solo permite añadir valores a un enum.
// Permisos de cada rol: src/lib/permisos.ts
export const rolUsuario = pgEnum('rol_usuario', [
  'ADMIN',
  'VENDEDOR', // ejecutivo de ventas
  'LABORATORIO',
  'ENCARGADO',
  'CAJERO',
  'OPTOMETRISTA',
  'SUPERADMIN',
]);

export const resultadoEvento = pgEnum('resultado_evento', [
  'EXITO',
  'DENEGADO', // sin permiso (403)
  'RECHAZADO', // regla de negocio o conflicto (409/422)
  'FALLIDO', // credenciales incorrectas
  'ERROR', // error del servidor
]);

export const tipoProducto = pgEnum('tipo_producto', [
  'MONTURA',
  'LENTE_OFTALMICO',
  'LENTE_CONTACTO',
  'GAFAS_SOL',
  'ACCESORIO',
  'LIQUIDO',
  'SERVICIO',
]);

export const tipoMovimientoInventario = pgEnum('tipo_movimiento_inventario', [
  'ENTRADA', // compra / recepción de mercadería
  'SALIDA', // baja, merma, uso interno
  'AJUSTE', // conteo físico
  'VENTA',
  'DEVOLUCION_VENTA', // anulación de una venta
  'TRANSFERENCIA_SALIDA',
  'TRANSFERENCIA_ENTRADA',
]);

export const metodoPago = pgEnum('metodo_pago', ['EFECTIVO', 'QR', 'TARJETA', 'TRANSFERENCIA']);

export const estadoSesionCaja = pgEnum('estado_sesion_caja', ['ABIERTA', 'CERRADA']);

export const tipoMovimientoCaja = pgEnum('tipo_movimiento_caja', ['INGRESO', 'EGRESO']);

export const conceptoCaja = pgEnum('concepto_caja', [
  'COBRO_VENTA', // pago o abono de una venta
  'DEVOLUCION', // reembolso por venta anulada
  'GASTO', // gasto operativo pagado desde caja
  'RETIRO_DUENO', // el dueño saca dinero (puede ir a sus finanzas personales)
  'DEPOSITO', // ingreso manual de fondos (sencillo, reposición)
  'OTRO',
]);

export const estadoVenta = pgEnum('estado_venta', ['ACTIVA', 'ANULADA']);

export const estadoPago = pgEnum('estado_pago', ['PENDIENTE', 'PARCIAL', 'PAGADA']);

export const estadoTrabajo = pgEnum('estado_trabajo', [
  'PENDIENTE', // registrado, aún no enviado
  'EN_LABORATORIO',
  'LISTO', // listo para entregar al cliente
  'ENTREGADO',
  'CANCELADO',
]);

export const tipoCuentaPersonal = pgEnum('tipo_cuenta_personal', [
  'EFECTIVO',
  'BANCO',
  'BILLETERA_DIGITAL',
  'TARJETA_CREDITO',
  'AHORRO',
]);

export const tipoCategoriaPersonal = pgEnum('tipo_categoria_personal', ['INGRESO', 'GASTO']);

export const tipoTransaccionPersonal = pgEnum('tipo_transaccion_personal', [
  'INGRESO',
  'GASTO',
  'TRANSFERENCIA',
]);

/* ─────────────────────────── Tienda web ─────────────────────────── */

export const estadoPedidoWeb = pgEnum('estado_pedido_web', [
  'PENDIENTE_PAGO', // creado; el stock queda reservado mientras se paga
  'PAGADO',
  'PREPARANDO',
  'LISTO', // listo para retirar en tienda
  'ENVIADO', // en camino al domicilio
  'ENTREGADO',
  'CANCELADO', // el stock reservado vuelve al inventario
]);

export const entregaPedidoWeb = pgEnum('entrega_pedido_web', ['RETIRO', 'ENVIO']);

/** STRIPE = tarjeta en línea; EN_TIENDA = paga al retirar. */
export const metodoPagoWeb = pgEnum('metodo_pago_web', ['STRIPE', 'EN_TIENDA']);

/* ─────────────────────────── Citas ─────────────────────────── */

export const estadoCita = pgEnum('estado_cita', [
  'PENDIENTE', // reservada, falta confirmar con el cliente
  'CONFIRMADA',
  'ATENDIDA',
  'NO_ASISTIO',
  'CANCELADA',
]);

export const motivoCita = pgEnum('motivo_cita', ['EXAMEN_VISTA', 'CONTROL', 'LENTES_CONTACTO', 'AJUSTE', 'OTRO']);

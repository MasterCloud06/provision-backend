import { pgEnum } from 'drizzle-orm/pg-core';

export const rolUsuario = pgEnum('rol_usuario', ['ADMIN', 'VENDEDOR', 'LABORATORIO']);

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

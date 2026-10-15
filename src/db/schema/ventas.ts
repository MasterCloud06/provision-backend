import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { clientes, recetas } from './clientes.js';
import { sucursales, timestamps, usuarios } from './core.js';
import {
  conceptoCaja,
  estadoPago,
  estadoSesionCaja,
  estadoTrabajo,
  estadoVenta,
  metodoPago,
  tipoMovimientoCaja,
} from './enums.js';
import { productos } from './inventario.js';

/* ───────────────────────────── Caja ───────────────────────────── */

/** Un turno de caja: se abre con un fondo y se cierra con un arqueo. Una abierta por sucursal. */
export const sesionesCaja = pgTable(
  'sesiones_caja',
  {
    id: uuid().primaryKey().defaultRandom(),
    sucursalId: uuid()
      .notNull()
      .references(() => sucursales.id),
    estado: estadoSesionCaja().notNull().default('ABIERTA'),
    abiertaPor: uuid()
      .notNull()
      .references(() => usuarios.id),
    abiertaEn: timestamp({ withTimezone: true }).notNull().defaultNow(),
    montoApertura: integer().notNull(),
    cerradaPor: uuid().references(() => usuarios.id),
    cerradaEn: timestamp({ withTimezone: true }),
    /** Efectivo que el sistema espera encontrar al cerrar. */
    efectivoEsperado: integer(),
    /** Efectivo contado físicamente al cerrar. */
    efectivoContado: integer(),
    /** contado − esperado (negativo = faltante). */
    diferencia: integer(),
    observaciones: text(),
  },
  (t) => [
    uniqueIndex('una_caja_abierta_por_sucursal')
      .on(t.sucursalId)
      .where(sql`${t.estado} = 'ABIERTA'`),
    check('apertura_no_negativa', sql`${t.montoApertura} >= 0`),
  ],
);

/* ──────────────────────────── Ventas ──────────────────────────── */

export const ventas = pgTable(
  'ventas',
  {
    id: uuid().primaryKey().defaultRandom(),
    numero: varchar({ length: 30 }).notNull().unique(),
    sucursalId: uuid()
      .notNull()
      .references(() => sucursales.id),
    clienteId: uuid().references(() => clientes.id),
    vendedorId: uuid()
      .notNull()
      .references(() => usuarios.id),
    recetaId: uuid().references(() => recetas.id),
    estado: estadoVenta().notNull().default('ACTIVA'),
    estadoPago: estadoPago().notNull().default('PENDIENTE'),
    subtotal: integer().notNull(),
    descuento: integer().notNull().default(0),
    total: integer().notNull(),
    pagado: integer().notNull().default(0),
    /** total − pagado; lo que el cliente aún debe (típico: anticipo al encargar lentes). */
    saldo: integer().notNull(),
    notas: text(),
    anuladaPor: uuid().references(() => usuarios.id),
    anuladaEn: timestamp({ withTimezone: true }),
    motivoAnulacion: text(),
    ...timestamps,
  },
  (t) => [
    index('ventas_sucursal_fecha_idx').on(t.sucursalId, t.creadoEn),
    index('ventas_cliente_idx').on(t.clienteId),
    check('ventas_montos', sql`${t.total} >= 0 AND ${t.pagado} >= 0 AND ${t.descuento} >= 0`),
  ],
);

export const ventaItems = pgTable(
  'venta_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    ventaId: uuid()
      .notNull()
      .references(() => ventas.id, { onDelete: 'cascade' }),
    productoId: uuid()
      .notNull()
      .references(() => productos.id),
    descripcion: varchar({ length: 200 }).notNull(), // copia del nombre al momento de vender
    cantidad: integer().notNull(),
    precioUnitario: integer().notNull(),
    descuento: integer().notNull().default(0),
    total: integer().notNull(),
    /** Costo promedio al momento de vender, para calcular margen. */
    costoUnitario: integer().notNull().default(0),
  },
  (t) => [index('venta_items_venta_idx').on(t.ventaId), check('item_cantidad', sql`${t.cantidad} > 0`)],
);

/** Pagos de una venta. Una venta puede tener anticipo y luego saldo (abonos). */
export const pagos = pgTable(
  'pagos',
  {
    id: uuid().primaryKey().defaultRandom(),
    ventaId: uuid()
      .notNull()
      .references(() => ventas.id),
    sesionCajaId: uuid()
      .notNull()
      .references(() => sesionesCaja.id),
    metodo: metodoPago().notNull(),
    monto: integer().notNull(),
    referencia: varchar({ length: 80 }), // nro. de transacción QR / voucher
    usuarioId: uuid()
      .notNull()
      .references(() => usuarios.id),
    creadoEn: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pagos_venta_idx').on(t.ventaId), check('pago_positivo', sql`${t.monto} > 0`)],
);

/**
 * Orden de trabajo de laboratorio: el armado de lentes graduados en una montura.
 * Nace junto a la venta y sigue su propio ciclo hasta que el cliente retira.
 */
export const ordenesTrabajo = pgTable(
  'ordenes_trabajo',
  {
    id: uuid().primaryKey().defaultRandom(),
    numero: varchar({ length: 30 }).notNull().unique(),
    ventaId: uuid()
      .notNull()
      .references(() => ventas.id),
    sucursalId: uuid()
      .notNull()
      .references(() => sucursales.id),
    recetaId: uuid().references(() => recetas.id),
    estado: estadoTrabajo().notNull().default('PENDIENTE'),
    fechaPrometida: date(),
    instrucciones: text(),
    laboratorioExterno: varchar({ length: 120 }),
    entregadoEn: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('ot_estado_idx').on(t.sucursalId, t.estado)],
);

export const historialTrabajo = pgTable('historial_trabajo', {
  id: uuid().primaryKey().defaultRandom(),
  ordenId: uuid()
    .notNull()
    .references(() => ordenesTrabajo.id, { onDelete: 'cascade' }),
  estadoAnterior: estadoTrabajo(),
  estadoNuevo: estadoTrabajo().notNull(),
  nota: text(),
  usuarioId: uuid().references(() => usuarios.id),
  creadoEn: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Todo dinero que entra o sale de una caja abierta. */
export const movimientosCaja = pgTable(
  'movimientos_caja',
  {
    id: uuid().primaryKey().defaultRandom(),
    sesionCajaId: uuid()
      .notNull()
      .references(() => sesionesCaja.id),
    tipo: tipoMovimientoCaja().notNull(),
    concepto: conceptoCaja().notNull(),
    metodo: metodoPago().notNull(),
    monto: integer().notNull(),
    descripcion: text(),
    ventaId: uuid().references(() => ventas.id),
    pagoId: uuid().references(() => pagos.id),
    usuarioId: uuid()
      .notNull()
      .references(() => usuarios.id),
    creadoEn: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mov_caja_sesion_idx').on(t.sesionCajaId),
    check('mov_caja_positivo', sql`${t.monto} > 0`),
  ],
);

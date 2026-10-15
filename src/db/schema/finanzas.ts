import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { timestamps, usuarios } from './core.js';
import { tipoCategoriaPersonal, tipoCuentaPersonal, tipoTransaccionPersonal } from './enums.js';
import { movimientosCaja } from './ventas.js';

/*
 * Finanzas personales: cada usuario lleva sus propias cuentas, separadas del negocio.
 * El puente con el negocio es el "retiro del dueño": un egreso de caja que, si se indica
 * una cuenta personal, entra automáticamente como ingreso en esa cuenta.
 * Los saldos no se guardan: se calculan desde las transacciones, así nunca se desincronizan.
 */

export const cuentasPersonales = pgTable(
  'cuentas_personales',
  {
    id: uuid().primaryKey().defaultRandom(),
    usuarioId: uuid()
      .notNull()
      .references(() => usuarios.id),
    nombre: varchar({ length: 80 }).notNull(),
    tipo: tipoCuentaPersonal().notNull(),
    saldoInicial: integer().notNull().default(0),
    color: varchar({ length: 9 }),
    archivada: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [unique('cuenta_nombre_por_usuario').on(t.usuarioId, t.nombre)],
);

export const categoriasPersonales = pgTable(
  'categorias_personales',
  {
    id: uuid().primaryKey().defaultRandom(),
    usuarioId: uuid()
      .notNull()
      .references(() => usuarios.id),
    nombre: varchar({ length: 60 }).notNull(),
    tipo: tipoCategoriaPersonal().notNull(),
    icono: varchar({ length: 40 }),
    archivada: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [unique('categoria_nombre_por_usuario').on(t.usuarioId, t.tipo, t.nombre)],
);

export const transaccionesPersonales = pgTable(
  'transacciones_personales',
  {
    id: uuid().primaryKey().defaultRandom(),
    usuarioId: uuid()
      .notNull()
      .references(() => usuarios.id),
    tipo: tipoTransaccionPersonal().notNull(),
    cuentaId: uuid()
      .notNull()
      .references(() => cuentasPersonales.id),
    /** Solo para TRANSFERENCIA. */
    cuentaDestinoId: uuid().references(() => cuentasPersonales.id),
    categoriaId: uuid().references(() => categoriasPersonales.id),
    monto: integer().notNull(),
    fecha: date().notNull(),
    descripcion: text(),
    /** Si nació de un retiro de caja del negocio. */
    movimientoCajaId: uuid().references(() => movimientosCaja.id),
    ...timestamps,
  },
  (t) => [
    index('tx_personal_usuario_fecha_idx').on(t.usuarioId, t.fecha),
    check('tx_monto_positivo', sql`${t.monto} > 0`),
    check(
      'tx_transferencia_destino',
      sql`(${t.tipo} = 'TRANSFERENCIA') = (${t.cuentaDestinoId} IS NOT NULL)`,
    ),
  ],
);

/** Tope de gasto mensual por categoría. mes = 'YYYY-MM'. */
export const presupuestos = pgTable(
  'presupuestos',
  {
    id: uuid().primaryKey().defaultRandom(),
    usuarioId: uuid()
      .notNull()
      .references(() => usuarios.id),
    categoriaId: uuid()
      .notNull()
      .references(() => categoriasPersonales.id),
    mes: varchar({ length: 7 }).notNull(),
    monto: integer().notNull(),
    ...timestamps,
  },
  (t) => [
    unique('presupuesto_unico').on(t.usuarioId, t.categoriaId, t.mes),
    check('presupuesto_mes_formato', sql`${t.mes} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

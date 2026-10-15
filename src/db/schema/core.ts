import { boolean, integer, pgTable, text, timestamp, uuid, varchar, primaryKey } from 'drizzle-orm/pg-core';
import { rolUsuario } from './enums.js';

export const timestamps = {
  creadoEn: timestamp({ withTimezone: true }).notNull().defaultNow(),
  actualizadoEn: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Una óptica puede tener varias sucursales; stock y caja son por sucursal. */
export const sucursales = pgTable('sucursales', {
  id: uuid().primaryKey().defaultRandom(),
  nombre: varchar({ length: 120 }).notNull(),
  codigo: varchar({ length: 10 }).notNull().unique(), // prefijo para correlativos, ej. "CAL"
  direccion: text(),
  telefono: varchar({ length: 40 }),
  activa: boolean().notNull().default(true),
  ...timestamps,
});

export const usuarios = pgTable('usuarios', {
  id: uuid().primaryKey().defaultRandom(),
  nombre: varchar({ length: 120 }).notNull(),
  email: varchar({ length: 160 }).notNull().unique(),
  passwordHash: text().notNull(),
  rol: rolUsuario().notNull().default('VENDEDOR'),
  sucursalId: uuid().references(() => sucursales.id),
  activo: boolean().notNull().default(true),
  ...timestamps,
});

/**
 * Contadores para numeración correlativa legible (V-CAL-000123, OT-CAL-000045).
 * Se incrementan con UPDATE ... RETURNING dentro de la transacción del documento.
 */
export const correlativos = pgTable(
  'correlativos',
  {
    sucursalId: uuid()
      .notNull()
      .references(() => sucursales.id),
    serie: varchar({ length: 10 }).notNull(),
    ultimo: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.sucursalId, t.serie] })],
);

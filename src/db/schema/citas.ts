import { date, index, integer, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { clientes } from './clientes.js';
import { sucursales, timestamps, usuarios } from './core.js';
import { estadoCita, motivoCita } from './enums.js';
import { cuentasTienda } from './tienda.js';

/**
 * Cita para examen de la vista u otra atención. La reserva el cliente en la tienda web
 * o el personal (por teléfono o en mostrador). Fecha y hora son locales de Bolivia.
 */
export const citas = pgTable(
  'citas',
  {
    id: uuid().primaryKey().defaultRandom(),
    sucursalId: uuid()
      .notNull()
      .references(() => sucursales.id),
    clienteId: uuid().references(() => clientes.id),
    /** Si la reservó el cliente desde la tienda web. */
    cuentaId: uuid().references(() => cuentasTienda.id),
    fecha: date().notNull(),
    hora: varchar({ length: 5 }).notNull(), // HH:MM
    duracion: integer().notNull(),
    motivo: motivoCita().notNull().default('EXAMEN_VISTA'),
    estado: estadoCita().notNull().default('PENDIENTE'),
    nombreContacto: varchar({ length: 160 }).notNull(),
    telefono: varchar({ length: 40 }).notNull(),
    /** Lo que escribió el cliente. */
    notas: text(),
    /** Lo que anota el personal (el cliente no lo ve). */
    notasInternas: text(),
    canceladaMotivo: text(),
    creadaPor: uuid().references(() => usuarios.id),
    atendidaPor: uuid().references(() => usuarios.id),
    ...timestamps,
  },
  (t) => [index('citas_agenda_idx').on(t.sucursalId, t.fecha, t.hora), index('citas_cuenta_idx').on(t.cuentaId)],
);

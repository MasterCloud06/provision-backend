import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sucursales, usuarios } from './core.js';
import { resultadoEvento, rolUsuario } from './enums.js';

/**
 * Registro de eventos: cada acción que cambia algo (y cada intento negado o fallido).
 * Guarda una foto de quién y con qué rol lo hizo, para que el historial no cambie
 * aunque después el usuario cambie de rol. Nunca guarda contraseñas ni el cuerpo completo.
 */
export const eventos = pgTable(
  'eventos',
  {
    id: uuid().primaryKey().defaultRandom(),
    creadoEn: timestamp({ withTimezone: true }).notNull().defaultNow(),
    usuarioId: uuid().references(() => usuarios.id),
    usuarioNombre: varchar({ length: 160 }),
    rol: rolUsuario(),
    sucursalId: uuid().references(() => sucursales.id),
    modulo: varchar({ length: 30 }).notNull(),
    accion: varchar({ length: 80 }).notNull(),
    descripcion: text().notNull(),
    resultado: resultadoEvento().notNull(),
    entidadId: uuid(),
    metodo: varchar({ length: 8 }).notNull(),
    ruta: varchar({ length: 200 }).notNull(),
    ip: varchar({ length: 64 }),
  },
  (t) => [
    index('eventos_fecha_idx').on(t.creadoEn),
    index('eventos_usuario_idx').on(t.usuarioId, t.creadoEn),
    index('eventos_rol_idx').on(t.rol, t.creadoEn),
  ],
);

import { date, index, integer, numeric, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { timestamps, usuarios } from './core.js';

export const clientes = pgTable(
  'clientes',
  {
    id: uuid().primaryKey().defaultRandom(),
    nombre: varchar({ length: 160 }).notNull(),
    ci: varchar({ length: 30 }), // carnet de identidad
    nit: varchar({ length: 30 }), // para facturación
    telefono: varchar({ length: 40 }),
    email: varchar({ length: 160 }),
    fechaNacimiento: date(),
    direccion: text(),
    notas: text(),
    ...timestamps,
  },
  (t) => [index('clientes_nombre_idx').on(t.nombre), index('clientes_ci_idx').on(t.ci)],
);

const dioptria = (precision = 5, scale = 2) => numeric({ precision, scale, mode: 'number' });

/**
 * Receta / graduación de un cliente. OD = ojo derecho, OI = ojo izquierdo.
 * Una venta con lentes graduados apunta a la receta que se usó.
 */
export const recetas = pgTable(
  'recetas',
  {
    id: uuid().primaryKey().defaultRandom(),
    clienteId: uuid()
      .notNull()
      .references(() => clientes.id),
    fecha: date().notNull(),
    profesional: varchar({ length: 120 }), // optometrista u oftalmólogo
    odEsfera: dioptria(),
    odCilindro: dioptria(),
    odEje: integer(),
    odAdicion: dioptria(),
    odAgudezaVisual: varchar({ length: 20 }),
    oiEsfera: dioptria(),
    oiCilindro: dioptria(),
    oiEje: integer(),
    oiAdicion: dioptria(),
    oiAgudezaVisual: varchar({ length: 20 }),
    /** Distancia naso-pupilar total o por ojo, en mm. */
    dnpOd: dioptria(4, 1),
    dnpOi: dioptria(4, 1),
    alturaFocal: dioptria(4, 1),
    usoRecomendado: varchar({ length: 60 }), // lejos, cerca, multifocal, computadora...
    observaciones: text(),
    registradoPor: uuid().references(() => usuarios.id),
    ...timestamps,
  },
  (t) => [index('recetas_cliente_idx').on(t.clienteId, t.fecha)],
);

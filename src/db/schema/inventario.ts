import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sucursales, timestamps, usuarios } from './core.js';
import { tipoMovimientoInventario, tipoProducto } from './enums.js';

export const marcas = pgTable('marcas', {
  id: uuid().primaryKey().defaultRandom(),
  nombre: varchar({ length: 80 }).notNull().unique(),
  activa: boolean().notNull().default(true),
  ...timestamps,
});

export const proveedores = pgTable('proveedores', {
  id: uuid().primaryKey().defaultRandom(),
  nombre: varchar({ length: 120 }).notNull(),
  nit: varchar({ length: 30 }),
  contacto: varchar({ length: 120 }),
  telefono: varchar({ length: 40 }),
  email: varchar({ length: 160 }),
  activo: boolean().notNull().default(true),
  ...timestamps,
});

/**
 * Atributos ópticos opcionales de un producto. Son libres (jsonb) porque varían por tipo:
 * una montura tiene calibre/puente/varilla, un lente tiene índice y tratamiento, etc.
 */
export type AtributosProducto = {
  genero?: 'HOMBRE' | 'MUJER' | 'NINO' | 'UNISEX';
  material?: string; // acetato, metal, TR90, policarbonato...
  forma?: string; // aviador, redondo, cat-eye...
  color?: string;
  calibre?: number; // ancho del lente en mm
  puente?: number; // mm
  varilla?: number; // largo de la patilla en mm
  indice?: number; // índice de refracción de lentes (1.50, 1.56, 1.67...)
  tratamiento?: string; // antirreflejo, filtro azul, fotocromático...
  [extra: string]: unknown;
};

export const productos = pgTable(
  'productos',
  {
    id: uuid().primaryKey().defaultRandom(),
    sku: varchar({ length: 40 }).notNull().unique(),
    codigoBarras: varchar({ length: 64 }).unique(),
    nombre: varchar({ length: 160 }).notNull(),
    descripcion: text(),
    tipo: tipoProducto().notNull(),
    marcaId: uuid().references(() => marcas.id),
    proveedorId: uuid().references(() => proveedores.id),
    modelo: varchar({ length: 80 }),
    atributos: jsonb().$type<AtributosProducto>().notNull().default({}),
    // Montos en centavos de boliviano (Bs 350.00 = 35000)
    precioVenta: integer().notNull(),
    costoPromedio: integer().notNull().default(0),
    stockMinimo: integer().notNull().default(0),
    /** false para servicios (consulta, montaje) que no llevan existencias. */
    controlaStock: boolean().notNull().default(true),
    activo: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('productos_tipo_idx').on(t.tipo),
    index('productos_marca_idx').on(t.marcaId),
    check('productos_precio_positivo', sql`${t.precioVenta} >= 0`),
  ],
);

/** Existencias actuales por producto y sucursal. */
export const stock = pgTable(
  'stock',
  {
    productoId: uuid()
      .notNull()
      .references(() => productos.id),
    sucursalId: uuid()
      .notNull()
      .references(() => sucursales.id),
    cantidad: integer().notNull().default(0),
    ubicacion: varchar({ length: 60 }), // vitrina, cajón, bodega...
    actualizadoEn: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.productoId, t.sucursalId] }),
    check('stock_no_negativo', sql`${t.cantidad} >= 0`),
  ],
);

/** Kardex: cada cambio de existencias deja un registro inmutable. */
export const movimientosInventario = pgTable(
  'movimientos_inventario',
  {
    id: uuid().primaryKey().defaultRandom(),
    productoId: uuid()
      .notNull()
      .references(() => productos.id),
    sucursalId: uuid()
      .notNull()
      .references(() => sucursales.id),
    tipo: tipoMovimientoInventario().notNull(),
    /** Positivo entra, negativo sale. */
    cantidad: integer().notNull(),
    stockResultante: integer().notNull(),
    costoUnitario: integer(),
    motivo: text(),
    /** Agrupa movimientos relacionados (venta, transferencia, recepción). */
    referenciaTipo: varchar({ length: 30 }),
    referenciaId: uuid(),
    usuarioId: uuid().references(() => usuarios.id),
    creadoEn: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mov_inv_producto_idx').on(t.productoId, t.creadoEn),
    index('mov_inv_referencia_idx').on(t.referenciaTipo, t.referenciaId),
  ],
);

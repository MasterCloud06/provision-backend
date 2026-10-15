import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { clientes } from './clientes.js';
import { sucursales, timestamps, usuarios } from './core.js';
import { entregaPedidoWeb, estadoPedidoWeb, metodoPagoWeb } from './enums.js';
import { productos } from './inventario.js';

/**
 * Cuenta de un cliente en la tienda web. Es distinta de `usuarios` (el personal):
 * un cliente nunca puede entrar al sistema interno. Cada cuenta crea su ficha en `clientes`,
 * así el personal lo ve igual que a un cliente de mostrador.
 */
export const cuentasTienda = pgTable('cuentas_tienda', {
  id: uuid().primaryKey().defaultRandom(),
  clienteId: uuid()
    .notNull()
    .references(() => clientes.id),
  email: varchar({ length: 160 }).notNull().unique(),
  passwordHash: text().notNull(),
  activa: boolean().notNull().default(true),
  ...timestamps,
});

/** Carrito guardado en el servidor: el cliente lo encuentra desde cualquier dispositivo. */
export const carritoItems = pgTable(
  'carrito_items',
  {
    cuentaId: uuid()
      .notNull()
      .references(() => cuentasTienda.id, { onDelete: 'cascade' }),
    productoId: uuid()
      .notNull()
      .references(() => productos.id),
    cantidad: integer().notNull(),
    agregadoEn: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cuentaId, t.productoId] }), check('carrito_cantidad_positiva', sql`${t.cantidad} > 0`)],
);

export const pedidosWeb = pgTable(
  'pedidos_web',
  {
    id: uuid().primaryKey().defaultRandom(),
    numero: varchar({ length: 30 }).notNull().unique(),
    cuentaId: uuid()
      .notNull()
      .references(() => cuentasTienda.id),
    clienteId: uuid()
      .notNull()
      .references(() => clientes.id),
    /** Sucursal que despacha y de la que sale el stock. */
    sucursalId: uuid()
      .notNull()
      .references(() => sucursales.id),
    estado: estadoPedidoWeb().notNull().default('PENDIENTE_PAGO'),
    metodoPago: metodoPagoWeb().notNull(),
    entrega: entregaPedidoWeb().notNull(),
    // Datos de contacto y envío al momento del pedido
    nombreContacto: varchar({ length: 160 }).notNull(),
    telefono: varchar({ length: 40 }).notNull(),
    direccion: text(),
    ciudad: varchar({ length: 80 }),
    notas: text(),
    // Montos en centavos de boliviano
    subtotal: integer().notNull(),
    costoEnvio: integer().notNull().default(0),
    total: integer().notNull(),
    /** Si sigue PENDIENTE_PAGO después de esta hora, se cancela y el stock vuelve. Null = no vence. */
    expiraEn: timestamp({ withTimezone: true }),
    stripeSessionId: varchar({ length: 255 }),
    stripePaymentIntent: varchar({ length: 255 }),
    pagadoEn: timestamp({ withTimezone: true }),
    /** Notas del personal (no las ve el cliente). */
    notasInternas: text(),
    canceladoMotivo: text(),
    atendidoPor: uuid().references(() => usuarios.id),
    ...timestamps,
  },
  (t) => [
    index('pedidos_web_cuenta_idx').on(t.cuentaId, t.creadoEn),
    index('pedidos_web_estado_idx').on(t.estado),
    index('pedidos_web_stripe_idx').on(t.stripeSessionId),
    check('pedidos_web_total', sql`${t.total} = ${t.subtotal} + ${t.costoEnvio}`),
  ],
);

export const pedidoWebItems = pgTable('pedido_web_items', {
  id: uuid().primaryKey().defaultRandom(),
  pedidoId: uuid()
    .notNull()
    .references(() => pedidosWeb.id, { onDelete: 'cascade' }),
  productoId: uuid()
    .notNull()
    .references(() => productos.id),
  /** Copia del nombre y precio al momento de comprar. */
  nombre: varchar({ length: 160 }).notNull(),
  precioUnitario: integer().notNull(),
  cantidad: integer().notNull(),
  subtotal: integer().notNull(),
});

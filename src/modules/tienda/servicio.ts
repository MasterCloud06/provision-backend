import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import type { DB, Exec } from '../../db/client.js';
import { carritoItems, pedidosWeb, pedidoWebItems, productos, stock, sucursales, ventaItems, ventas } from '../../db/schema/index.js';
import { siguienteNumero } from '../../lib/correlativo.js';
import { AppError, conflicto, noEncontrado, reglaNegocio } from '../../lib/errors.js';
import type { PasarelaPagos, SesionPago } from '../../lib/pagos.js';
import { moverStock } from '../inventario/servicio.js';
import { cobrar, type PagoEntrada } from '../ventas/servicio.js';
import type { Avisos } from './avisos.js';

export type EstadoPedido = (typeof pedidosWeb.$inferSelect)['estado'];

/** Sucursal que despacha la tienda: la configurada o la primera activa. */
export async function sucursalTienda(db: Exec) {
  const columnas = { id: sucursales.id, nombre: sucursales.nombre, direccion: sucursales.direccion, telefono: sucursales.telefono };
  if (env.TIENDA_SUCURSAL_CODIGO) {
    const [s] = await db.select(columnas).from(sucursales).where(eq(sucursales.codigo, env.TIENDA_SUCURSAL_CODIGO));
    if (s) return s;
  }
  const [s] = await db.select(columnas).from(sucursales).where(eq(sucursales.activa, true)).orderBy(asc(sucursales.creadoEn)).limit(1);
  if (!s) throw new AppError(503, 'TIENDA_NO_DISPONIBLE', 'La tienda todavía no está configurada');
  return s;
}

/** Cuántas unidades se pueden vender en la tienda (null = sin límite, p. ej. un servicio). */
export const disponibleSql = (sucursalId: string) =>
  sql<number | null>`case when ${productos.controlaStock} then coalesce((select ${stock.cantidad} from ${stock} where ${stock.productoId} = ${productos.id} and ${stock.sucursalId} = ${sucursalId}), 0) else null end`;

/** El producto se puede comprar en la tienda: activo y publicado. */
export const publicado = and(eq(productos.activo, true), eq(productos.visibleTienda, true));

type DatosPedido = {
  cuentaId: string;
  clienteId: string;
  entrega: 'RETIRO' | 'ENVIO';
  metodoPago: 'STRIPE' | 'EN_TIENDA';
  nombreContacto: string;
  telefono: string;
  direccion?: string | null;
  ciudad?: string | null;
  notas?: string | null;
};

/**
 * Convierte el carrito en un pedido dentro de una transacción: toma los precios actuales,
 * descuenta (reserva) el stock de la sucursal de la tienda y vacía el carrito.
 * Si algo no alcanza, nada cambia y el error dice qué producto falta.
 */
export async function crearPedidoDesdeCarrito(db: DB, d: DatosPedido) {
  return db.transaction(async (tx) => {
    const sucursal = await sucursalTienda(tx);
    const carrito = await tx
      .select({
        productoId: carritoItems.productoId,
        cantidad: carritoItems.cantidad,
        nombre: productos.nombre,
        precio: productos.precioVenta,
        activo: productos.activo,
        visible: productos.visibleTienda,
      })
      .from(carritoItems)
      .innerJoin(productos, eq(productos.id, carritoItems.productoId))
      .where(eq(carritoItems.cuentaId, d.cuentaId))
      .orderBy(asc(carritoItems.agregadoEn));
    if (carrito.length === 0) throw reglaNegocio('Tu carrito está vacío');
    const retirados = carrito.filter((i) => !i.activo || !i.visible);
    if (retirados.length) {
      throw reglaNegocio(`Ya no está a la venta: ${retirados.map((i) => i.nombre).join(', ')}. Quítalo del carrito para continuar.`, {
        productos: retirados.map((i) => i.productoId),
      });
    }

    const subtotal = carrito.reduce((a, i) => a + i.precio * i.cantidad, 0);
    const costoEnvio = d.entrega === 'ENVIO' ? env.TIENDA_COSTO_ENVIO : 0;
    const minutos = d.metodoPago === 'STRIPE' ? env.TIENDA_MINUTOS_RESERVA : env.TIENDA_DIAS_RETIRO * 24 * 60;
    const numero = await siguienteNumero(tx, sucursal.id, 'W');
    const [pedido] = await tx
      .insert(pedidosWeb)
      .values({
        numero,
        cuentaId: d.cuentaId,
        clienteId: d.clienteId,
        sucursalId: sucursal.id,
        metodoPago: d.metodoPago,
        entrega: d.entrega,
        nombreContacto: d.nombreContacto,
        telefono: d.telefono,
        direccion: d.entrega === 'ENVIO' ? d.direccion : null,
        ciudad: d.entrega === 'ENVIO' ? d.ciudad : null,
        notas: d.notas,
        subtotal,
        costoEnvio,
        total: subtotal + costoEnvio,
        expiraEn: new Date(Date.now() + minutos * 60_000),
      })
      .returning();

    await tx.insert(pedidoWebItems).values(
      carrito.map((i) => ({
        pedidoId: pedido!.id,
        productoId: i.productoId,
        nombre: i.nombre,
        precioUnitario: i.precio,
        cantidad: i.cantidad,
        subtotal: i.precio * i.cantidad,
      })),
    );
    for (const i of carrito) {
      await moverStock(tx, {
        productoId: i.productoId,
        sucursalId: sucursal.id,
        tipo: 'VENTA',
        cantidad: -i.cantidad,
        motivo: `Pedido web ${numero}`,
        referenciaTipo: 'PEDIDO_WEB',
        referenciaId: pedido!.id,
      });
    }
    await tx.delete(carritoItems).where(eq(carritoItems.cuentaId, d.cuentaId));
    return pedido!;
  });
}

/** Devuelve al inventario el stock que el pedido tenía reservado. */
async function devolverStock(tx: Exec, pedido: { id: string; numero: string; sucursalId: string }, usuarioId: string | null) {
  const items = await tx.select().from(pedidoWebItems).where(eq(pedidoWebItems.pedidoId, pedido.id));
  for (const i of items) {
    await moverStock(tx, {
      productoId: i.productoId,
      sucursalId: pedido.sucursalId,
      tipo: 'DEVOLUCION_VENTA',
      cantidad: i.cantidad,
      motivo: `Pedido web ${pedido.numero} cancelado`,
      referenciaTipo: 'PEDIDO_WEB',
      referenciaId: pedido.id,
      usuarioId,
    });
  }
  return items;
}

/** Vuelve a reservar el stock (un pago que llegó después de que el pedido se canceló por tiempo). */
async function reservarDeNuevo(tx: Exec, pedido: { id: string; numero: string; sucursalId: string }) {
  const items = await tx.select().from(pedidoWebItems).where(eq(pedidoWebItems.pedidoId, pedido.id));
  for (const i of items) {
    await moverStock(tx, {
      productoId: i.productoId,
      sucursalId: pedido.sucursalId,
      tipo: 'VENTA',
      cantidad: -i.cantidad,
      motivo: `Pedido web ${pedido.numero} (pago tardío)`,
      referenciaTipo: 'PEDIDO_WEB',
      referenciaId: pedido.id,
    });
  }
}

/**
 * Marca el pedido como pagado a partir de una sesión de Stripe ya pagada.
 * Es idempotente: el webhook y la verificación del navegador pueden llegar los dos.
 */
export async function confirmarPago(db: DB, sesion: SesionPago, avisos?: Avisos) {
  if (!sesion.pagado || !sesion.pedidoId) return null;
  let recienPagado = false;
  const resultado = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(pedidosWeb).where(eq(pedidosWeb.id, sesion.pedidoId!)).for('update');
    if (!p) return null;
    if (p.estado !== 'PENDIENTE_PAGO' && p.estado !== 'CANCELADO') return p; // ya confirmado antes
    let notasInternas = p.notasInternas;
    if (p.estado === 'CANCELADO') {
      // Se canceló por tiempo pero el pago sí entró: se intenta reservar otra vez.
      try {
        await tx.transaction(async (sp) => reservarDeNuevo(sp, p));
      } catch {
        notasInternas = [notasInternas, '⚠ Pago recibido después de vencer la reserva y ya no hay stock: reponer o reembolsar.']
          .filter(Boolean)
          .join('\n');
      }
    }
    const [actualizado] = await tx
      .update(pedidosWeb)
      .set({
        estado: 'PAGADO',
        pagadoEn: new Date(),
        stripeSessionId: sesion.id,
        stripePaymentIntent: sesion.paymentIntent,
        expiraEn: null,
        canceladoMotivo: null,
        notasInternas,
      })
      .where(eq(pedidosWeb.id, p.id))
      .returning();
    recienPagado = true;
    return actualizado!;
  });
  if (recienPagado && resultado) void avisos?.pagoRecibido(resultado.id);
  return resultado;
}

/**
 * Cancela un pedido y devuelve su stock. Si estaba pagado con tarjeta, reembolsa en Stripe primero
 * (si el reembolso falla, el pedido no se cancela). Si estaba esperando el pago, cierra la sesión
 * de Stripe para que ya no se pueda pagar.
 */
export async function cancelarPedido(
  db: DB,
  pasarela: PasarelaPagos | null,
  pedidoId: string,
  motivo: string,
  usuarioId: string | null,
  avisos?: Avisos,
) {
  const [p] = await db.select().from(pedidosWeb).where(eq(pedidosWeb.id, pedidoId));
  if (!p) throw noEncontrado('Pedido');
  if (p.estado === 'CANCELADO') throw conflicto('El pedido ya está cancelado');
  if (p.estado === 'ENTREGADO') throw conflicto('El pedido ya fue entregado: no se puede cancelar');

  if (p.metodoPago === 'STRIPE' && p.estado === 'PENDIENTE_PAGO' && p.stripeSessionId && pasarela) {
    // Primero se cierra el pago; si justo se completó, se confirma en vez de cancelar.
    await pasarela.expirarSesion(p.stripeSessionId);
    const s = await pasarela.obtenerSesion(p.stripeSessionId);
    if (s.pagado) {
      await confirmarPago(db, s, avisos);
      throw conflicto('El pago de este pedido acaba de completarse: ya no se puede cancelar desde aquí');
    }
  }
  const reembolsar = p.metodoPago === 'STRIPE' && p.pagadoEn != null && p.stripePaymentIntent;
  if (reembolsar) {
    if (!pasarela) throw new AppError(503, 'PAGOS_NO_CONFIGURADOS', 'Stripe no está configurado: no se puede reembolsar');
    await pasarela.reembolsar(p.stripePaymentIntent!);
  }

  const cancelado = await db.transaction(async (tx) => {
    const [bloqueado] = await tx.select().from(pedidosWeb).where(eq(pedidosWeb.id, pedidoId)).for('update');
    if (!bloqueado || bloqueado.estado === 'CANCELADO') throw conflicto('El pedido ya está cancelado');
    await devolverStock(tx, bloqueado, usuarioId);
    const [cancelado] = await tx
      .update(pedidosWeb)
      .set({
        estado: 'CANCELADO',
        expiraEn: null,
        canceladoMotivo: motivo + (reembolsar ? ' · pago reembolsado' : ''),
        ...(usuarioId ? { atendidoPor: usuarioId } : {}),
      })
      .where(eq(pedidosWeb.id, pedidoId))
      .returning();
    return cancelado!;
  });
  void avisos?.pedidoCancelado(cancelado.id);
  return cancelado;
}

/**
 * Cancela los pedidos que siguen sin pagar después de su plazo y devuelve el stock.
 * Antes consulta a Stripe por si el pago sí entró y el aviso (webhook) no llegó.
 */
export async function liberarVencidos(db: DB, pasarela: PasarelaPagos | null, avisos?: Avisos) {
  const vencidos = await db
    .select({ id: pedidosWeb.id, metodoPago: pedidosWeb.metodoPago, stripeSessionId: pedidosWeb.stripeSessionId })
    .from(pedidosWeb)
    .where(and(eq(pedidosWeb.estado, 'PENDIENTE_PAGO'), isNotNull(pedidosWeb.expiraEn), lt(pedidosWeb.expiraEn, new Date())));
  let liberados = 0;
  for (const v of vencidos) {
    try {
      if (v.metodoPago === 'STRIPE' && v.stripeSessionId && pasarela) {
        const s = await pasarela.obtenerSesion(v.stripeSessionId);
        if (s.pagado) {
          await confirmarPago(db, s, avisos);
          continue;
        }
      }
      await cancelarPedido(db, pasarela, v.id, 'Venció el plazo para pagar', null, avisos);
      liberados++;
    } catch (err) {
      console.error(`[tienda] no se pudo liberar el pedido ${v.id}`, err);
    }
  }
  return liberados;
}

/** Pedido con sus ítems (y la imagen actual de cada producto). */
export async function pedidoConItems(db: Exec, id: string) {
  const [p] = await db.select().from(pedidosWeb).where(eq(pedidosWeb.id, id));
  if (!p) return null;
  const items = await db
    .select({
      id: pedidoWebItems.id,
      productoId: pedidoWebItems.productoId,
      nombre: pedidoWebItems.nombre,
      precioUnitario: pedidoWebItems.precioUnitario,
      cantidad: pedidoWebItems.cantidad,
      subtotal: pedidoWebItems.subtotal,
      imagenUrl: productos.imagenUrl,
      tipo: productos.tipo,
    })
    .from(pedidoWebItems)
    .innerJoin(productos, eq(productos.id, pedidoWebItems.productoId))
    .where(eq(pedidoWebItems.pedidoId, id));
  return { ...p, items };
}

/** Cuántos productos tiene cada pedido (para listados). */
export async function conteoItems(db: Exec, ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const filas = await db
    .select({ pedidoId: pedidoWebItems.pedidoId, n: sql<number>`sum(${pedidoWebItems.cantidad})::int` })
    .from(pedidoWebItems)
    .where(inArray(pedidoWebItems.pedidoId, ids))
    .groupBy(pedidoWebItems.pedidoId);
  return new Map(filas.map((f) => [f.pedidoId, f.n]));
}

/**
 * Al entregar un pedido web se registra como una venta normal: así aparece en los reportes,
 * en el margen y en "más vendidos". El stock ya salió al reservar, por eso aquí no se mueve.
 * - Pagado con tarjeta (Stripe): la venta queda pagada con la fecha del pago. Ese dinero va al banco,
 *   no a la caja de la tienda.
 * - Pago al retirar: se cobra en la caja abierta con los métodos indicados.
 */
export async function registrarVentaDePedido(
  tx: Exec,
  pedido: typeof pedidosWeb.$inferSelect,
  usuario: { id: string },
  pagosEnTienda: PagoEntrada[] | null,
) {
  const items = await tx
    .select({
      productoId: pedidoWebItems.productoId,
      nombre: pedidoWebItems.nombre,
      cantidad: pedidoWebItems.cantidad,
      precioUnitario: pedidoWebItems.precioUnitario,
      subtotal: pedidoWebItems.subtotal,
      costo: productos.costoPromedio,
    })
    .from(pedidoWebItems)
    .innerJoin(productos, eq(productos.id, pedidoWebItems.productoId))
    .where(eq(pedidoWebItems.pedidoId, pedido.id));

  const numero = await siguienteNumero(tx, pedido.sucursalId, 'V');
  const pagadoConTarjeta = pedido.metodoPago === 'STRIPE';
  const notas = [
    `Pedido web ${pedido.numero}`,
    pagadoConTarjeta ? 'pagado con tarjeta en línea (Stripe)' : 'cobrado al retirar',
    pedido.costoEnvio > 0 ? `incluye envío ${(pedido.costoEnvio / 100).toFixed(2)} Bs` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const [venta] = await tx
    .insert(ventas)
    .values({
      numero,
      sucursalId: pedido.sucursalId,
      clienteId: pedido.clienteId,
      vendedorId: usuario.id,
      subtotal: pedido.total,
      descuento: 0,
      total: pedido.total,
      pagado: pagadoConTarjeta ? pedido.total : 0,
      saldo: pagadoConTarjeta ? 0 : pedido.total,
      estadoPago: pagadoConTarjeta ? 'PAGADA' : 'PENDIENTE',
      notas,
      // La venta con tarjeta cuenta el día en que se pagó.
      ...(pagadoConTarjeta && pedido.pagadoEn ? { creadoEn: pedido.pagadoEn } : {}),
    })
    .returning();
  await tx.insert(ventaItems).values(
    items.map((i) => ({
      ventaId: venta!.id,
      productoId: i.productoId,
      descripcion: i.nombre,
      cantidad: i.cantidad,
      precioUnitario: i.precioUnitario,
      descuento: 0,
      total: i.subtotal,
      costoUnitario: i.costo,
    })),
  );

  if (!pagadoConTarjeta) {
    const lista = pagosEnTienda ?? [];
    const monto = lista.reduce((a, p) => a + p.monto, 0);
    if (monto !== pedido.total) {
      throw reglaNegocio(`Registra el cobro completo del pedido: ${(pedido.total / 100).toFixed(2)} Bs`, { total: pedido.total, monto });
    }
    await cobrar(tx, venta!, lista, usuario.id);
    await tx.update(ventas).set({ pagado: pedido.total, saldo: 0, estadoPago: 'PAGADA' }).where(eq(ventas.id, venta!.id));
  }
  return { ...venta!, pagado: pedido.total, saldo: 0, estadoPago: 'PAGADA' as const };
}

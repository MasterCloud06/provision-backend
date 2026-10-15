import { and, eq, sql } from 'drizzle-orm';
import type { Exec } from '../../db/client.js';
import { movimientosInventario, productos, stock } from '../../db/schema/index.js';
import { noEncontrado, reglaNegocio } from '../../lib/errors.js';

type TipoMovimiento = (typeof movimientosInventario.$inferInsert)['tipo'];

export type MovimientoStock = {
  productoId: string;
  sucursalId: string;
  tipo: TipoMovimiento;
  /** Positivo entra, negativo sale. */
  cantidad: number;
  /** Costo de compra unitario (solo entradas): actualiza el costo promedio ponderado. */
  costoUnitario?: number | null;
  motivo?: string | null;
  referenciaTipo?: string | null;
  referenciaId?: string | null;
  usuarioId?: string | null;
};

/**
 * Único punto por el que cambian las existencias. Bloquea la fila de stock, valida que no
 * quede en negativo, recalcula el costo promedio en entradas y deja el registro en el kardex.
 * Devuelve null si el producto no controla stock (servicios).
 */
export async function moverStock(tx: Exec, m: MovimientoStock) {
  const [producto] = await tx
    .select({
      id: productos.id,
      nombre: productos.nombre,
      controlaStock: productos.controlaStock,
      costoPromedio: productos.costoPromedio,
    })
    .from(productos)
    .where(eq(productos.id, m.productoId))
    .for('update');
  if (!producto) throw noEncontrado('Producto');
  if (!producto.controlaStock) return null;
  if (m.cantidad === 0) throw reglaNegocio('La cantidad del movimiento no puede ser cero');

  await tx
    .insert(stock)
    .values({ productoId: m.productoId, sucursalId: m.sucursalId, cantidad: 0 })
    .onConflictDoNothing();

  const [actual] = await tx
    .select({ cantidad: stock.cantidad })
    .from(stock)
    .where(and(eq(stock.productoId, m.productoId), eq(stock.sucursalId, m.sucursalId)))
    .for('update');
  const anterior = actual!.cantidad;
  const resultante = anterior + m.cantidad;

  if (resultante < 0) {
    throw reglaNegocio(`Stock insuficiente de "${producto.nombre}"`, {
      productoId: m.productoId,
      disponible: anterior,
      solicitado: -m.cantidad,
    });
  }

  // Costo promedio ponderado sobre el stock total de todas las sucursales.
  if (m.cantidad > 0 && m.costoUnitario != null && m.tipo === 'ENTRADA') {
    const [total] = await tx
      .select({ total: sql<number>`coalesce(sum(${stock.cantidad}), 0)::int` })
      .from(stock)
      .where(eq(stock.productoId, m.productoId));
    const existencias = total!.total;
    const nuevoCosto = Math.round(
      (existencias * producto.costoPromedio + m.cantidad * m.costoUnitario) / (existencias + m.cantidad),
    );
    await tx.update(productos).set({ costoPromedio: nuevoCosto }).where(eq(productos.id, m.productoId));
  }

  await tx
    .update(stock)
    .set({ cantidad: resultante, actualizadoEn: new Date() })
    .where(and(eq(stock.productoId, m.productoId), eq(stock.sucursalId, m.sucursalId)));

  const [mov] = await tx
    .insert(movimientosInventario)
    .values({
      productoId: m.productoId,
      sucursalId: m.sucursalId,
      tipo: m.tipo,
      cantidad: m.cantidad,
      stockResultante: resultante,
      costoUnitario: m.costoUnitario ?? producto.costoPromedio,
      motivo: m.motivo ?? null,
      referenciaTipo: m.referenciaTipo ?? null,
      referenciaId: m.referenciaId ?? null,
      usuarioId: m.usuarioId ?? null,
    })
    .returning();
  return mov!;
}

/** Ajuste por conteo físico: lleva el stock a la cantidad contada. */
export async function ajustarAConteo(
  tx: Exec,
  datos: { productoId: string; sucursalId: string; cantidadContada: number; motivo?: string | null; usuarioId: string },
) {
  const [actual] = await tx
    .select({ cantidad: stock.cantidad })
    .from(stock)
    .where(and(eq(stock.productoId, datos.productoId), eq(stock.sucursalId, datos.sucursalId)));
  const diferencia = datos.cantidadContada - (actual?.cantidad ?? 0);
  if (diferencia === 0) return null;
  return moverStock(tx, {
    productoId: datos.productoId,
    sucursalId: datos.sucursalId,
    tipo: 'AJUSTE',
    cantidad: diferencia,
    motivo: datos.motivo ?? 'Conteo físico',
    usuarioId: datos.usuarioId,
  });
}

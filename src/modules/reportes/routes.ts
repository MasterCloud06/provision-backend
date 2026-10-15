import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { ordenesTrabajo, productos, sesionesCaja, stock, usuarios, ventaItems, ventas } from '../../db/schema/index.js';
import { finDia, hoy, inicioDia } from '../../lib/fechas.js';
import { fecha, query, sucursalDe } from '../../lib/http.js';
import { requierePermiso } from '../../middleware/auth.js';

export function rutasReportes(db: DB) {
  const r = Router();
  r.use(requierePermiso('reportes.ver'));

  /** Indicadores del negocio para la pantalla principal. */
  r.get('/dashboard', async (req, res) => {
    const f = query(req, z.object({ sucursalId: z.uuid().optional(), desde: fecha.optional(), hasta: fecha.optional() }));
    const sucursalId = sucursalDe(req, f.sucursalId);
    const dia = hoy();
    const desde = f.desde ?? `${dia.slice(0, 7)}-01`;
    const hasta = f.hasta ?? dia;
    const activas = and(eq(ventas.sucursalId, sucursalId), eq(ventas.estado, 'ACTIVA'));
    const enPeriodo = and(activas, gte(ventas.creadoEn, inicioDia(desde)), lte(ventas.creadoEn, finDia(hasta)));
    const n = (s: ReturnType<typeof sql>) => sql<number>`coalesce(${s}, 0)`.mapWith(Number);

    const [[deHoy], [periodo], [margen], [porCobrar], ordenes, [bajoStock], top, porDia, porVendedor, [caja]] =
      await Promise.all([
        db
          .select({ ventas: n(sql`count(*)`), monto: n(sql`sum(${ventas.total})`) })
          .from(ventas)
          .where(and(activas, gte(ventas.creadoEn, inicioDia(dia)), lte(ventas.creadoEn, finDia(dia)))),
        db
          .select({
            ventas: n(sql`count(*)`),
            monto: n(sql`sum(${ventas.total})`),
            cobrado: n(sql`sum(${ventas.pagado})`),
            descuentos: n(sql`sum(${ventas.descuento})`),
          })
          .from(ventas)
          .where(enPeriodo),
        db
          .select({
            costo: n(sql`sum(${ventaItems.costoUnitario}::bigint * ${ventaItems.cantidad})`),
          })
          .from(ventaItems)
          .innerJoin(ventas, eq(ventas.id, ventaItems.ventaId))
          .where(enPeriodo),
        db
          .select({ monto: n(sql`sum(${ventas.saldo})`), ventas: n(sql`count(*)`) })
          .from(ventas)
          .where(and(activas, sql`${ventas.saldo} > 0`)),
        db
          .select({ estado: ordenesTrabajo.estado, cantidad: n(sql`count(*)`) })
          .from(ordenesTrabajo)
          .where(and(eq(ordenesTrabajo.sucursalId, sucursalId), sql`${ordenesTrabajo.estado} not in ('ENTREGADO','CANCELADO')`))
          .groupBy(ordenesTrabajo.estado),
        db
          .select({ cantidad: n(sql`count(*)`) })
          .from(productos)
          .leftJoin(stock, and(eq(stock.productoId, productos.id), eq(stock.sucursalId, sucursalId)))
          .where(
            and(
              eq(productos.activo, true),
              eq(productos.controlaStock, true),
              sql`coalesce(${stock.cantidad}, 0) <= ${productos.stockMinimo}`,
            ),
          ),
        db
          .select({
            productoId: ventaItems.productoId,
            producto: ventaItems.descripcion,
            unidades: n(sql`sum(${ventaItems.cantidad})`),
            monto: n(sql`sum(${ventaItems.total})`),
          })
          .from(ventaItems)
          .innerJoin(ventas, eq(ventas.id, ventaItems.ventaId))
          .where(enPeriodo)
          .groupBy(ventaItems.productoId, ventaItems.descripcion)
          .orderBy(sql`sum(${ventaItems.total}) desc`)
          .limit(10),
        db
          .select({
            dia: sql<string>`to_char(${ventas.creadoEn} at time zone 'America/La_Paz', 'YYYY-MM-DD')`,
            ventas: n(sql`count(*)`),
            monto: n(sql`sum(${ventas.total})`),
          })
          .from(ventas)
          .where(enPeriodo)
          .groupBy(sql`1`)
          .orderBy(sql`1`),
        db
          .select({
            vendedorId: ventas.vendedorId,
            vendedor: usuarios.nombre,
            ventas: n(sql`count(*)`),
            monto: n(sql`sum(${ventas.total})`),
          })
          .from(ventas)
          .innerJoin(usuarios, eq(usuarios.id, ventas.vendedorId))
          .where(enPeriodo)
          .groupBy(ventas.vendedorId, usuarios.nombre)
          .orderBy(sql`sum(${ventas.total}) desc`),
        db
          .select({ id: sesionesCaja.id, abiertaEn: sesionesCaja.abiertaEn })
          .from(sesionesCaja)
          .where(and(eq(sesionesCaja.sucursalId, sucursalId), eq(sesionesCaja.estado, 'ABIERTA'))),
      ]);

    res.json({
      periodo: { desde, hasta },
      hoy: deHoy,
      ventas: {
        ...periodo!,
        ticketPromedio: periodo!.ventas > 0 ? Math.round(periodo!.monto / periodo!.ventas) : 0,
      },
      // Ingreso neto (después de descuentos) contra el costo promedio de lo vendido.
      margenBruto: {
        ingreso: periodo!.monto,
        costo: margen!.costo,
        utilidad: periodo!.monto - margen!.costo,
        porcentaje: periodo!.monto > 0 ? Math.round(((periodo!.monto - margen!.costo) / periodo!.monto) * 100) : null,
      },
      cuentasPorCobrar: porCobrar,
      ordenesTrabajo: Object.fromEntries(ordenes.map((o) => [o.estado, o.cantidad])),
      productosBajoStock: bajoStock!.cantidad,
      topProductos: top,
      ventasPorDia: porDia,
      ventasPorVendedor: porVendedor,
      cajaAbierta: caja ?? null,
    });
  });

  return r;
}

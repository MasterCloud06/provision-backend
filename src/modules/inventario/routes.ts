import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { movimientosInventario, productos, proveedores, stock, usuarios } from '../../db/schema/index.js';
import { noEncontrado, reglaNegocio } from '../../lib/errors.js';
import { body, centavos, fecha, offset, paginacion, param, query, sucursalDe, usuarioDe } from '../../lib/http.js';
import { finDia, inicioDia } from '../../lib/fechas.js';
import { requierePermiso } from '../../middleware/auth.js';
import { ajustarAConteo, moverStock } from './servicio.js';

const lineas = <T extends z.ZodRawShape>(extra: T) =>
  z
    .array(z.object({ productoId: z.uuid(), ...extra }))
    .min(1)
    .refine(
      (ls) => new Set((ls as { productoId: string }[]).map((l) => l.productoId)).size === ls.length,
      'Hay productos repetidos',
    );

export function rutasInventario(db: DB) {
  const r = Router();
  r.use(requierePermiso('inventario.ver'));

  /** Productos con stock en o por debajo del mínimo: la lista de reposición. */
  r.get('/alertas', async (req, res) => {
    const { sucursalId: s } = query(req, z.object({ sucursalId: z.uuid().optional() }));
    const sucursalId = sucursalDe(req, s);
    const cantidad = sql<number>`coalesce(${stock.cantidad}, 0)`.mapWith(Number);
    const filas = await db
      .select({
        id: productos.id,
        sku: productos.sku,
        nombre: productos.nombre,
        tipo: productos.tipo,
        stock: cantidad,
        stockMinimo: productos.stockMinimo,
        faltante: sql<number>`${productos.stockMinimo} - ${cantidad}`.mapWith(Number),
      })
      .from(productos)
      .leftJoin(stock, and(eq(stock.productoId, productos.id), eq(stock.sucursalId, sucursalId)))
      .where(
        and(
          eq(productos.activo, true),
          eq(productos.controlaStock, true),
          sql`${cantidad} <= ${productos.stockMinimo}`,
        ),
      )
      .orderBy(sql`${cantidad} asc`, productos.nombre);
    res.json(filas);
  });

  /** Valor del inventario (a costo promedio y a precio de venta) por sucursal. */
  r.get('/valorizacion', async (req, res) => {
    const { sucursalId: s } = query(req, z.object({ sucursalId: z.uuid().optional() }));
    const sucursalId = sucursalDe(req, s);
    const [v] = await db
      .select({
        unidades: sql<number>`coalesce(sum(${stock.cantidad}), 0)`.mapWith(Number),
        valorCosto: sql<number>`coalesce(sum(${stock.cantidad}::bigint * ${productos.costoPromedio}), 0)`.mapWith(Number),
        valorVenta: sql<number>`coalesce(sum(${stock.cantidad}::bigint * ${productos.precioVenta}), 0)`.mapWith(Number),
      })
      .from(stock)
      .innerJoin(productos, eq(productos.id, stock.productoId))
      .where(eq(stock.sucursalId, sucursalId));
    res.json({ sucursalId, ...v });
  });

  /** Kardex de un producto: historial de movimientos con stock resultante. */
  r.get('/kardex/:id', async (req, res) => {
    const productoId = param(req);
    const f = query(
      req,
      paginacion.extend({ sucursalId: z.uuid().optional(), desde: fecha.optional(), hasta: fecha.optional() }),
    );
    const sucursalId = sucursalDe(req, f.sucursalId);
    const datos = await db
      .select({
        id: movimientosInventario.id,
        tipo: movimientosInventario.tipo,
        cantidad: movimientosInventario.cantidad,
        stockResultante: movimientosInventario.stockResultante,
        costoUnitario: movimientosInventario.costoUnitario,
        motivo: movimientosInventario.motivo,
        referenciaTipo: movimientosInventario.referenciaTipo,
        referenciaId: movimientosInventario.referenciaId,
        usuario: usuarios.nombre,
        creadoEn: movimientosInventario.creadoEn,
      })
      .from(movimientosInventario)
      .leftJoin(usuarios, eq(usuarios.id, movimientosInventario.usuarioId))
      .where(
        and(
          eq(movimientosInventario.productoId, productoId),
          eq(movimientosInventario.sucursalId, sucursalId),
          f.desde ? gte(movimientosInventario.creadoEn, inicioDia(f.desde)) : undefined,
          f.hasta ? lte(movimientosInventario.creadoEn, finDia(f.hasta)) : undefined,
        ),
      )
      .orderBy(desc(movimientosInventario.creadoEn))
      .limit(f.porPagina)
      .offset(offset(f));
    res.json(datos);
  });

  /** Recepción de mercadería: varias líneas con su costo, opcionalmente de un proveedor. */
  r.post('/entradas', requierePermiso('inventario.recibir'), async (req, res) => {
    const d = body(
      req,
      z.object({
        sucursalId: z.uuid().optional(),
        proveedorId: z.uuid().optional(),
        documento: z.string().trim().max(60).optional(), // nro. de factura o remito
        items: lineas({ cantidad: z.number().int().positive(), costoUnitario: centavos }),
      }),
    );
    const sucursalId = sucursalDe(req, d.sucursalId);
    const usuario = usuarioDe(req);
    const recepcionId = randomUUID();
    const movimientos = await db.transaction(async (tx) => {
      let proveedor: string | undefined;
      if (d.proveedorId) {
        const [p] = await tx.select().from(proveedores).where(eq(proveedores.id, d.proveedorId));
        if (!p) throw noEncontrado('Proveedor');
        proveedor = p.nombre;
      }
      const motivo = ['Recepción', proveedor && `de ${proveedor}`, d.documento && `doc. ${d.documento}`]
        .filter(Boolean)
        .join(' ');
      const res = [];
      for (const it of d.items) {
        const mov = await moverStock(tx, {
          ...it,
          sucursalId,
          tipo: 'ENTRADA',
          motivo,
          referenciaTipo: 'RECEPCION',
          referenciaId: recepcionId,
          usuarioId: usuario.id,
        });
        if (!mov) throw reglaNegocio('No se puede dar entrada a un producto que no controla stock (servicio)');
        res.push(mov);
      }
      return res;
    });
    res.status(201).json({ recepcionId, movimientos });
  });

  /** Bajas: roturas, mermas, muestras, uso interno. */
  r.post('/salidas', requierePermiso('inventario.bajas'), async (req, res) => {
    const d = body(
      req,
      z.object({
        sucursalId: z.uuid().optional(),
        motivo: z.string().trim().min(3).max(200),
        items: lineas({ cantidad: z.number().int().positive() }),
      }),
    );
    const sucursalId = sucursalDe(req, d.sucursalId);
    const usuario = usuarioDe(req);
    const movimientos = await db.transaction(async (tx) => {
      const res = [];
      for (const it of d.items) {
        const mov = await moverStock(tx, {
          productoId: it.productoId,
          sucursalId,
          tipo: 'SALIDA',
          cantidad: -it.cantidad,
          motivo: d.motivo,
          usuarioId: usuario.id,
        });
        if (mov) res.push(mov);
      }
      return res;
    });
    res.status(201).json({ movimientos });
  });

  /** Conteo físico: se envía lo contado y el sistema ajusta las diferencias. */
  r.post('/ajustes', requierePermiso('inventario.ajustar'), async (req, res) => {
    const d = body(
      req,
      z.object({
        sucursalId: z.uuid().optional(),
        motivo: z.string().trim().max(200).optional(),
        items: lineas({ cantidadContada: z.number().int().nonnegative() }),
      }),
    );
    const sucursalId = sucursalDe(req, d.sucursalId);
    const usuario = usuarioDe(req);
    const movimientos = await db.transaction(async (tx) => {
      const res = [];
      for (const it of d.items) {
        const mov = await ajustarAConteo(tx, { ...it, sucursalId, motivo: d.motivo, usuarioId: usuario.id });
        if (mov) res.push(mov);
      }
      return res;
    });
    res.status(201).json({ ajustados: movimientos.length, movimientos });
  });

  /** Traslado entre sucursales: sale de una y entra a otra en la misma transacción. */
  r.post('/transferencias', requierePermiso('inventario.ajustar', 'sucursales.todas'), async (req, res) => {
    const d = body(
      req,
      z.object({
        origenId: z.uuid(),
        destinoId: z.uuid(),
        nota: z.string().trim().max(200).optional(),
        items: lineas({ cantidad: z.number().int().positive() }),
      }),
    );
    if (d.origenId === d.destinoId) throw reglaNegocio('Origen y destino deben ser distintos');
    const usuario = usuarioDe(req);
    const transferenciaId = randomUUID();
    const movimientos = await db.transaction(async (tx) => {
      const res = [];
      for (const it of d.items) {
        const comun = {
          productoId: it.productoId,
          motivo: d.nota ?? 'Transferencia entre sucursales',
          referenciaTipo: 'TRANSFERENCIA',
          referenciaId: transferenciaId,
          usuarioId: usuario.id,
        };
        const salida = await moverStock(tx, { ...comun, sucursalId: d.origenId, tipo: 'TRANSFERENCIA_SALIDA', cantidad: -it.cantidad });
        const entrada = await moverStock(tx, { ...comun, sucursalId: d.destinoId, tipo: 'TRANSFERENCIA_ENTRADA', cantidad: it.cantidad });
        if (salida && entrada) res.push(salida, entrada);
      }
      return res;
    });
    res.status(201).json({ transferenciaId, movimientos });
  });

  /** Ubicación física del producto en la sucursal (vitrina 3, cajón B...). */
  r.patch('/ubicacion/:id', requierePermiso('inventario.recibir'), async (req, res) => {
    const productoId = param(req);
    const d = body(req, z.object({ sucursalId: z.uuid().optional(), ubicacion: z.string().trim().max(60).nullable() }));
    const sucursalId = sucursalDe(req, d.sucursalId);
    const [fila] = await db
      .insert(stock)
      .values({ productoId, sucursalId, cantidad: 0, ubicacion: d.ubicacion })
      .onConflictDoUpdate({ target: [stock.productoId, stock.sucursalId], set: { ubicacion: d.ubicacion } })
      .returning();
    res.json(fila);
  });

  return r;
}

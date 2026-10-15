import { and, desc, eq, gt, gte, ilike, lte, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import {
  clientes,
  estadoTrabajo,
  historialTrabajo,
  metodoPago,
  ordenesTrabajo,
  pagos,
  recetas,
  usuarios,
  ventaItems,
  ventas,
} from '../../db/schema/index.js';
import { noEncontrado } from '../../lib/errors.js';
import { finDia, inicioDia } from '../../lib/fechas.js';
import { body, boolQuery, centavos, centavosPositivo, fecha, offset, paginacion, param, query, sucursalDe, usuarioDe } from '../../lib/http.js';
import { requiereRol, soloAdmin } from '../../middleware/auth.js';
import { anularVenta, cambiarEstadoTrabajo, crearVenta, registrarPagos } from './servicio.js';

const pagoEsquema = z.object({
  metodo: z.enum(metodoPago.enumValues),
  monto: centavosPositivo,
  referencia: z.string().trim().max(80).nullish(),
});

const ventaEsquema = z.object({
  sucursalId: z.uuid().optional(),
  clienteId: z.uuid().nullish(),
  recetaId: z.uuid().nullish(),
  items: z
    .array(
      z.object({
        productoId: z.uuid(),
        cantidad: z.number().int().positive(),
        precioUnitario: centavos.optional(),
        descuento: centavos.optional(),
      }),
    )
    .min(1, 'La venta debe tener al menos un ítem'),
  descuento: centavos.optional(),
  pagos: z.array(pagoEsquema).optional(),
  notas: z.string().trim().max(500).nullish(),
  ordenTrabajo: z
    .object({
      fechaPrometida: fecha.nullish(),
      instrucciones: z.string().trim().max(1000).nullish(),
      laboratorioExterno: z.string().trim().max(120).nullish(),
    })
    .nullish(),
});

export function rutasVentas(db: DB) {
  const r = Router();
  r.use(requiereRol('ADMIN', 'VENDEDOR'));

  r.get('/', async (req, res) => {
    const f = query(
      req,
      paginacion.extend({
        sucursalId: z.uuid().optional(),
        desde: fecha.optional(),
        hasta: fecha.optional(),
        clienteId: z.uuid().optional(),
        estado: z.enum(['ACTIVA', 'ANULADA']).optional(),
        estadoPago: z.enum(['PENDIENTE', 'PARCIAL', 'PAGADA']).optional(),
        conSaldo: boolQuery.optional(),
        q: z.string().trim().optional(),
      }),
    );
    const sucursalId = sucursalDe(req, f.sucursalId);
    const where = and(
      eq(ventas.sucursalId, sucursalId),
      f.desde ? gte(ventas.creadoEn, inicioDia(f.desde)) : undefined,
      f.hasta ? lte(ventas.creadoEn, finDia(f.hasta)) : undefined,
      f.clienteId ? eq(ventas.clienteId, f.clienteId) : undefined,
      f.estado ? eq(ventas.estado, f.estado) : undefined,
      f.estadoPago ? eq(ventas.estadoPago, f.estadoPago) : undefined,
      f.conSaldo ? and(gt(ventas.saldo, 0), eq(ventas.estado, 'ACTIVA')) : undefined,
      f.q ? ilike(ventas.numero, `%${f.q}%`) : undefined,
    );
    const [datos, [c]] = await Promise.all([
      db
        .select({
          id: ventas.id,
          numero: ventas.numero,
          cliente: clientes.nombre,
          clienteId: ventas.clienteId,
          vendedor: usuarios.nombre,
          estado: ventas.estado,
          estadoPago: ventas.estadoPago,
          total: ventas.total,
          pagado: ventas.pagado,
          saldo: ventas.saldo,
          creadoEn: ventas.creadoEn,
        })
        .from(ventas)
        .leftJoin(clientes, eq(clientes.id, ventas.clienteId))
        .leftJoin(usuarios, eq(usuarios.id, ventas.vendedorId))
        .where(where)
        .orderBy(desc(ventas.creadoEn))
        .limit(f.porPagina)
        .offset(offset(f)),
      db
        .select({
          total: sql<number>`count(*)::int`,
          monto: sql<number>`coalesce(sum(${ventas.total}) filter (where ${ventas.estado} = 'ACTIVA'), 0)`.mapWith(Number),
        })
        .from(ventas)
        .where(where),
    ]);
    res.json({ datos, total: c!.total, montoTotal: c!.monto, pagina: f.pagina, porPagina: f.porPagina });
  });

  r.get('/:id', async (req, res) => {
    const id = param(req);
    const [v] = await db.select().from(ventas).where(eq(ventas.id, id));
    if (!v) throw noEncontrado('Venta');
    sucursalDe(req, v.sucursalId);
    const [items, listaPagos, [cliente], [receta], [orden], [vendedor]] = await Promise.all([
      db.select().from(ventaItems).where(eq(ventaItems.ventaId, id)),
      db.select().from(pagos).where(eq(pagos.ventaId, id)).orderBy(pagos.creadoEn),
      v.clienteId ? db.select().from(clientes).where(eq(clientes.id, v.clienteId)) : Promise.resolve([]),
      v.recetaId ? db.select().from(recetas).where(eq(recetas.id, v.recetaId)) : Promise.resolve([]),
      db.select().from(ordenesTrabajo).where(eq(ordenesTrabajo.ventaId, id)),
      db.select({ id: usuarios.id, nombre: usuarios.nombre }).from(usuarios).where(eq(usuarios.id, v.vendedorId)),
    ]);
    res.json({
      ...v,
      items,
      pagos: listaPagos,
      cliente: cliente ?? null,
      receta: receta ?? null,
      ordenTrabajo: orden ?? null,
      vendedor: vendedor ?? null,
    });
  });

  r.post('/', async (req, res) => {
    const { sucursalId: s, ...d } = body(req, ventaEsquema);
    const sucursalId = sucursalDe(req, s);
    const venta = await db.transaction((tx) => crearVenta(tx, { ...d, sucursalId }, usuarioDe(req)));
    res.status(201).json(venta);
  });

  r.post('/:id/pagos', async (req, res) => {
    const d = body(req, z.object({ pagos: z.array(pagoEsquema).min(1) }));
    const r2 = await db.transaction((tx) => registrarPagos(tx, param(req), d.pagos, usuarioDe(req)));
    res.status(201).json(r2);
  });

  r.post('/:id/anular', soloAdmin, async (req, res) => {
    const d = body(
      req,
      z.object({ motivo: z.string().trim().min(5).max(300), metodoReembolso: z.enum(metodoPago.enumValues).optional() }),
    );
    const r2 = await db.transaction((tx) => anularVenta(tx, param(req), d, usuarioDe(req)));
    res.json(r2);
  });

  return r;
}

export function rutasOrdenesTrabajo(db: DB) {
  const r = Router();

  /** Tablero del laboratorio: órdenes por estado, con datos del cliente y la venta. */
  r.get('/', async (req, res) => {
    const f = query(
      req,
      paginacion.extend({
        sucursalId: z.uuid().optional(),
        estado: z.enum(estadoTrabajo.enumValues).optional(),
        atrasadas: boolQuery.optional(),
      }),
    );
    const sucursalId = sucursalDe(req, f.sucursalId);
    const datos = await db
      .select({
        id: ordenesTrabajo.id,
        numero: ordenesTrabajo.numero,
        estado: ordenesTrabajo.estado,
        fechaPrometida: ordenesTrabajo.fechaPrometida,
        laboratorioExterno: ordenesTrabajo.laboratorioExterno,
        ventaId: ventas.id,
        ventaNumero: ventas.numero,
        saldo: ventas.saldo,
        cliente: clientes.nombre,
        telefono: clientes.telefono,
        creadoEn: ordenesTrabajo.creadoEn,
      })
      .from(ordenesTrabajo)
      .innerJoin(ventas, eq(ventas.id, ordenesTrabajo.ventaId))
      .leftJoin(clientes, eq(clientes.id, ventas.clienteId))
      .where(
        and(
          eq(ordenesTrabajo.sucursalId, sucursalId),
          f.estado ? eq(ordenesTrabajo.estado, f.estado) : undefined,
          f.atrasadas
            ? sql`${ordenesTrabajo.fechaPrometida} < (now() at time zone 'America/La_Paz')::date
                  and ${ordenesTrabajo.estado} in ('PENDIENTE', 'EN_LABORATORIO')`
            : undefined,
        ),
      )
      .orderBy(sql`${ordenesTrabajo.fechaPrometida} asc nulls last`, ordenesTrabajo.creadoEn)
      .limit(f.porPagina)
      .offset(offset(f));
    res.json(datos);
  });

  r.get('/:id', async (req, res) => {
    const id = param(req);
    const [ot] = await db.select().from(ordenesTrabajo).where(eq(ordenesTrabajo.id, id));
    if (!ot) throw noEncontrado('Orden de trabajo');
    sucursalDe(req, ot.sucursalId);
    const [historial, [receta], items] = await Promise.all([
      db
        .select({
          estadoAnterior: historialTrabajo.estadoAnterior,
          estadoNuevo: historialTrabajo.estadoNuevo,
          nota: historialTrabajo.nota,
          usuario: usuarios.nombre,
          creadoEn: historialTrabajo.creadoEn,
        })
        .from(historialTrabajo)
        .leftJoin(usuarios, eq(usuarios.id, historialTrabajo.usuarioId))
        .where(eq(historialTrabajo.ordenId, id))
        .orderBy(historialTrabajo.creadoEn),
      ot.recetaId ? db.select().from(recetas).where(eq(recetas.id, ot.recetaId)) : Promise.resolve([]),
      db.select().from(ventaItems).where(eq(ventaItems.ventaId, ot.ventaId)),
    ]);
    res.json({ ...ot, receta: receta ?? null, items, historial });
  });

  r.patch('/:id', async (req, res) => {
    const d = body(
      req,
      z.object({
        fechaPrometida: fecha.nullish(),
        instrucciones: z.string().trim().max(1000).nullish(),
        laboratorioExterno: z.string().trim().max(120).nullish(),
      }),
    );
    const [ot] = await db.update(ordenesTrabajo).set(d).where(eq(ordenesTrabajo.id, param(req))).returning();
    if (!ot) throw noEncontrado('Orden de trabajo');
    res.json(ot);
  });

  r.post('/:id/estado', async (req, res) => {
    const d = body(req, z.object({ estado: z.enum(estadoTrabajo.enumValues), nota: z.string().trim().max(300).nullish() }));
    const ot = await db.transaction((tx) => cambiarEstadoTrabajo(tx, param(req), d, usuarioDe(req)));
    res.json(ot);
  });

  return r;
}

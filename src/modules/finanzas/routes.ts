import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB, Exec } from '../../db/client.js';
import {
  categoriasPersonales,
  cuentasPersonales,
  presupuestos,
  tipoCuentaPersonal,
  transaccionesPersonales,
} from '../../db/schema/index.js';
import { noEncontrado, reglaNegocio } from '../../lib/errors.js';
import { hoy, rangoMes } from '../../lib/fechas.js';
import { body, centavos, centavosPositivo, fecha, mes, offset, paginacion, param, query, usuarioDe } from '../../lib/http.js';
import { cuentaDelUsuario, saldosCuentas } from './servicio.js';

const t = transaccionesPersonales;

async function categoriaDelUsuario(tx: Exec, usuarioId: string, id: string) {
  const [c] = await tx
    .select()
    .from(categoriasPersonales)
    .where(and(eq(categoriasPersonales.id, id), eq(categoriasPersonales.usuarioId, usuarioId)));
  if (!c) throw noEncontrado('Categoría');
  return c;
}

const transaccionEsquema = z.object({
  tipo: z.enum(['INGRESO', 'GASTO', 'TRANSFERENCIA']),
  cuentaId: z.uuid(),
  cuentaDestinoId: z.uuid().nullish(),
  categoriaId: z.uuid().nullish(),
  monto: centavosPositivo,
  fecha: fecha.optional(),
  descripcion: z.string().trim().max(300).nullish(),
});

type DatosTransaccion = z.infer<typeof transaccionEsquema>;

/** Valida que cuentas y categoría sean del usuario y coherentes con el tipo. */
async function validarTransaccion(tx: Exec, usuarioId: string, d: DatosTransaccion) {
  await cuentaDelUsuario(tx, usuarioId, d.cuentaId);
  if (d.tipo === 'TRANSFERENCIA') {
    if (!d.cuentaDestinoId) throw reglaNegocio('Una transferencia necesita cuentaDestinoId');
    if (d.cuentaDestinoId === d.cuentaId) throw reglaNegocio('La cuenta destino debe ser distinta');
    await cuentaDelUsuario(tx, usuarioId, d.cuentaDestinoId);
    if (d.categoriaId) throw reglaNegocio('Las transferencias no llevan categoría');
  } else {
    if (d.cuentaDestinoId) throw reglaNegocio('Solo las transferencias llevan cuenta destino');
    if (!d.categoriaId) throw reglaNegocio('Indica la categoría del ingreso o gasto');
    const cat = await categoriaDelUsuario(tx, usuarioId, d.categoriaId);
    if (cat.tipo !== d.tipo) throw reglaNegocio(`La categoría "${cat.nombre}" es de tipo ${cat.tipo}`);
  }
}

export function rutasFinanzas(db: DB) {
  const r = Router();

  /* ── Cuentas ── */

  r.get('/cuentas', async (req, res) => {
    const cuentas = await saldosCuentas(db, usuarioDe(req).id);
    const patrimonio = cuentas.filter((c) => !c.archivada).reduce((a, c) => a + c.saldo, 0);
    res.json({ cuentas, patrimonio });
  });

  const cuentaEsquema = z.object({
    nombre: z.string().trim().min(1).max(80),
    tipo: z.enum(tipoCuentaPersonal.enumValues),
    saldoInicial: z.number().int(), // puede ser negativo (tarjeta de crédito)
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
    archivada: z.boolean().optional(),
  });

  r.post('/cuentas', async (req, res) => {
    const d = body(req, cuentaEsquema.extend({ saldoInicial: z.number().int().default(0) }));
    const [c] = await db.insert(cuentasPersonales).values({ ...d, usuarioId: usuarioDe(req).id }).returning();
    res.status(201).json(c);
  });

  r.patch('/cuentas/:id', async (req, res) => {
    const [c] = await db
      .update(cuentasPersonales)
      .set(body(req, cuentaEsquema.partial()))
      .where(and(eq(cuentasPersonales.id, param(req)), eq(cuentasPersonales.usuarioId, usuarioDe(req).id)))
      .returning();
    if (!c) throw noEncontrado('Cuenta');
    res.json(c);
  });

  /* ── Categorías ── */

  r.get('/categorias', async (req, res) => {
    res.json(
      await db
        .select()
        .from(categoriasPersonales)
        .where(eq(categoriasPersonales.usuarioId, usuarioDe(req).id))
        .orderBy(categoriasPersonales.tipo, categoriasPersonales.nombre),
    );
  });

  const categoriaEsquema = z.object({
    nombre: z.string().trim().min(1).max(60),
    tipo: z.enum(['INGRESO', 'GASTO']),
    icono: z.string().trim().max(40).nullish(),
    archivada: z.boolean().optional(),
  });

  r.post('/categorias', async (req, res) => {
    const [c] = await db
      .insert(categoriasPersonales)
      .values({ ...body(req, categoriaEsquema), usuarioId: usuarioDe(req).id })
      .returning();
    res.status(201).json(c);
  });

  r.patch('/categorias/:id', async (req, res) => {
    const [c] = await db
      .update(categoriasPersonales)
      .set(body(req, categoriaEsquema.omit({ tipo: true }).partial()))
      .where(and(eq(categoriasPersonales.id, param(req)), eq(categoriasPersonales.usuarioId, usuarioDe(req).id)))
      .returning();
    if (!c) throw noEncontrado('Categoría');
    res.json(c);
  });

  /* ── Transacciones ── */

  r.get('/transacciones', async (req, res) => {
    const f = query(
      req,
      paginacion.extend({
        desde: fecha.optional(),
        hasta: fecha.optional(),
        mes: mes.optional(),
        cuentaId: z.uuid().optional(),
        categoriaId: z.uuid().optional(),
        tipo: z.enum(['INGRESO', 'GASTO', 'TRANSFERENCIA']).optional(),
      }),
    );
    const rango = f.mes ? rangoMes(f.mes) : { desde: f.desde, hasta: f.hasta };
    const usuarioId = usuarioDe(req).id;
    const datos = await db
      .select({
        id: t.id,
        tipo: t.tipo,
        monto: t.monto,
        fecha: t.fecha,
        descripcion: t.descripcion,
        cuentaId: t.cuentaId,
        cuentaDestinoId: t.cuentaDestinoId,
        categoriaId: t.categoriaId,
        categoria: categoriasPersonales.nombre,
        desdeCaja: sql<boolean>`${t.movimientoCajaId} is not null`,
        creadoEn: t.creadoEn,
      })
      .from(t)
      .leftJoin(categoriasPersonales, eq(categoriasPersonales.id, t.categoriaId))
      .where(
        and(
          eq(t.usuarioId, usuarioId),
          rango.desde ? gte(t.fecha, rango.desde) : undefined,
          rango.hasta ? lte(t.fecha, rango.hasta) : undefined,
          f.cuentaId ? sql`(${t.cuentaId} = ${f.cuentaId} or ${t.cuentaDestinoId} = ${f.cuentaId})` : undefined,
          f.categoriaId ? eq(t.categoriaId, f.categoriaId) : undefined,
          f.tipo ? eq(t.tipo, f.tipo) : undefined,
        ),
      )
      .orderBy(desc(t.fecha), desc(t.creadoEn))
      .limit(f.porPagina)
      .offset(offset(f));
    res.json(datos);
  });

  r.post('/transacciones', async (req, res) => {
    const d = body(req, transaccionEsquema);
    const usuarioId = usuarioDe(req).id;
    await validarTransaccion(db, usuarioId, d);
    const [nueva] = await db
      .insert(t)
      .values({ ...d, fecha: d.fecha ?? hoy(), usuarioId })
      .returning();
    res.status(201).json(nueva);
  });

  async function transaccionEditable(usuarioId: string, id: string) {
    const [actual] = await db.select().from(t).where(and(eq(t.id, id), eq(t.usuarioId, usuarioId)));
    if (!actual) throw noEncontrado('Transacción');
    if (actual.movimientoCajaId) {
      throw reglaNegocio('Esta transacción viene de un retiro de caja; corrígela desde la caja del negocio');
    }
    return actual;
  }

  r.patch('/transacciones/:id', async (req, res) => {
    const usuarioId = usuarioDe(req).id;
    const actual = await transaccionEditable(usuarioId, param(req));
    const cambios = body(req, transaccionEsquema.partial());
    const combinada = { ...actual, ...cambios } as DatosTransaccion;
    await validarTransaccion(db, usuarioId, combinada);
    const [act] = await db.update(t).set(cambios).where(eq(t.id, actual.id)).returning();
    res.json(act);
  });

  r.delete('/transacciones/:id', async (req, res) => {
    const actual = await transaccionEditable(usuarioDe(req).id, param(req));
    await db.delete(t).where(eq(t.id, actual.id));
    res.status(204).end();
  });

  /* ── Presupuestos ── */

  r.get('/presupuestos', async (req, res) => {
    const { mes: m } = query(req, z.object({ mes }));
    res.json(
      await db
        .select()
        .from(presupuestos)
        .where(and(eq(presupuestos.usuarioId, usuarioDe(req).id), eq(presupuestos.mes, m))),
    );
  });

  /** Crea o actualiza el presupuesto de una categoría de gasto para un mes. */
  r.put('/presupuestos', async (req, res) => {
    const d = body(req, z.object({ categoriaId: z.uuid(), mes, monto: centavos }));
    const usuarioId = usuarioDe(req).id;
    const cat = await categoriaDelUsuario(db, usuarioId, d.categoriaId);
    if (cat.tipo !== 'GASTO') throw reglaNegocio('Solo se presupuestan categorías de gasto');
    const [p] = await db
      .insert(presupuestos)
      .values({ ...d, usuarioId })
      .onConflictDoUpdate({
        target: [presupuestos.usuarioId, presupuestos.categoriaId, presupuestos.mes],
        set: { monto: d.monto },
      })
      .returning();
    res.json(p);
  });

  /* ── Resumen ── */

  /**
   * Foto del mes: ingresos, gastos, ahorro, gasto por categoría contra presupuesto,
   * y cuánto vino de retiros del negocio.
   */
  r.get('/resumen', async (req, res) => {
    const { mes: m } = query(req, z.object({ mes: mes.optional() }));
    const elMes = m ?? hoy().slice(0, 7);
    const { desde, hasta } = rangoMes(elMes);
    const usuarioId = usuarioDe(req).id;
    const enMes = and(eq(t.usuarioId, usuarioId), gte(t.fecha, desde), lte(t.fecha, hasta));

    const [[totales], porCategoria, listaPresupuestos, cuentas] = await Promise.all([
      db
        .select({
          ingresos: sql<number>`coalesce(sum(${t.monto}) filter (where ${t.tipo} = 'INGRESO'), 0)`.mapWith(Number),
          gastos: sql<number>`coalesce(sum(${t.monto}) filter (where ${t.tipo} = 'GASTO'), 0)`.mapWith(Number),
          desdeNegocio: sql<number>`coalesce(sum(${t.monto}) filter (where ${t.movimientoCajaId} is not null), 0)`.mapWith(Number),
        })
        .from(t)
        .where(enMes),
      db
        .select({
          categoriaId: categoriasPersonales.id,
          categoria: categoriasPersonales.nombre,
          tipo: categoriasPersonales.tipo,
          total: sql<number>`sum(${t.monto})`.mapWith(Number),
        })
        .from(t)
        .innerJoin(categoriasPersonales, eq(categoriasPersonales.id, t.categoriaId))
        .where(enMes)
        .groupBy(categoriasPersonales.id, categoriasPersonales.nombre, categoriasPersonales.tipo)
        .orderBy(sql`sum(${t.monto}) desc`),
      db
        .select({
          categoriaId: presupuestos.categoriaId,
          categoria: categoriasPersonales.nombre,
          monto: presupuestos.monto,
        })
        .from(presupuestos)
        .innerJoin(categoriasPersonales, eq(categoriasPersonales.id, presupuestos.categoriaId))
        .where(and(eq(presupuestos.usuarioId, usuarioId), eq(presupuestos.mes, elMes))),
      saldosCuentas(db, usuarioId),
    ]);

    const gastoPorCategoria = new Map(porCategoria.filter((c) => c.tipo === 'GASTO').map((c) => [c.categoriaId, c.total]));
    const presupuesto = listaPresupuestos.map((p) => {
      const gastado = gastoPorCategoria.get(p.categoriaId) ?? 0;
      return {
        ...p,
        gastado,
        disponible: p.monto - gastado,
        porcentaje: p.monto > 0 ? Math.round((gastado / p.monto) * 100) : null,
        excedido: gastado > p.monto,
      };
    });

    res.json({
      mes: elMes,
      ingresos: totales!.ingresos,
      gastos: totales!.gastos,
      ahorro: totales!.ingresos - totales!.gastos,
      tasaAhorro: totales!.ingresos > 0 ? Math.round(((totales!.ingresos - totales!.gastos) / totales!.ingresos) * 100) : null,
      ingresosDesdeNegocio: totales!.desdeNegocio,
      porCategoria,
      presupuesto,
      patrimonio: cuentas.filter((c) => !c.archivada).reduce((a, c) => a + c.saldo, 0),
    });
  });

  return r;
}

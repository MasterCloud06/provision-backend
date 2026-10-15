import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { clientes, recetas, ventas } from '../../db/schema/index.js';
import { noEncontrado } from '../../lib/errors.js';
import { body, fecha, offset, paginacion, param, query, usuarioDe } from '../../lib/http.js';
import { requierePermiso } from '../../middleware/auth.js';

const clienteEsquema = z.object({
  nombre: z.string().trim().min(2).max(160),
  ci: z.string().trim().max(30).nullish(),
  nit: z.string().trim().max(30).nullish(),
  telefono: z.string().trim().max(40).nullish(),
  email: z.email().nullish(),
  fechaNacimiento: fecha.nullish(),
  direccion: z.string().trim().nullish(),
  notas: z.string().trim().nullish(),
});

const esfera = z.number().min(-30).max(30).multipleOf(0.25).nullish();
const cilindro = z.number().min(-10).max(10).multipleOf(0.25).nullish();
const eje = z.number().int().min(0).max(180).nullish();
const adicion = z.number().min(0).max(4).multipleOf(0.25).nullish();
const mm = z.number().min(0).max(99.9).nullish();

const recetaEsquema = z.object({
  fecha,
  profesional: z.string().trim().max(120).nullish(),
  odEsfera: esfera,
  odCilindro: cilindro,
  odEje: eje,
  odAdicion: adicion,
  odAgudezaVisual: z.string().trim().max(20).nullish(),
  oiEsfera: esfera,
  oiCilindro: cilindro,
  oiEje: eje,
  oiAdicion: adicion,
  oiAgudezaVisual: z.string().trim().max(20).nullish(),
  dnpOd: mm,
  dnpOi: mm,
  alturaFocal: mm,
  usoRecomendado: z.string().trim().max(60).nullish(),
  observaciones: z.string().trim().nullish(),
});

/** Si hay cilindro debe haber eje, y viceversa. */
const recetaCoherente = <T extends z.ZodType<Partial<z.infer<typeof recetaEsquema>>>>(s: T) =>
  s.superRefine((r, ctx) => {
    for (const ojo of ['od', 'oi'] as const) {
      const cil = r[`${ojo}Cilindro`];
      const ej = r[`${ojo}Eje`];
      if (cil != null && cil !== 0 && ej == null) {
        ctx.addIssue({ code: 'custom', path: [`${ojo}Eje`], message: 'Con cilindro se requiere eje' });
      }
    }
  });

export function rutasClientes(db: DB) {
  const r = Router();
  r.use(requierePermiso('clientes.ver'));
  const gestiona = requierePermiso('clientes.gestionar');
  const recetasPermiso = requierePermiso('recetas.gestionar');

  r.get('/', async (req, res) => {
    const f = query(req, paginacion.extend({ q: z.string().trim().optional() }));
    const where = f.q
      ? or(
          ilike(clientes.nombre, `%${f.q}%`),
          ilike(clientes.ci, `%${f.q}%`),
          ilike(clientes.telefono, `%${f.q}%`),
          ilike(clientes.nit, `%${f.q}%`),
        )
      : undefined;
    const [datos, [c]] = await Promise.all([
      db.select().from(clientes).where(where).orderBy(clientes.nombre).limit(f.porPagina).offset(offset(f)),
      db.select({ total: sql<number>`count(*)::int` }).from(clientes).where(where),
    ]);
    res.json({ datos, total: c!.total, pagina: f.pagina, porPagina: f.porPagina });
  });

  /** Ficha completa: datos, recetas, compras y deuda pendiente. */
  r.get('/:id', async (req, res) => {
    const id = param(req);
    const [cliente] = await db.select().from(clientes).where(eq(clientes.id, id));
    if (!cliente) throw noEncontrado('Cliente');
    const [listaRecetas, compras] = await Promise.all([
      db.select().from(recetas).where(eq(recetas.clienteId, id)).orderBy(desc(recetas.fecha)),
      db
        .select({
          id: ventas.id,
          numero: ventas.numero,
          total: ventas.total,
          saldo: ventas.saldo,
          estado: ventas.estado,
          estadoPago: ventas.estadoPago,
          creadoEn: ventas.creadoEn,
        })
        .from(ventas)
        .where(eq(ventas.clienteId, id))
        .orderBy(desc(ventas.creadoEn))
        .limit(50),
    ]);
    const saldoPendiente = compras
      .filter((v) => v.estado === 'ACTIVA')
      .reduce((acc, v) => acc + v.saldo, 0);
    res.json({ ...cliente, recetas: listaRecetas, compras, saldoPendiente });
  });

  r.post('/', gestiona, async (req, res) => {
    const [c] = await db.insert(clientes).values(body(req, clienteEsquema)).returning();
    res.status(201).json(c);
  });

  r.patch('/:id', gestiona, async (req, res) => {
    const [c] = await db
      .update(clientes)
      .set(body(req, clienteEsquema.partial()))
      .where(eq(clientes.id, param(req)))
      .returning();
    if (!c) throw noEncontrado('Cliente');
    res.json(c);
  });

  /* Recetas */

  r.post('/:id/recetas', recetasPermiso, async (req, res) => {
    const clienteId = param(req);
    const [cliente] = await db.select({ id: clientes.id }).from(clientes).where(eq(clientes.id, clienteId));
    if (!cliente) throw noEncontrado('Cliente');
    const datos = body(req, recetaCoherente(recetaEsquema));
    const [receta] = await db
      .insert(recetas)
      .values({ ...datos, clienteId, registradoPor: usuarioDe(req).id })
      .returning();
    res.status(201).json(receta);
  });

  r.patch('/:id/recetas/:recetaId', recetasPermiso, async (req, res) => {
    const datos = body(req, recetaCoherente(recetaEsquema.partial()));
    const [receta] = await db
      .update(recetas)
      .set(datos)
      .where(and(eq(recetas.id, param(req, 'recetaId')), eq(recetas.clienteId, param(req))))
      .returning();
    if (!receta) throw noEncontrado('Receta');
    res.json(receta);
  });

  return r;
}

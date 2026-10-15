import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { eventos, resultadoEvento, rolUsuario, sucursales } from '../../db/schema/index.js';
import { finDia, hoy, inicioDia } from '../../lib/fechas.js';
import { fecha, offset, paginacion, query } from '../../lib/http.js';
import { NOMBRE_ROL, ROLES } from '../../lib/permisos.js';
import { requierePermiso } from '../../middleware/auth.js';

const filtros = z.object({
  desde: fecha.optional(),
  hasta: fecha.optional(),
  rol: z.enum(rolUsuario.enumValues).optional(),
  usuarioId: z.uuid().optional(),
  sucursalId: z.uuid().optional(),
  modulo: z.string().trim().max(30).optional(),
  resultado: z.enum(resultadoEvento.enumValues).optional(),
  q: z.string().trim().max(100).optional(),
});

type Filtros = z.infer<typeof filtros>;

/** Últimos 7 días por defecto. */
function rango(f: Filtros) {
  const hasta = f.hasta ?? hoy();
  const desde = f.desde ?? new Date(new Date(`${hasta}T12:00:00-04:00`).getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  return { desde, hasta };
}

function condiciones(f: Filtros): SQL | undefined {
  const { desde, hasta } = rango(f);
  return and(
    gte(eventos.creadoEn, inicioDia(desde)),
    lte(eventos.creadoEn, finDia(hasta)),
    f.rol ? eq(eventos.rol, f.rol) : undefined,
    f.usuarioId ? eq(eventos.usuarioId, f.usuarioId) : undefined,
    f.sucursalId ? eq(eventos.sucursalId, f.sucursalId) : undefined,
    f.modulo ? eq(eventos.modulo, f.modulo) : undefined,
    f.resultado ? eq(eventos.resultado, f.resultado) : undefined,
    f.q ? or(ilike(eventos.descripcion, `%${f.q}%`), ilike(eventos.usuarioNombre, `%${f.q}%`)) : undefined,
  );
}

/** Registro de eventos de todos los roles. Exclusivo del super administrador. */
export function rutasAuditoria(db: DB) {
  const r = Router();
  r.use(requierePermiso('auditoria.ver'));
  const n = (s: SQL) => sql<number>`coalesce(${s}, 0)`.mapWith(Number);

  /** Dashboard: totales, actividad por rol, usuario, módulo y día, y los últimos intentos negados. */
  r.get('/resumen', async (req, res) => {
    const f = query(req, filtros);
    const where = condiciones(f);
    const negados = sql`${eventos.resultado} in ('DENEGADO', 'FALLIDO')`;

    const [[totales], porRol, porUsuario, porModulo, porDia, alertas] = await Promise.all([
      db
        .select({
          eventos: n(sql`count(*)`),
          exitos: n(sql`count(*) filter (where ${eventos.resultado} = 'EXITO')`),
          denegados: n(sql`count(*) filter (where ${eventos.resultado} = 'DENEGADO')`),
          rechazados: n(sql`count(*) filter (where ${eventos.resultado} = 'RECHAZADO')`),
          fallidos: n(sql`count(*) filter (where ${eventos.resultado} = 'FALLIDO')`),
          errores: n(sql`count(*) filter (where ${eventos.resultado} = 'ERROR')`),
          usuarios: n(sql`count(distinct ${eventos.usuarioId})`),
        })
        .from(eventos)
        .where(where),
      db
        .select({
          rol: eventos.rol,
          eventos: n(sql`count(*)`),
          denegados: n(sql`count(*) filter (where ${negados})`),
          usuarios: n(sql`count(distinct ${eventos.usuarioId})`),
          ultimo: sql<Date>`max(${eventos.creadoEn})`.mapWith(eventos.creadoEn),
        })
        .from(eventos)
        .where(where)
        .groupBy(eventos.rol),
      db
        .select({
          usuarioId: eventos.usuarioId,
          usuario: eventos.usuarioNombre,
          rol: eventos.rol,
          eventos: n(sql`count(*)`),
          denegados: n(sql`count(*) filter (where ${negados})`),
          ultimo: sql<Date>`max(${eventos.creadoEn})`.mapWith(eventos.creadoEn),
        })
        .from(eventos)
        .where(and(where, sql`${eventos.usuarioId} is not null`))
        .groupBy(eventos.usuarioId, eventos.usuarioNombre, eventos.rol)
        .orderBy(sql`count(*) desc`)
        .limit(15),
      db
        .select({ modulo: eventos.modulo, eventos: n(sql`count(*)`), denegados: n(sql`count(*) filter (where ${negados})`) })
        .from(eventos)
        .where(where)
        .groupBy(eventos.modulo)
        .orderBy(sql`count(*) desc`),
      db
        .select({
          dia: sql<string>`to_char(${eventos.creadoEn} at time zone 'America/La_Paz', 'YYYY-MM-DD')`,
          eventos: n(sql`count(*)`),
          denegados: n(sql`count(*) filter (where ${negados})`),
        })
        .from(eventos)
        .where(where)
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({
          id: eventos.id,
          creadoEn: eventos.creadoEn,
          usuario: eventos.usuarioNombre,
          rol: eventos.rol,
          descripcion: eventos.descripcion,
          resultado: eventos.resultado,
        })
        .from(eventos)
        .where(and(where, negados))
        .orderBy(desc(eventos.creadoEn))
        .limit(10),
    ]);

    // Todos los roles aparecen, aunque no hayan tenido actividad en el periodo.
    const porRolCompleto = ROLES.map((rol) => {
      const fila = porRol.find((p) => p.rol === rol);
      return { rol, nombre: NOMBRE_ROL[rol], eventos: fila?.eventos ?? 0, denegados: fila?.denegados ?? 0, usuarios: fila?.usuarios ?? 0, ultimo: fila?.ultimo ?? null };
    });
    const sinSesion = porRol.find((p) => p.rol === null);

    res.json({
      periodo: rango(f),
      totales,
      porRol: porRolCompleto,
      sinSesion: sinSesion?.eventos ?? 0, // intentos de ingreso con email desconocido
      porUsuario: porUsuario.map((u) => ({ ...u, nombreRol: u.rol ? NOMBRE_ROL[u.rol] : null })),
      porModulo,
      porDia,
      alertas: alertas.map((a) => ({ ...a, nombreRol: a.rol ? NOMBRE_ROL[a.rol] : null })),
    });
  });

  /** Lista de eventos con filtros, del más reciente al más antiguo. */
  r.get('/eventos', async (req, res) => {
    const f = query(req, filtros.extend(paginacion.shape));
    const where = condiciones(f);
    const [datos, [c]] = await Promise.all([
      db
        .select({
          id: eventos.id,
          creadoEn: eventos.creadoEn,
          usuarioId: eventos.usuarioId,
          usuario: eventos.usuarioNombre,
          rol: eventos.rol,
          sucursal: sucursales.nombre,
          modulo: eventos.modulo,
          accion: eventos.accion,
          descripcion: eventos.descripcion,
          resultado: eventos.resultado,
          entidadId: eventos.entidadId,
          ip: eventos.ip,
        })
        .from(eventos)
        .leftJoin(sucursales, eq(sucursales.id, eventos.sucursalId))
        .where(where)
        .orderBy(desc(eventos.creadoEn))
        .limit(f.porPagina)
        .offset(offset(f)),
      db.select({ total: sql<number>`count(*)::int` }).from(eventos).where(where),
    ]);
    res.json({
      datos: datos.map((d) => ({ ...d, nombreRol: d.rol ? NOMBRE_ROL[d.rol] : null })),
      total: c!.total,
      pagina: f.pagina,
      porPagina: f.porPagina,
    });
  });

  return r;
}

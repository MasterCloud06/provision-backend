import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { DB } from '../../db/client.js';
import { citas, estadoCita, motivoCita, usuarios } from '../../db/schema/index.js';
import { conflicto, noEncontrado } from '../../lib/errors.js';
import { body, fecha, param, query, sucursalDe, usuarioDe } from '../../lib/http.js';
import { ahoraBolivia } from '../../lib/horario.js';
import { requierePermiso } from '../../middleware/auth.js';
import { disponibilidad, MOTIVOS, reservar, siguientesCita } from './servicio.js';

const hora = z.string().regex(/^\d{2}:\d{2}$/, 'Hora en formato HH:MM');

/** Agenda de citas para el personal. */
export function rutasCitas(db: DB) {
  const r = Router();
  r.use(requierePermiso('citas.gestionar'));

  /** Configuración para las apps: motivos, duración y horario. */
  r.get('/config', (_req, res) => {
    res.json({ motivos: MOTIVOS, duracion: env.CITAS_DURACION, cupos: env.CITAS_CUPOS, horario: env.CITAS_HORARIO, diasAdelante: env.CITAS_DIAS_ADELANTE });
  });

  /** Citas de un rango de días (por defecto, hoy). */
  r.get('/', async (req, res) => {
    const f = query(req, z.object({ desde: fecha.optional(), hasta: fecha.optional(), sucursalId: z.uuid().optional() }));
    const sucursalId = sucursalDe(req, f.sucursalId);
    const desde = f.desde ?? ahoraBolivia().fecha;
    const hasta = f.hasta ?? desde;
    const lista = await db
      .select({
        id: citas.id,
        fecha: citas.fecha,
        hora: citas.hora,
        duracion: citas.duracion,
        motivo: citas.motivo,
        estado: citas.estado,
        nombreContacto: citas.nombreContacto,
        telefono: citas.telefono,
        notas: citas.notas,
        notasInternas: citas.notasInternas,
        canceladaMotivo: citas.canceladaMotivo,
        clienteId: citas.clienteId,
        desdeTienda: citas.cuentaId,
        atendidaPor: usuarios.nombre,
        creadoEn: citas.creadoEn,
      })
      .from(citas)
      .leftJoin(usuarios, eq(usuarios.id, citas.atendidaPor))
      .where(and(eq(citas.sucursalId, sucursalId), gte(citas.fecha, desde), lte(citas.fecha, hasta)))
      .orderBy(asc(citas.fecha), asc(citas.hora));
    res.json(
      lista.map((c) => ({ ...c, desdeTienda: c.desdeTienda != null, motivoTexto: MOTIVOS[c.motivo], siguientes: siguientesCita(c) })),
    );
  });

  r.get('/disponibilidad', async (req, res) => {
    const f = query(req, z.object({ desde: fecha.optional(), dias: z.coerce.number().int().min(1).max(31).default(7), sucursalId: z.uuid().optional() }));
    res.json(await disponibilidad(db, sucursalDe(req, f.sucursalId), f.desde, f.dias));
  });

  /** Cita reservada por el personal (por teléfono o en mostrador). Queda confirmada. */
  r.post('/', async (req, res) => {
    const u = usuarioDe(req);
    const d = body(
      req,
      z.object({
        fecha,
        hora,
        motivo: z.enum(motivoCita.enumValues).default('EXAMEN_VISTA'),
        nombreContacto: z.string().trim().min(2).max(160),
        telefono: z.string().trim().min(6).max(40),
        notas: z.string().trim().max(500).nullish(),
        clienteId: z.uuid().nullish(),
        sucursalId: z.uuid().optional(),
      }),
    );
    const cita = await reservar(db, { ...d, sucursalId: sucursalDe(req, d.sucursalId), creadaPor: u.id, estado: 'CONFIRMADA' });
    res.status(201).json({ ...cita, motivoTexto: MOTIVOS[cita.motivo] });
  });

  /** Confirmar, marcar atendida, no asistió o cancelar. `nota` se agrega a las notas internas. */
  r.post('/:id/estado', async (req, res) => {
    const u = usuarioDe(req);
    const d = body(req, z.object({ estado: z.enum(estadoCita.enumValues), nota: z.string().trim().max(500).optional() }));
    const [c] = await db.select().from(citas).where(eq(citas.id, param(req)));
    if (!c) throw noEncontrado('Cita');
    if (!siguientesCita(c).includes(d.estado)) throw conflicto('La cita ya no puede cambiar a ese estado');
    const [act] = await db
      .update(citas)
      .set({
        estado: d.estado,
        ...(d.estado === 'ATENDIDA' || d.estado === 'NO_ASISTIO' ? { atendidaPor: u.id } : {}),
        ...(d.estado === 'CANCELADA' ? { canceladaMotivo: d.nota ?? 'Cancelada por la óptica' } : {}),
        ...(d.nota ? { notasInternas: [c.notasInternas, `${u.nombre}: ${d.nota}`].filter(Boolean).join('\n') } : {}),
      })
      .where(eq(citas.id, c.id))
      .returning();
    res.json({ ...act!, motivoTexto: MOTIVOS[act!.motivo] });
  });

  return r;
}


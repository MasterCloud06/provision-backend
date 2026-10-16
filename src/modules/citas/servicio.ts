import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import type { DB, Exec } from '../../db/client.js';
import { citas, clientes, sucursales } from '../../db/schema/index.js';
import { conflicto, reglaNegocio } from '../../lib/errors.js';
import { ahoraBolivia, leerHorario, sumarDias, turnosDelDia } from '../../lib/horario.js';

export type Cita = typeof citas.$inferSelect;
export type EstadoCita = Cita['estado'];
export type MotivoCita = Cita['motivo'];

export const MOTIVOS: Record<MotivoCita, string> = {
  EXAMEN_VISTA: 'Examen de la vista',
  CONTROL: 'Control anual',
  LENTES_CONTACTO: 'Adaptación de lentes de contacto',
  AJUSTE: 'Ajuste o reparación de lentes',
  OTRO: 'Otro',
};

/** Estados que ocupan un turno. */
export const OCUPAN: EstadoCita[] = ['PENDIENTE', 'CONFIRMADA', 'ATENDIDA'];
/** Anticipación mínima para reservar un turno de hoy (minutos). */
const ANTICIPACION = 60;

const horario = () => leerHorario(env.CITAS_HORARIO);

export type Turno = { hora: string; libre: boolean };
export type DiaAgenda = { fecha: string; turnos: Turno[] };

/** Turnos de los próximos días con su disponibilidad. Solo trae días en que se atiende. */
export async function disponibilidad(db: Exec, sucursalId: string, desde?: string, dias = 14): Promise<DiaAgenda[]> {
  const ahora = ahoraBolivia();
  const inicio = desde && desde > ahora.fecha ? desde : ahora.fecha;
  const limite = sumarDias(ahora.fecha, env.CITAS_DIAS_ADELANTE);
  const fin = [sumarDias(inicio, dias - 1), limite].sort()[0]!;
  if (inicio > fin) return [];

  const ocupadas = await db
    .select({ fecha: citas.fecha, hora: citas.hora, n: sql<number>`count(*)::int` })
    .from(citas)
    .where(and(eq(citas.sucursalId, sucursalId), gte(citas.fecha, inicio), lte(citas.fecha, fin), inArray(citas.estado, OCUPAN)))
    .groupBy(citas.fecha, citas.hora);
  const usadas = new Map(ocupadas.map((o) => [`${o.fecha} ${o.hora}`, o.n]));

  const h = horario();
  const resultado: DiaAgenda[] = [];
  for (let f = inicio; f <= fin; f = sumarDias(f, 1)) {
    const turnos = turnosDelDia(h, f, env.CITAS_DURACION).map((hora) => {
      const [hh, mm] = hora.split(':').map(Number) as [number, number];
      const pasado = f === ahora.fecha && hh * 60 + mm < ahora.minutos + ANTICIPACION;
      return { hora, libre: !pasado && (usadas.get(`${f} ${hora}`) ?? 0) < env.CITAS_CUPOS };
    });
    if (turnos.length) resultado.push({ fecha: f, turnos });
  }
  return resultado;
}

export type DatosCita = {
  sucursalId: string;
  fecha: string;
  hora: string;
  motivo: MotivoCita;
  nombreContacto: string;
  telefono: string;
  notas?: string | null;
  clienteId?: string | null;
  cuentaId?: string | null;
  creadaPor?: string | null;
  estado?: EstadoCita;
};

/**
 * Reserva un turno. Bloquea la sucursal durante la transacción: dos personas que
 * eligen el mismo turno al mismo tiempo no pueden pasar el cupo.
 */
export async function reservar(db: DB, d: DatosCita) {
  return db.transaction(async (tx) => {
    await tx.select({ id: sucursales.id }).from(sucursales).where(eq(sucursales.id, d.sucursalId)).for('update');
    const ahora = ahoraBolivia();
    if (d.fecha < ahora.fecha) throw reglaNegocio('Esa fecha ya pasó');
    if (d.fecha > sumarDias(ahora.fecha, env.CITAS_DIAS_ADELANTE)) {
      throw reglaNegocio(`Solo se puede reservar hasta ${env.CITAS_DIAS_ADELANTE} días adelante`);
    }
    const [dia] = await disponibilidad(tx, d.sucursalId, d.fecha, 1);
    const turno = dia?.fecha === d.fecha ? dia.turnos.find((t) => t.hora === d.hora) : undefined;
    if (!turno) throw reglaNegocio('Ese horario no está dentro de la atención. Elige otro turno.');
    if (!turno.libre) throw conflicto('Ese turno ya no está disponible. Elige otro.');

    // Sin ficha de cliente (reserva por teléfono): se crea, así después se le carga la receta.
    let clienteId = d.clienteId ?? null;
    if (!clienteId) {
      const [c] = await tx
        .insert(clientes)
        .values({ nombre: d.nombreContacto, telefono: d.telefono, notas: 'Registrado al reservar una cita' })
        .returning({ id: clientes.id });
      clienteId = c!.id;
    }
    const [cita] = await tx
      .insert(citas)
      .values({
        sucursalId: d.sucursalId,
        clienteId,
        cuentaId: d.cuentaId ?? null,
        fecha: d.fecha,
        hora: d.hora,
        duracion: env.CITAS_DURACION,
        motivo: d.motivo,
        estado: d.estado ?? 'PENDIENTE',
        nombreContacto: d.nombreContacto,
        telefono: d.telefono,
        notas: d.notas ?? null,
        creadaPor: d.creadaPor ?? null,
      })
      .returning();
    return cita!;
  });
}

/** A qué estado puede pasar una cita (el personal). */
export function siguientesCita(c: Pick<Cita, 'estado'>): EstadoCita[] {
  switch (c.estado) {
    case 'PENDIENTE':
      return ['CONFIRMADA', 'ATENDIDA', 'NO_ASISTIO', 'CANCELADA'];
    case 'CONFIRMADA':
      return ['ATENDIDA', 'NO_ASISTIO', 'CANCELADA'];
    default:
      return [];
  }
}

/** Citas futuras activas de una cuenta de la tienda (para limitar reservas). */
export async function citasActivasDeCuenta(db: Exec, cuentaId: string) {
  const { fecha } = ahoraBolivia();
  return db
    .select()
    .from(citas)
    .where(and(eq(citas.cuentaId, cuentaId), gte(citas.fecha, fecha), inArray(citas.estado, ['PENDIENTE', 'CONFIRMADA'])))
    .orderBy(asc(citas.fecha), asc(citas.hora));
}

/** Para "Mi panel": citas de hoy y por confirmar. */
export async function resumenCitas(db: Exec, sucursalId: string | null) {
  const { fecha } = ahoraBolivia();
  const enSucursal = sucursalId ? eq(citas.sucursalId, sucursalId) : undefined;
  const [hoy] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(citas)
    .where(and(enSucursal, eq(citas.fecha, fecha), inArray(citas.estado, ['PENDIENTE', 'CONFIRMADA'])));
  const [porConfirmar] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(citas)
    .where(and(enSucursal, gte(citas.fecha, fecha), lte(citas.fecha, sumarDias(fecha, 1)), eq(citas.estado, 'PENDIENTE')));
  return { hoy: hoy!.n, porConfirmar: porConfirmar!.n };
}

export const noCancelada = ne(citas.estado, 'CANCELADA');

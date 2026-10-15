import { and, eq, sql } from 'drizzle-orm';
import type { Exec } from '../../db/client.js';
import { movimientosCaja, sesionesCaja } from '../../db/schema/index.js';
import { noEncontrado, reglaNegocio } from '../../lib/errors.js';

type NuevoMovimiento = typeof movimientosCaja.$inferInsert;
type Metodo = NuevoMovimiento['metodo'];

/** Caja abierta de la sucursal, bloqueada para la transacción. Falla si no hay ninguna. */
export async function cajaAbierta(tx: Exec, sucursalId: string) {
  const [s] = await tx
    .select()
    .from(sesionesCaja)
    .where(and(eq(sesionesCaja.sucursalId, sucursalId), eq(sesionesCaja.estado, 'ABIERTA')))
    .for('update');
  if (!s) throw reglaNegocio('No hay una caja abierta en esta sucursal. Abre caja para registrar cobros.');
  return s;
}

export async function registrarMovimientoCaja(tx: Exec, mov: NuevoMovimiento) {
  const [m] = await tx.insert(movimientosCaja).values(mov).returning();
  return m!;
}

const METODOS: Metodo[] = ['EFECTIVO', 'QR', 'TARJETA', 'TRANSFERENCIA'];

/**
 * Totales de una sesión por método de pago. Solo el efectivo se arquea físicamente;
 * QR, tarjeta y transferencia se concilian contra el banco.
 */
export async function resumenSesion(tx: Exec, sesionId: string) {
  const [sesion] = await tx.select().from(sesionesCaja).where(eq(sesionesCaja.id, sesionId));
  if (!sesion) throw noEncontrado('Sesión de caja');

  const filas = await tx
    .select({
      metodo: movimientosCaja.metodo,
      tipo: movimientosCaja.tipo,
      concepto: movimientosCaja.concepto,
      total: sql<number>`sum(${movimientosCaja.monto})`.mapWith(Number),
      cantidad: sql<number>`count(*)`.mapWith(Number),
    })
    .from(movimientosCaja)
    .where(eq(movimientosCaja.sesionCajaId, sesionId))
    .groupBy(movimientosCaja.metodo, movimientosCaja.tipo, movimientosCaja.concepto);

  const porMetodo = Object.fromEntries(
    METODOS.map((m) => {
      const ingresos = filas.filter((f) => f.metodo === m && f.tipo === 'INGRESO').reduce((a, f) => a + f.total, 0);
      const egresos = filas.filter((f) => f.metodo === m && f.tipo === 'EGRESO').reduce((a, f) => a + f.total, 0);
      return [m, { ingresos, egresos, neto: ingresos - egresos }];
    }),
  ) as Record<Metodo, { ingresos: number; egresos: number; neto: number }>;

  const porConcepto: Record<string, number> = {};
  for (const f of filas) {
    const signo = f.tipo === 'INGRESO' ? 1 : -1;
    porConcepto[f.concepto] = (porConcepto[f.concepto] ?? 0) + signo * f.total;
  }

  const efectivoEsperado = sesion.montoApertura + porMetodo.EFECTIVO.neto;
  const totalIngresos = METODOS.reduce((a, m) => a + porMetodo[m].ingresos, 0);
  const totalEgresos = METODOS.reduce((a, m) => a + porMetodo[m].egresos, 0);

  return { sesion, porMetodo, porConcepto, totalIngresos, totalEgresos, efectivoEsperado };
}

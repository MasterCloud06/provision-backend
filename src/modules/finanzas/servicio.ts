import { and, eq, sql } from 'drizzle-orm';
import type { Exec } from '../../db/client.js';
import { categoriasPersonales, cuentasPersonales, transaccionesPersonales } from '../../db/schema/index.js';
import { noEncontrado } from '../../lib/errors.js';

export const CATEGORIA_RETIROS = 'Retiros del negocio';

const POR_DEFECTO: { nombre: string; tipo: 'INGRESO' | 'GASTO'; icono: string }[] = [
  { nombre: CATEGORIA_RETIROS, tipo: 'INGRESO', icono: 'store' },
  { nombre: 'Sueldo', tipo: 'INGRESO', icono: 'wallet' },
  { nombre: 'Otros ingresos', tipo: 'INGRESO', icono: 'plus' },
  { nombre: 'Alimentación', tipo: 'GASTO', icono: 'utensils' },
  { nombre: 'Vivienda', tipo: 'GASTO', icono: 'home' },
  { nombre: 'Servicios básicos', tipo: 'GASTO', icono: 'bolt' },
  { nombre: 'Transporte', tipo: 'GASTO', icono: 'car' },
  { nombre: 'Salud', tipo: 'GASTO', icono: 'heart' },
  { nombre: 'Educación', tipo: 'GASTO', icono: 'book' },
  { nombre: 'Familia', tipo: 'GASTO', icono: 'users' },
  { nombre: 'Ocio', tipo: 'GASTO', icono: 'smile' },
  { nombre: 'Deudas y créditos', tipo: 'GASTO', icono: 'credit-card' },
  { nombre: 'Otros gastos', tipo: 'GASTO', icono: 'dots' },
];

export async function crearCategoriasPorDefecto(tx: Exec, usuarioId: string) {
  await tx
    .insert(categoriasPersonales)
    .values(POR_DEFECTO.map((c) => ({ ...c, usuarioId })))
    .onConflictDoNothing();
}

/** Busca una categoría del usuario por nombre y la crea si no existe. */
export async function categoriaPorNombre(tx: Exec, usuarioId: string, nombre: string, tipo: 'INGRESO' | 'GASTO') {
  await tx.insert(categoriasPersonales).values({ usuarioId, nombre, tipo }).onConflictDoNothing();
  const [c] = await tx
    .select()
    .from(categoriasPersonales)
    .where(
      and(
        eq(categoriasPersonales.usuarioId, usuarioId),
        eq(categoriasPersonales.nombre, nombre),
        eq(categoriasPersonales.tipo, tipo),
      ),
    );
  return c!;
}

export async function cuentaDelUsuario(tx: Exec, usuarioId: string, cuentaId: string) {
  const [c] = await tx
    .select()
    .from(cuentasPersonales)
    .where(and(eq(cuentasPersonales.id, cuentaId), eq(cuentasPersonales.usuarioId, usuarioId)));
  if (!c) throw noEncontrado('Cuenta personal');
  return c;
}

/**
 * Saldo de cada cuenta del usuario = saldo inicial + ingresos − gastos
 * − transferencias enviadas + transferencias recibidas.
 */
export async function saldosCuentas(tx: Exec, usuarioId: string) {
  const t = transaccionesPersonales;
  const efecto = sql<number>`
    coalesce((select sum(case
        when ${t.tipo} = 'INGRESO' then ${t.monto}
        when ${t.tipo} = 'GASTO' then -${t.monto}
        when ${t.tipo} = 'TRANSFERENCIA' then -${t.monto}
      end) from ${t} where ${t.cuentaId} = ${cuentasPersonales.id}), 0)
    + coalesce((select sum(${t.monto}) from ${t}
        where ${t.cuentaDestinoId} = ${cuentasPersonales.id} and ${t.tipo} = 'TRANSFERENCIA'), 0)`;
  return tx
    .select({
      id: cuentasPersonales.id,
      nombre: cuentasPersonales.nombre,
      tipo: cuentasPersonales.tipo,
      color: cuentasPersonales.color,
      archivada: cuentasPersonales.archivada,
      saldoInicial: cuentasPersonales.saldoInicial,
      saldo: sql<number>`${cuentasPersonales.saldoInicial} + ${efecto}`.mapWith(Number),
    })
    .from(cuentasPersonales)
    .where(eq(cuentasPersonales.usuarioId, usuarioId))
    .orderBy(cuentasPersonales.nombre);
}

import { and, asc, eq } from 'drizzle-orm';
import type { DB } from './client.js';
import { usuarios } from './schema/index.js';

/**
 * Garantiza que exista un super administrador. Si no hay ninguno (bases creadas antes de
 * que existiera el rol), asciende al administrador activo más antiguo: el dueño original.
 * Es idempotente; se llama al arrancar el servidor.
 */
export async function asegurarSuperadmin(db: DB): Promise<string | null> {
  const [hay] = await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.rol, 'SUPERADMIN')).limit(1);
  if (hay) return null;
  const [dueno] = await db
    .select({ id: usuarios.id, email: usuarios.email })
    .from(usuarios)
    .where(and(eq(usuarios.rol, 'ADMIN'), eq(usuarios.activo, true)))
    .orderBy(asc(usuarios.creadoEn))
    .limit(1);
  if (!dueno) return null;
  await db.update(usuarios).set({ rol: 'SUPERADMIN' }).where(eq(usuarios.id, dueno.id));
  return dueno.email;
}

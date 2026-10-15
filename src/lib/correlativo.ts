import { eq, sql } from 'drizzle-orm';
import type { Exec } from '../db/client.js';
import { correlativos, sucursales } from '../db/schema/index.js';
import { noEncontrado } from './errors.js';

/**
 * Siguiente número de una serie por sucursal, p. ej. siguienteNumero(tx, s, 'V') → "V-CAL-000124".
 * Debe llamarse dentro de la transacción que crea el documento: el UPDATE bloquea la fila
 * del contador, así dos ventas simultáneas nunca reciben el mismo número.
 */
export async function siguienteNumero(tx: Exec, sucursalId: string, serie: string): Promise<string> {
  const [s] = await tx.select({ codigo: sucursales.codigo }).from(sucursales).where(eq(sucursales.id, sucursalId));
  if (!s) throw noEncontrado('Sucursal');
  const [fila] = await tx
    .insert(correlativos)
    .values({ sucursalId, serie, ultimo: 1 })
    .onConflictDoUpdate({
      target: [correlativos.sucursalId, correlativos.serie],
      set: { ultimo: sql`${correlativos.ultimo} + 1` },
    })
    .returning({ ultimo: correlativos.ultimo });
  return `${serie}-${s.codigo}-${String(fila!.ultimo).padStart(6, '0')}`;
}

import { existsSync } from 'node:fs';
import { config } from 'dotenv';

export const ENTORNOS = ['local', 'desarrollo', 'test'] as const;
export type Entorno = (typeof ENTORNOS)[number];

/**
 * Lee APP_ENV (local por defecto) y carga el archivo `.env.<entorno>`.
 * Las variables ya definidas en el sistema tienen prioridad sobre el archivo,
 * así un servidor puede inyectar sus secretos sin tocar archivos.
 */
export function cargarEntorno(): Entorno {
  const app = (process.env.APP_ENV ?? 'local') as Entorno;
  if (!ENTORNOS.includes(app)) {
    throw new Error(`APP_ENV="${app}" no es válido. Usa: ${ENTORNOS.join(', ')}`);
  }
  const archivo = `.env.${app}`;
  if (existsSync(archivo)) config({ path: archivo, quiet: true });
  // En un servidor (Render) las variables vienen del sistema y el archivo no hace falta.
  else if (app !== 'test' && !process.env.DATABASE_URL) {
    console.warn(`[provision] No existe ${archivo}; copia ${archivo}.example y complétalo.`);
  }
  return app;
}

import type { Request } from 'express';
import { z } from 'zod';
import { AppError, prohibido, reglaNegocio } from './errors.js';

export type UsuarioSesion = {
  id: string;
  nombre: string;
  email: string;
  rol: 'ADMIN' | 'VENDEDOR' | 'LABORATORIO';
  sucursalId: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: UsuarioSesion;
    }
  }
}

function parsear<T extends z.ZodType>(esquema: T, datos: unknown, donde: string): z.infer<T> {
  const r = esquema.safeParse(datos);
  if (!r.success) {
    throw new AppError(400, 'VALIDACION', `Datos inválidos en ${donde}`, z.flattenError(r.error));
  }
  return r.data;
}

export const body = <T extends z.ZodType>(req: Request, esquema: T) => parsear(esquema, req.body, 'body');
export const query = <T extends z.ZodType>(req: Request, esquema: T) => parsear(esquema, req.query, 'query');
export const param = (req: Request, nombre = 'id') => parsear(z.uuid(), req.params[nombre], `parámetro ${nombre}`);

export function usuarioDe(req: Request): UsuarioSesion {
  if (!req.usuario) throw new AppError(401, 'NO_AUTENTICADO', 'No autenticado');
  return req.usuario;
}

/**
 * Decide en qué sucursal opera la petición: la del usuario por defecto.
 * Solo ADMIN puede operar sobre otra sucursal indicándola explícitamente.
 */
export function sucursalDe(req: Request, solicitada?: string | null): string {
  const u = usuarioDe(req);
  if (solicitada && solicitada !== u.sucursalId) {
    if (u.rol !== 'ADMIN') throw prohibido('Solo un administrador puede operar en otra sucursal');
    return solicitada;
  }
  if (!u.sucursalId) throw reglaNegocio('Indica sucursalId: tu usuario no tiene sucursal asignada');
  return u.sucursalId;
}

/* Esquemas reutilizables */

/** Monto en centavos de boliviano. Bs 150.50 = 15050. */
export const centavos = z.number().int().nonnegative().max(1_000_000_000);
export const centavosPositivo = z.number().int().positive().max(1_000_000_000);
export const fecha = z.iso.date(); // YYYY-MM-DD
export const mes = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato YYYY-MM');
export const paginacion = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  porPagina: z.coerce.number().int().min(1).max(200).default(50),
});
export const offset = (p: { pagina: number; porPagina: number }) => (p.pagina - 1) * p.porPagina;
export const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

import { eq } from 'drizzle-orm';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { DB } from '../db/client.js';
import { usuarios } from '../db/schema/index.js';
import { noAutorizado, prohibido } from '../lib/errors.js';
import type { UsuarioSesion } from '../lib/http.js';
import { tienePermiso, type Permiso } from '../lib/permisos.js';

export function firmarToken(usuarioId: string): string {
  return jwt.sign({ sub: usuarioId }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/** Verifica el token y recarga el usuario: si se desactiva o cambia de rol, aplica de inmediato. */
export function autenticar(db: DB): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw noAutorizado();
    let sub: string;
    try {
      const payload = jwt.verify(header.slice(7), env.JWT_SECRET);
      if (typeof payload === 'string' || !payload.sub) throw new Error();
      // Un token de cliente de la tienda web nunca abre el sistema interno.
      if (payload.aud === 'tienda' || (Array.isArray(payload.aud) && payload.aud.includes('tienda'))) throw new Error();
      sub = payload.sub;
    } catch {
      throw noAutorizado('Token inválido o expirado');
    }
    const [u] = await db
      .select({
        id: usuarios.id,
        nombre: usuarios.nombre,
        email: usuarios.email,
        rol: usuarios.rol,
        sucursalId: usuarios.sucursalId,
        activo: usuarios.activo,
      })
      .from(usuarios)
      .where(eq(usuarios.id, sub));
    if (!u || !u.activo) throw noAutorizado('Usuario inactivo');
    const { activo: _, ...sesion } = u;
    req.usuario = sesion satisfies UsuarioSesion;
    next();
  };
}

/** Exige uno o más permisos (todos). */
export function requierePermiso(...permisos: Permiso[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.usuario) throw noAutorizado();
    const falta = permisos.find((p) => !tienePermiso(req.usuario!.rol, p));
    if (falta) throw prohibido(`No tienes permiso para esta acción (${falta})`);
    next();
  };
}

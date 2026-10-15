import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { RequestHandler, Request } from 'express';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { DB } from '../../db/client.js';
import { clientes, cuentasTienda } from '../../db/schema/index.js';
import { AppError, conflicto, noAutorizado } from '../../lib/errors.js';
import { body } from '../../lib/http.js';

/** Los tokens de clientes llevan esta audiencia: el sistema interno los rechaza. */
export const AUDIENCIA_TIENDA = 'tienda';

export type ClienteSesion = { cuentaId: string; clienteId: string; email: string; nombre: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      cliente?: ClienteSesion;
    }
  }
}

const HASH_FALSO = bcrypt.hashSync('provision-tienda-hash-falso', 10);

export function firmarTokenCliente(cuentaId: string) {
  return jwt.sign({ sub: cuentaId }, env.JWT_SECRET, { audience: AUDIENCIA_TIENDA, expiresIn: '30d' });
}

export function clienteDe(req: Request): ClienteSesion {
  if (!req.cliente) throw noAutorizado('Inicia sesión para continuar');
  return req.cliente;
}

/** Verifica el token de cliente y recarga su cuenta (si se desactiva, aplica de inmediato). */
export function autenticarCliente(db: DB): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw noAutorizado('Inicia sesión para continuar');
    let sub: string;
    try {
      const payload = jwt.verify(header.slice(7), env.JWT_SECRET, { audience: AUDIENCIA_TIENDA });
      if (typeof payload === 'string' || !payload.sub) throw new Error();
      sub = payload.sub;
    } catch {
      throw noAutorizado('Tu sesión venció: vuelve a ingresar');
    }
    const [c] = await db
      .select({ cuentaId: cuentasTienda.id, clienteId: cuentasTienda.clienteId, email: cuentasTienda.email, nombre: clientes.nombre, activa: cuentasTienda.activa })
      .from(cuentasTienda)
      .innerJoin(clientes, eq(clientes.id, cuentasTienda.clienteId))
      .where(eq(cuentasTienda.id, sub));
    if (!c || !c.activa) throw noAutorizado('Tu cuenta no está activa');
    req.cliente = { cuentaId: c.cuentaId, clienteId: c.clienteId, email: c.email, nombre: c.nombre };
    next();
  };
}

const telefono = z.string().trim().min(6, 'Teléfono muy corto').max(40);
const password = z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(200);

async function perfil(db: DB, cuentaId: string) {
  const [p] = await db
    .select({
      id: cuentasTienda.id,
      email: cuentasTienda.email,
      nombre: clientes.nombre,
      telefono: clientes.telefono,
      ci: clientes.ci,
      nit: clientes.nit,
      direccion: clientes.direccion,
      creadoEn: cuentasTienda.creadoEn,
    })
    .from(cuentasTienda)
    .innerJoin(clientes, eq(clientes.id, cuentasTienda.clienteId))
    .where(eq(cuentasTienda.id, cuentaId));
  return p!;
}

/** Registro e ingreso de clientes (público). */
export function rutasAuthTienda(db: DB) {
  const r = Router();

  r.post('/registro', async (req, res) => {
    const d = body(
      req,
      z.object({
        nombre: z.string().trim().min(2, 'Escribe tu nombre completo').max(160),
        email: z.email('Correo no válido').trim().toLowerCase(),
        password,
        telefono: telefono.optional(),
        ci: z.string().trim().max(30).optional(),
      }),
    );
    const [existe] = await db.select({ id: cuentasTienda.id }).from(cuentasTienda).where(eq(cuentasTienda.email, d.email));
    if (existe) throw conflicto('Ya existe una cuenta con ese correo. ¿Quieres ingresar?');
    const passwordHash = await bcrypt.hash(d.password, 10);
    const cuentaId = await db.transaction(async (tx) => {
      // Ficha nueva en clientes: el personal la ve como cualquier cliente. No se une por correo a una
      // ficha existente porque nadie verificó que el correo sea suyo (expondría compras y recetas ajenas).
      const [c] = await tx
        .insert(clientes)
        .values({ nombre: d.nombre, email: d.email, telefono: d.telefono, ci: d.ci, notas: 'Registrado en la tienda web' })
        .returning({ id: clientes.id });
      const [cuenta] = await tx.insert(cuentasTienda).values({ clienteId: c!.id, email: d.email, passwordHash }).returning({ id: cuentasTienda.id });
      return cuenta!.id;
    });
    res.status(201).json({ token: firmarTokenCliente(cuentaId), cuenta: await perfil(db, cuentaId) });
  });

  r.post('/login', async (req, res) => {
    const d = body(req, z.object({ email: z.string().trim().toLowerCase(), password: z.string() }));
    const [c] = await db.select().from(cuentasTienda).where(eq(cuentasTienda.email, d.email));
    const ok = await bcrypt.compare(d.password, c?.passwordHash ?? HASH_FALSO);
    if (!c || !ok) throw noAutorizado('Correo o contraseña incorrectos');
    if (!c.activa) throw noAutorizado('Tu cuenta está desactivada. Comunícate con la óptica.');
    res.json({ token: firmarTokenCliente(c.id), cuenta: await perfil(db, c.id) });
  });

  return r;
}

/** Datos de la cuenta del cliente (requiere sesión de cliente). */
export function rutasCuentaTienda(db: DB) {
  const r = Router();

  r.get('/', async (req, res) => {
    res.json(await perfil(db, clienteDe(req).cuentaId));
  });

  r.patch('/', async (req, res) => {
    const c = clienteDe(req);
    const d = body(
      req,
      z.object({
        nombre: z.string().trim().min(2).max(160).optional(),
        telefono: telefono.nullish(),
        ci: z.string().trim().max(30).nullish(),
        nit: z.string().trim().max(30).nullish(),
        direccion: z.string().trim().max(400).nullish(),
      }),
    );
    if (Object.keys(d).length) await db.update(clientes).set(d).where(eq(clientes.id, c.clienteId));
    res.json(await perfil(db, c.cuentaId));
  });

  r.post('/password', async (req, res) => {
    const c = clienteDe(req);
    const d = body(req, z.object({ actual: z.string(), nueva: password }));
    const [fila] = await db.select().from(cuentasTienda).where(eq(cuentasTienda.id, c.cuentaId));
    if (!fila || !(await bcrypt.compare(d.actual, fila.passwordHash))) {
      throw new AppError(422, 'PASSWORD_INCORRECTA', 'La contraseña actual no es correcta');
    }
    await db.update(cuentasTienda).set({ passwordHash: await bcrypt.hash(d.nueva, 10) }).where(eq(cuentasTienda.id, c.cuentaId));
    res.status(204).end();
  });

  return r;
}

import bcrypt from 'bcryptjs';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { sucursales, usuarios } from '../../db/schema/index.js';
import { noAutorizado, noEncontrado, prohibido, reglaNegocio } from '../../lib/errors.js';
import { body, param, usuarioDe } from '../../lib/http.js';
import { NOMBRE_ROL, PERMISOS_POR_ROL, ROLES, ROLES_PROTEGIDOS, tienePermiso, type Rol } from '../../lib/permisos.js';
import { autenticar, firmarToken, requierePermiso } from '../../middleware/auth.js';
import { crearCategoriasPorDefecto } from '../finanzas/servicio.js';

const HASH_FALSO = bcrypt.hashSync('provision-hash-falso', 10);

/** Lo que la app necesita saber del usuario para mostrar u ocultar pantallas. */
const conPermisos = <T extends { rol: Rol }>(u: T) => ({
  ...u,
  nombreRol: NOMBRE_ROL[u.rol],
  permisos: PERMISOS_POR_ROL[u.rol],
});

const columnasPublicas = {
  id: usuarios.id,
  nombre: usuarios.nombre,
  email: usuarios.email,
  rol: usuarios.rol,
  sucursalId: usuarios.sucursalId,
  activo: usuarios.activo,
  creadoEn: usuarios.creadoEn,
};

export function rutasAuth(db: DB) {
  const r = Router();

  r.post('/login', async (req, res) => {
    const datos = body(req, z.object({ email: z.string().trim().toLowerCase(), password: z.string() }));
    const [u] = await db.select().from(usuarios).where(eq(usuarios.email, datos.email));
    // Se compara siempre para no revelar por tiempo si el email existe.
    const ok = await bcrypt.compare(datos.password, u?.passwordHash ?? HASH_FALSO);
    if (!u || !ok || !u.activo) throw noAutorizado('Email o contraseña incorrectos');
    const { passwordHash: _, ...publico } = u;
    res.json({ token: firmarToken(u.id), usuario: conPermisos(publico) });
  });

  r.get('/me', autenticar(db), (req, res) => {
    res.json(conPermisos(usuarioDe(req)));
  });

  /** Roles disponibles con su nombre y permisos (para formularios y para documentar). */
  r.get('/roles', autenticar(db), (req, res) => {
    const yo = usuarioDe(req);
    res.json(
      ROLES.map((rol) => ({
        rol,
        nombre: NOMBRE_ROL[rol],
        permisos: PERMISOS_POR_ROL[rol],
        // Si quien pregunta puede asignar este rol a otro usuario.
        asignable: !ROLES_PROTEGIDOS.includes(rol) || tienePermiso(yo.rol, 'usuarios.administradores'),
      })),
    );
  });

  r.post('/cambiar-password', autenticar(db), async (req, res) => {
    const u = usuarioDe(req);
    const datos = body(req, z.object({ actual: z.string(), nueva: z.string().min(8) }));
    const [fila] = await db.select().from(usuarios).where(eq(usuarios.id, u.id));
    if (!fila || !(await bcrypt.compare(datos.actual, fila.passwordHash))) {
      throw noAutorizado('La contraseña actual no es correcta');
    }
    await db
      .update(usuarios)
      .set({ passwordHash: await bcrypt.hash(datos.nueva, 10) })
      .where(eq(usuarios.id, u.id));
    res.status(204).end();
  });

  return r;
}

const usuarioEsquema = z.object({
  nombre: z.string().trim().min(2).max(120),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8),
  rol: z.enum(ROLES),
  sucursalId: z.uuid().nullable().optional(),
});

export function rutasUsuarios(db: DB) {
  const r = Router();
  r.use(requierePermiso('usuarios.gestionar'));

  r.get('/', async (_req, res) => {
    const filas = await db.select(columnasPublicas).from(usuarios).orderBy(asc(usuarios.nombre));
    res.json(filas.map((u) => ({ ...u, nombreRol: NOMBRE_ROL[u.rol] })));
  });

  /** Solo el super administrador crea o modifica administradores y super administradores. */
  const exigirSobreProtegidos = (yo: Rol, ...roles: (Rol | undefined)[]) => {
    if (roles.some((r) => r && ROLES_PROTEGIDOS.includes(r)) && !tienePermiso(yo, 'usuarios.administradores')) {
      throw prohibido('Solo el super administrador gestiona cuentas de administrador');
    }
  };

  r.post('/', async (req, res) => {
    const { password, ...datos } = body(req, usuarioEsquema.extend({ rol: usuarioEsquema.shape.rol.default('VENDEDOR') }));
    exigirSobreProtegidos(usuarioDe(req).rol, datos.rol);
    const creado = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(usuarios)
        .values({ ...datos, passwordHash: await bcrypt.hash(password, 10) })
        .returning(columnasPublicas);
      await crearCategoriasPorDefecto(tx, u!.id);
      return u!;
    });
    res.status(201).json(creado);
  });

  r.patch('/:id', async (req, res) => {
    const id = param(req);
    const { password, ...datos } = body(req, usuarioEsquema.extend({ activo: z.boolean() }).partial());
    const yo = usuarioDe(req);
    // Protecciones para no dejar el sistema sin quien lo administre.
    if (id === yo.id && (datos.activo === false || (datos.rol && datos.rol !== yo.rol))) {
      throw reglaNegocio('No puedes desactivarte ni cambiar tu propio rol');
    }
    const [actual] = await db.select({ rol: usuarios.rol }).from(usuarios).where(eq(usuarios.id, id));
    if (!actual) throw noEncontrado('Usuario');
    exigirSobreProtegidos(yo.rol, actual.rol, datos.rol);
    if (actual.rol === 'SUPERADMIN' && (datos.activo === false || (datos.rol && datos.rol !== 'SUPERADMIN'))) {
      const [otros] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(usuarios)
        .where(and(eq(usuarios.rol, 'SUPERADMIN'), eq(usuarios.activo, true), ne(usuarios.id, id)));
      if (otros!.n === 0) throw reglaNegocio('Debe quedar al menos un super administrador activo');
    }
    const [u] = await db
      .update(usuarios)
      .set({ ...datos, ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) })
      .where(eq(usuarios.id, id))
      .returning(columnasPublicas);
    if (!u) throw noEncontrado('Usuario');
    res.json(u);
  });

  return r;
}

const sucursalEsquema = z.object({
  nombre: z.string().trim().min(2).max(120),
  codigo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, 'Solo letras y números, 2 a 10 caracteres'),
  direccion: z.string().trim().nullish(),
  telefono: z.string().trim().max(40).nullish(),
  activa: z.boolean().optional(),
});

export function rutasSucursales(db: DB) {
  const r = Router();

  r.get('/', async (_req, res) => {
    res.json(await db.select().from(sucursales).orderBy(asc(sucursales.nombre)));
  });

  r.post('/', requierePermiso('sucursales.gestionar'), async (req, res) => {
    const [s] = await db.insert(sucursales).values(body(req, sucursalEsquema)).returning();
    res.status(201).json(s);
  });

  r.patch('/:id', requierePermiso('sucursales.gestionar'), async (req, res) => {
    const [s] = await db
      .update(sucursales)
      .set(body(req, sucursalEsquema.partial()))
      .where(eq(sucursales.id, param(req)))
      .returning();
    if (!s) throw noEncontrado('Sucursal');
    res.json(s);
  });

  return r;
}

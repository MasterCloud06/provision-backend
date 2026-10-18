/**
 * Crea lo mínimo para poder ingresar: la primera sucursal y el super administrador (el dueño).
 * No carga productos, clientes ni ningún otro dato. Si ya hay usuarios, no hace nada.
 *
 *   npm run db:crear-admin                 (entorno local)
 *   npm run db:crear-admin:desarrollo      (entorno de desarrollo)
 */
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { crearCategoriasPorDefecto } from '../modules/finanzas/servicio.js';
import { crearDb, type DB } from './client.js';
import { sucursales, usuarios } from './schema/index.js';

export type DatosAdmin = {
  nombre: string;
  email: string;
  password: string;
  sucursal: { nombre: string; codigo: string };
};

export async function crearAdminInicial(db: DB, datos: DatosAdmin) {
  const [{ total }] = (await db.select({ total: sql<number>`count(*)::int` }).from(usuarios)) as [{ total: number }];
  if (total > 0) return null;

  return db.transaction(async (tx) => {
    const [sucursal] = await tx.insert(sucursales).values(datos.sucursal).returning();
    const [admin] = await tx
      .insert(usuarios)
      .values({
        nombre: datos.nombre,
        email: datos.email.toLowerCase(),
        passwordHash: await bcrypt.hash(datos.password, 10),
        rol: 'SUPERADMIN',
        sucursalId: sucursal!.id,
      })
      .returning();
    await crearCategoriasPorDefecto(tx, admin!.id);
    return { admin: admin!, sucursal: sucursal! };
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('crear-admin.ts')) {
  // En local hay un acceso de prueba fijo si no se definió otro; en desarrollo siempre hay que definirlo.
  const local = env.APP_ENV === 'local';
  const email = env.ADMIN_EMAIL ?? (local ? 'admin@provision.local' : undefined);
  const password = env.ADMIN_PASSWORD ?? (local ? 'password123' : undefined);
  if (!email || !password) {
    console.error(`Define ADMIN_EMAIL y ADMIN_PASSWORD en .env.${env.APP_ENV}`);
    process.exit(1);
  }
  const { db, cerrar } = crearDb(env.DATABASE_URL, env.DATABASE_SSL);
  const r = await crearAdminInicial(db, {
    nombre: env.ADMIN_NOMBRE,
    email,
    password,
    sucursal: { nombre: env.SUCURSAL_NOMBRE, codigo: env.SUCURSAL_CODIGO },
  });
  console.log(
    r
      ? `[${env.APP_ENV}] Administrador creado: ${r.admin.email}${local && !env.ADMIN_PASSWORD ? ` / ${password}` : ''} (sucursal ${r.sucursal.codigo})`
      : `[${env.APP_ENV}] Ya existen usuarios; no se creó nada.`,
  );
  await cerrar();
}

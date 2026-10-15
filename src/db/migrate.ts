import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { env } from '../config/env.js';
import { crearDb } from './client.js';
import { asegurarSuperadmin } from './superadmin.js';

const { db, cerrar } = crearDb(env.DATABASE_URL, env.DATABASE_SSL);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await migrate(db as any, { migrationsFolder: 'drizzle' });
console.log(`[${env.APP_ENV}] Migraciones aplicadas`);
const ascendido = await asegurarSuperadmin(db);
if (ascendido) console.log(`[${env.APP_ENV}] ${ascendido} ahora es super administrador`);
await cerrar();

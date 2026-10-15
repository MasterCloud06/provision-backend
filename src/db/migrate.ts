import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { env } from '../config/env.js';
import { crearDb } from './client.js';

const { db, cerrar } = crearDb(env.DATABASE_URL);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await migrate(db as any, { migrationsFolder: 'drizzle' });
console.log('Migraciones aplicadas');
await cerrar();

import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
/** Cualquier base Postgres compatible (node-postgres en producción, PGlite en tests). */
export type DB = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
/** Una conexión o una transacción en curso: los servicios aceptan ambas. */
export type Exec = DB | Tx;

export function crearDb(url: string): { db: DB; cerrar: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema, casing: 'snake_case' }) as unknown as DB;
  return { db, cerrar: () => pool.end() };
}

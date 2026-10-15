import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import request from 'supertest';
import { crearApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import type { DB } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import { sembrar } from '../src/db/seed.js';

/** App completa sobre un Postgres embebido (PGlite) en memoria, migrado y con datos iniciales. */
export async function entornoDePrueba() {
  const cliente = new PGlite();
  const pglite = drizzle(cliente, { schema, casing: 'snake_case' });
  await migrate(pglite, { migrationsFolder: 'drizzle' });
  const db = pglite as unknown as DB;
  const semilla = await sembrar(db);
  const app = crearApp(db);

  const login = async (email: string, password: string) => {
    const r = await request(app).post('/api/v1/auth/login').send({ email, password });
    if (r.status !== 200) throw new Error(`login falló: ${JSON.stringify(r.body)}`);
    return r.body.token as string;
  };
  const token = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);

  /** Cliente HTTP autenticado. */
  const como = (tk: string) => ({
    get: (url: string) => request(app).get(`/api/v1${url}`).set('Authorization', `Bearer ${tk}`),
    post: (url: string, body?: object) =>
      request(app).post(`/api/v1${url}`).set('Authorization', `Bearer ${tk}`).send(body ?? {}),
    patch: (url: string, body: object) =>
      request(app).patch(`/api/v1${url}`).set('Authorization', `Bearer ${tk}`).send(body),
    put: (url: string, body: object) =>
      request(app).put(`/api/v1${url}`).set('Authorization', `Bearer ${tk}`).send(body),
    delete: (url: string) => request(app).delete(`/api/v1${url}`).set('Authorization', `Bearer ${tk}`),
  });

  return { app, db, cliente, semilla, admin: como(token), como, login, cerrar: () => cliente.close() };
}

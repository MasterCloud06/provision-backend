import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import request from 'supertest';
import { crearApp } from '../src/app.js';
import type { DB } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import { crearAdminInicial } from '../src/db/crear-admin.js';

const ADMIN = { email: 'admin@prueba.bo', password: 'ClaveDePrueba123' };

/** App completa sobre un Postgres embebido (PGlite) en memoria, migrado y con datos iniciales. */
export async function entornoDePrueba() {
  const cliente = new PGlite();
  const pglite = drizzle(cliente, { schema, casing: 'snake_case' });
  await migrate(pglite, { migrationsFolder: 'drizzle' });
  const db = pglite as unknown as DB;
  const semilla = (await crearAdminInicial(db, {
    nombre: 'Administrador',
    email: ADMIN.email,
    password: ADMIN.password,
    sucursal: { nombre: 'Casa matriz', codigo: 'MAT' },
  }))!;
  const app = crearApp(db);

  const login = async (email: string, password: string) => {
    const r = await request(app).post('/api/v1/auth/login').send({ email, password });
    if (r.status !== 200) throw new Error(`login falló: ${JSON.stringify(r.body)}`);
    return r.body.token as string;
  };
  const token = await login(ADMIN.email, ADMIN.password);

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

  const admin = como(token);

  /** Catálogo mínimo para los tests (la base real arranca vacía). */
  async function prepararCatalogo() {
    const marca = async (nombre: string) => (await admin.post('/catalogo/marcas', { nombre })).body.id as string;
    const [rayban, vitaly, essilor] = [await marca('Ray-Ban'), await marca('Vitaly'), await marca('Essilor')];
    const productos = [
      { sku: 'MON-RB5154-NEG', nombre: 'Montura Clubmaster negro', tipo: 'MONTURA', marcaId: rayban, precioVenta: 120000, stockMinimo: 2, stockInicial: { cantidad: 4, costoUnitario: 70000 } },
      { sku: 'MON-VIT-2201-CAR', nombre: 'Montura Vitaly 2201 carey', tipo: 'MONTURA', marcaId: vitaly, precioVenta: 45000, stockMinimo: 3, stockInicial: { cantidad: 10, costoUnitario: 18000 } },
      { sku: 'LEN-156-AR', nombre: 'Lente monofocal 1.56 antirreflejo (par)', tipo: 'LENTE_OFTALMICO', marcaId: essilor, precioVenta: 35000, stockMinimo: 5, stockInicial: { cantidad: 20, costoUnitario: 12000 } },
      { sku: 'LIQ-MULTI-360', nombre: 'Solución multipropósito 360 ml', tipo: 'LIQUIDO', precioVenta: 6500, stockMinimo: 6, stockInicial: { cantidad: 24, costoUnitario: 3500 } },
      { sku: 'SRV-CONSULTA', nombre: 'Consulta optométrica', tipo: 'SERVICIO', precioVenta: 10000 },
    ];
    const ids: Record<string, string> = {};
    for (const p of productos) {
      const r = await admin.post('/catalogo/productos', p);
      if (r.status !== 201) throw new Error(`producto ${p.sku}: ${JSON.stringify(r.body)}`);
      ids[p.sku] = r.body.id;
    }
    return ids;
  }

  return { app, db, prepararCatalogo, cliente, semilla, admin, como, login, cerrar: () => cliente.close() };
}

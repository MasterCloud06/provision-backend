import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asegurarAccesoLocal } from '../src/db/crear-admin.js';
import { entornoDePrueba } from './helpers.js';

/** "npm run db:crear-admin" en local deja el acceso de prueba listo aunque ya haya usuarios. */
describe('acceso de prueba en local', () => {
  let e: Awaited<ReturnType<typeof entornoDePrueba>>;
  beforeAll(async () => {
    e = await entornoDePrueba();
  });
  afterAll(() => e.cerrar());

  it('crea el usuario si no existe y puede ingresar como super administrador', async () => {
    expect(await asegurarAccesoLocal(e.db, { nombre: 'Administrador', email: 'admin@provision.local', password: 'password123' })).toBe('creado');
    const yo = await e.como(await e.login('admin@provision.local', 'password123')).get('/auth/me');
    expect(yo.body.rol).toBe('SUPERADMIN');
  });

  it('si ya existe, le restablece la contraseña', async () => {
    expect(await asegurarAccesoLocal(e.db, { nombre: 'Administrador', email: 'admin@prueba.bo', password: 'password123' })).toBe('actualizado');
    await e.login('admin@prueba.bo', 'password123');
  });
});

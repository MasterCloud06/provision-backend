import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asegurarSuperadmin } from '../src/db/superadmin.js';
import { entornoDePrueba } from './helpers.js';

type Entorno = Awaited<ReturnType<typeof entornoDePrueba>>;
type Cliente = ReturnType<Entorno['como']>;

/** El super administrador lo puede todo y es el único que ve la auditoría y gestiona administradores. */
describe('super administrador y registro de eventos', () => {
  let e: Entorno;
  const ids: Record<string, string> = {};
  const u: Record<string, Cliente> = {};

  beforeAll(async () => {
    e = await entornoDePrueba(); // el usuario inicial es SUPERADMIN
    Object.assign(ids, await e.prepararCatalogo());
    const sucursalId = e.semilla.sucursal.id;
    for (const [rol, email] of [
      ['ADMIN', 'admin2@prueba.bo'],
      ['CAJERO', 'cajero@prueba.bo'],
      ['VENDEDOR', 'ejecutivo@prueba.bo'],
    ] as const) {
      const r = await e.admin.post('/usuarios', { nombre: `Usuario ${rol}`, email, password: 'clave12345', rol, sucursalId });
      expect(r.status).toBe(201);
      ids[rol] = r.body.id;
      u[rol] = e.como(await e.login(email, 'clave12345'));
    }
  });
  afterAll(() => e.cerrar());

  it('el usuario inicial es super administrador y tiene todos los permisos', async () => {
    const me = (await e.admin.get('/auth/me')).body;
    expect(me.rol).toBe('SUPERADMIN');
    expect(me.nombreRol).toBe('Super administrador');
    expect(me.permisos).toContain('auditoria.ver');
    expect(me.permisos).toContain('usuarios.administradores');
    const admin = (await u.ADMIN!.get('/auth/me')).body;
    expect(admin.permisos).not.toContain('auditoria.ver');
    expect(admin.permisos).toContain('usuarios.gestionar');
  });

  it('solo el super administrador ve la auditoría', async () => {
    expect((await e.admin.get('/auditoria/resumen')).status).toBe(200);
    expect((await u.ADMIN!.get('/auditoria/resumen')).status).toBe(403);
    expect((await u.CAJERO!.get('/auditoria/eventos')).status).toBe(403);
  });

  it('un administrador no crea ni modifica administradores; el super administrador sí', async () => {
    const roles = (await u.ADMIN!.get('/auth/roles')).body as { rol: string; asignable: boolean }[];
    expect(roles.filter((r) => !r.asignable).map((r) => r.rol)).toEqual(['SUPERADMIN', 'ADMIN']);

    const nuevoAdmin = { nombre: 'Otro admin', email: 'otro@prueba.bo', password: 'clave12345', rol: 'ADMIN' };
    expect((await u.ADMIN!.post('/usuarios', nuevoAdmin)).status).toBe(403);
    expect((await u.ADMIN!.patch(`/usuarios/${ids.CAJERO}`, { rol: 'ADMIN' })).status).toBe(403);
    const yo = (await e.admin.get('/auth/me')).body;
    expect((await u.ADMIN!.patch(`/usuarios/${yo.id}`, { activo: false })).status).toBe(403);

    // Sí puede gestionar roles no protegidos
    expect((await u.ADMIN!.patch(`/usuarios/${ids.VENDEDOR}`, { nombre: 'Ejecutivo Uno' })).status).toBe(200);
    expect((await e.admin.post('/usuarios', nuevoAdmin)).status).toBe(201);
  });

  it('siempre queda al menos un super administrador activo', async () => {
    const yo = (await e.admin.get('/auth/me')).body;
    expect((await e.admin.patch(`/usuarios/${yo.id}`, { rol: 'ADMIN' })).status).toBe(422);
    const segundo = await e.admin.post('/usuarios', {
      nombre: 'Socio', email: 'socio@prueba.bo', password: 'clave12345', rol: 'SUPERADMIN',
    });
    expect(segundo.status).toBe(201);
    const socio = e.como(await e.login('socio@prueba.bo', 'clave12345'));
    expect((await socio.patch(`/usuarios/${yo.id}`, { activo: false })).status).toBe(200);
    expect((await socio.patch(`/usuarios/${yo.id}`, { activo: true })).status).toBe(200);
    // Con dos super administradores, uno puede desactivar al otro…
    expect((await e.admin.patch(`/usuarios/${segundo.body.id}`, { activo: false })).status).toBe(200);
    // …y al quedar uno solo, un administrador común no puede tocarlo.
    const otroAdmin = e.como(await e.login('otro@prueba.bo', 'clave12345'));
    expect((await otroAdmin.patch(`/usuarios/${yo.id}`, { activo: false })).status).toBe(403);
  });

  it('registra los eventos de cada rol, con éxito, negados, rechazados y logins fallidos', async () => {
    await e.admin.post('/caja/abrir', { montoApertura: 20000 });
    await u.CAJERO!.post('/ventas', {
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 6500 }],
    });
    await u.VENDEDOR!.post('/ventas', {
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 6500 }],
    }); // negado: el ejecutivo no cobra
    await u.CAJERO!.post('/caja/abrir', { montoApertura: 100 }); // rechazado: ya hay caja abierta
    const { default: request } = await import('supertest');
    await request(e.app).post('/api/v1/auth/login').send({ email: 'cajero@prueba.bo', password: 'mal' });
    await u.CAJERO!.post('/finanzas/cuentas', { nombre: 'Mi billetera', tipo: 'EFECTIVO' }); // privado: no se registra

    const lista = (await e.admin.get('/auditoria/eventos?porPagina=200')).body;
    const descripciones = lista.datos.map((d: { descripcion: string }) => d.descripcion);
    expect(descripciones.some((d: string) => /Registró la venta V-MAT-\d+ por Bs 65,00/.test(d))).toBe(true);
    expect(descripciones).toContain('Abrió caja con Bs 200,00');

    const negado = lista.datos.find((d: { resultado: string; rol: string }) => d.resultado === 'DENEGADO' && d.rol === 'VENDEDOR');
    expect(negado.descripcion).toMatch(/^Registrar venta: No puedes cobrar/);
    expect(negado.nombreRol).toBe('Ejecutivo de ventas');

    const rechazado = lista.datos.find((d: { resultado: string }) => d.resultado === 'RECHAZADO');
    expect(rechazado.descripcion).toMatch(/Ya hay una caja abierta/);

    const fallido = lista.datos.find((d: { resultado: string }) => d.resultado === 'FALLIDO');
    expect(fallido.descripcion).toBe('Intento de ingreso fallido con cajero@prueba.bo');

    expect(lista.datos.some((d: { modulo: string }) => d.modulo === 'finanzas')).toBe(false);
    expect(JSON.stringify(lista)).not.toMatch(/clave12345|"mal"/);

    // Filtro por rol
    const soloCajero = (await e.admin.get('/auditoria/eventos?rol=CAJERO')).body;
    expect(soloCajero.datos.every((d: { rol: string }) => d.rol === 'CAJERO')).toBe(true);
    expect(soloCajero.total).toBeGreaterThan(0);
  });

  it('el resumen agrupa por rol, usuario, módulo y día', async () => {
    const r = (await e.admin.get('/auditoria/resumen')).body;
    expect(r.porRol.map((p: { rol: string }) => p.rol)).toEqual([
      'SUPERADMIN', 'ADMIN', 'ENCARGADO', 'CAJERO', 'VENDEDOR', 'OPTOMETRISTA', 'LABORATORIO',
    ]);
    const vendedor = r.porRol.find((p: { rol: string }) => p.rol === 'VENDEDOR');
    expect(vendedor).toMatchObject({ nombre: 'Ejecutivo de ventas', usuarios: 1 });
    expect(vendedor.denegados).toBeGreaterThanOrEqual(1);
    // Fechas en ISO 8601 para que cualquier cliente (la app en C#) las lea
    expect(vendedor.ultimo).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(r.porUsuario[0].ultimo).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.totales.denegados).toBeGreaterThanOrEqual(1);
    expect(r.totales.fallidos).toBe(1);
    expect(r.porModulo.map((m: { modulo: string }) => m.modulo)).toEqual(expect.arrayContaining(['ventas', 'caja', 'usuarios', 'acceso']));
    expect(r.porDia).toHaveLength(1);
    expect(r.alertas.length).toBeGreaterThan(0);
    expect(r.porUsuario[0].eventos).toBeGreaterThan(0);
  });

  it('una base sin super administrador asciende al administrador más antiguo', async () => {
    const yo = (await e.admin.get('/auth/me')).body;
    const { usuarios } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await e.db.update(usuarios).set({ rol: 'ADMIN' }).where(eq(usuarios.rol, 'SUPERADMIN'));
    expect(await asegurarSuperadmin(e.db)).toBe(yo.email);
    expect((await e.admin.get('/auth/me')).body.rol).toBe('SUPERADMIN');
    expect(await asegurarSuperadmin(e.db)).toBeNull();
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entornoDePrueba } from './helpers.js';

type Entorno = Awaited<ReturnType<typeof entornoDePrueba>>;
type Cliente = ReturnType<Entorno['como']>;

/**
 * Cada rol hace su parte del trabajo de la óptica y nada más:
 * el ejecutivo arma la venta, el cajero cobra, la optometrista gradúa,
 * el laboratorio arma los lentes y la entrega exige saldo en cero.
 */
describe('roles y permisos', () => {
  let e: Entorno;
  const ids: Record<string, string> = {};
  const u: Record<string, Cliente> = {};

  beforeAll(async () => {
    e = await entornoDePrueba();
    Object.assign(ids, await e.prepararCatalogo());
    const sucursalId = e.semilla.sucursal.id;
    for (const [rol, email] of [
      ['ENCARGADO', 'encargado@prueba.bo'],
      ['CAJERO', 'cajero@prueba.bo'],
      ['VENDEDOR', 'ejecutivo@prueba.bo'],
      ['OPTOMETRISTA', 'opto@prueba.bo'],
      ['LABORATORIO', 'lab@prueba.bo'],
    ] as const) {
      const r = await e.admin.post('/usuarios', { nombre: rol, email, password: 'clave12345', rol, sucursalId });
      expect(r.status).toBe(201);
      ids[rol] = r.body.id;
      u[rol] = e.como(await e.login(email, 'clave12345'));
    }
  });
  afterAll(() => e.cerrar());

  it('login y /me devuelven el nombre del rol y sus permisos', async () => {
    const me = (await u.CAJERO!.get('/auth/me')).body;
    expect(me.nombreRol).toBe('Cajero');
    expect(me.permisos).toContain('caja.operar');
    expect(me.permisos).not.toContain('ventas.anular');
    const roles = (await u.CAJERO!.get('/auth/roles')).body;
    expect(roles.map((r: { rol: string }) => r.rol)).toEqual([
      'SUPERADMIN', 'ADMIN', 'ENCARGADO', 'CAJERO', 'VENDEDOR', 'OPTOMETRISTA', 'LABORATORIO',
    ]);
  });

  it('cada rol ve solo sus pantallas', async () => {
    expect((await u.VENDEDOR!.get('/caja/actual')).status).toBe(403);
    expect((await u.VENDEDOR!.get('/reportes/dashboard')).status).toBe(403);
    expect((await u.CAJERO!.get('/reportes/dashboard')).status).toBe(403);
    expect((await u.ENCARGADO!.get('/reportes/dashboard')).status).toBe(200);
    expect((await u.LABORATORIO!.get('/ventas')).status).toBe(403);
    expect((await u.LABORATORIO!.get('/ordenes-trabajo')).status).toBe(200);
    expect((await u.OPTOMETRISTA!.get('/inventario/alertas')).status).toBe(403);
    expect((await u.ENCARGADO!.get('/usuarios')).status).toBe(403);
    // Finanzas personales: todos
    for (const c of Object.values(u)) expect((await c.get('/finanzas/cuentas')).status).toBe(200);
  });

  it('optometrista registra la receta; el cajero no puede', async () => {
    const c = await u.OPTOMETRISTA!.post('/clientes', { nombre: 'Rosa Mamani', ci: '445566' });
    expect(c.status).toBe(201);
    ids.cliente = c.body.id;
    const receta = { fecha: '2026-10-15', odEsfera: -2, oiEsfera: -1.75 };
    expect((await u.CAJERO!.post(`/clientes/${ids.cliente}/recetas`, receta)).status).toBe(403);
    const r = await u.OPTOMETRISTA!.post(`/clientes/${ids.cliente}/recetas`, receta);
    expect(r.status).toBe(201);
    ids.receta = r.body.id;
  });

  it('el ejecutivo arma la venta sin cobrar; la caja la cobra', async () => {
    await e.admin.post('/caja/abrir', { montoApertura: 10000 });

    const conPago = await u.VENDEDOR!.post('/ventas', {
      clienteId: ids.cliente,
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 6500 }],
    });
    expect(conPago.status).toBe(403);

    const sinCliente = await u.VENDEDOR!.post('/ventas', { items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1 }] });
    expect(sinCliente.status).toBe(422);
    expect(sinCliente.body.error.mensaje).toMatch(/caja pueda cobrarla/);

    const venta = await u.VENDEDOR!.post('/ventas', {
      clienteId: ids.cliente,
      recetaId: ids.receta,
      items: [
        { productoId: ids['MON-VIT-2201-CAR'], cantidad: 1 },
        { productoId: ids['LEN-156-AR'], cantidad: 1 },
      ],
    });
    expect(venta.status).toBe(201);
    expect(venta.body).toMatchObject({ estadoPago: 'PENDIENTE', saldo: 80000 });
    ids.venta = venta.body.id;
    ids.orden = venta.body.ordenTrabajo.id;

    expect((await u.VENDEDOR!.post(`/ventas/${ids.venta}/pagos`, { pagos: [{ metodo: 'QR', monto: 30000 }] })).status).toBe(403);
    const anticipo = await u.CAJERO!.post(`/ventas/${ids.venta}/pagos`, { pagos: [{ metodo: 'QR', monto: 30000 }] });
    expect(anticipo.status).toBe(201);
    expect(anticipo.body.venta.saldo).toBe(50000);
  });

  it('laboratorio arma los lentes pero no los entrega; la entrega exige saldo cero', async () => {
    expect((await u.CAJERO!.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'EN_LABORATORIO' })).status).toBe(403);
    expect((await u.LABORATORIO!.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'EN_LABORATORIO' })).status).toBe(200);
    expect((await u.LABORATORIO!.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'LISTO' })).status).toBe(200);
    expect((await u.LABORATORIO!.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'ENTREGADO' })).status).toBe(403);
    expect((await u.LABORATORIO!.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'CANCELADO' })).status).toBe(403);

    expect((await u.VENDEDOR!.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'ENTREGADO' })).status).toBe(422);
    await u.CAJERO!.post(`/ventas/${ids.venta}/pagos`, { pagos: [{ metodo: 'EFECTIVO', monto: 50000 }] });
    expect((await u.VENDEDOR!.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'ENTREGADO' })).status).toBe(200);
  });

  it('cajero no anula ni cambia precios ni hace retiros del dueño; encargado sí anula', async () => {
    const v = await u.CAJERO!.post('/ventas', {
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 6500 }],
    });
    expect(v.status).toBe(201);
    expect((await u.CAJERO!.post(`/ventas/${v.body.id}/anular`, { motivo: 'error del cajero' })).status).toBe(403);
    expect((await u.ENCARGADO!.post(`/ventas/${v.body.id}/anular`, { motivo: 'error del cajero' })).status).toBe(200);

    const precio = await u.CAJERO!.post('/ventas', {
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1, precioUnitario: 5000 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 5000 }],
    });
    expect(precio.status).toBe(403);
    const precioEnc = await u.ENCARGADO!.post('/ventas', {
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1, precioUnitario: 5000 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 5000 }],
    });
    expect(precioEnc.status).toBe(201);

    const retiro = { concepto: 'RETIRO_DUENO', monto: 1000, descripcion: 'Retiro' };
    expect((await u.CAJERO!.post('/caja/movimientos', retiro)).status).toBe(403);
    expect((await u.ENCARGADO!.post('/caja/movimientos', retiro)).status).toBe(403);
    expect((await u.CAJERO!.post('/caja/movimientos', { concepto: 'GASTO', monto: 1000, descripcion: 'Pasajes' })).status).toBe(201);
  });

  it('inventario: el cajero consulta pero no recibe; el encargado recibe y ajusta', async () => {
    const entrada = { items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 2, costoUnitario: 3500 }] };
    expect((await u.CAJERO!.get('/inventario/alertas')).status).toBe(200);
    expect((await u.CAJERO!.post('/inventario/entradas', entrada)).status).toBe(403);
    expect((await u.ENCARGADO!.post('/inventario/entradas', entrada)).status).toBe(201);
    expect(
      (await u.ENCARGADO!.post('/inventario/ajustes', { items: [{ productoId: ids['LIQ-MULTI-360'], cantidadContada: 20 }] })).status,
    ).toBe(201);
  });

  it('CRUD de productos: solo encargado/admin; eliminar desactiva si hay historial', async () => {
    const nuevo = { sku: 'ACC-PANO', nombre: 'Paño de microfibra', tipo: 'ACCESORIO', precioVenta: 1500 };
    expect((await u.CAJERO!.post('/catalogo/productos', nuevo)).status).toBe(403);
    const p = await u.ENCARGADO!.post('/catalogo/productos', nuevo);
    expect(p.status).toBe(201);

    const editado = await u.ENCARGADO!.patch(`/catalogo/productos/${p.body.id}`, { precioVenta: 2000, nombre: 'Paño microfibra' });
    expect(editado.body).toMatchObject({ precioVenta: 2000, nombre: 'Paño microfibra', tipo: 'ACCESORIO' });

    expect((await u.VENDEDOR!.delete(`/catalogo/productos/${p.body.id}`)).status).toBe(403);
    const borrado = await u.ENCARGADO!.delete(`/catalogo/productos/${p.body.id}`);
    expect(borrado.body).toMatchObject({ eliminado: true });
    expect((await e.admin.get(`/catalogo/productos/${p.body.id}`)).status).toBe(404);

    // El líquido ya se vendió: no se borra, se desactiva
    const conHistorial = await e.admin.delete(`/catalogo/productos/${ids['LIQ-MULTI-360']}`);
    expect(conHistorial.body).toMatchObject({ eliminado: false, desactivado: true });
    expect((await e.admin.get(`/catalogo/productos/${ids['LIQ-MULTI-360']}`)).body.activo).toBe(false);
  });

  it('protecciones de usuarios: nadie se bloquea a sí mismo y queda un admin', async () => {
    const yo = (await e.admin.get('/auth/me')).body;
    expect((await e.admin.patch(`/usuarios/${yo.id}`, { activo: false })).status).toBe(422);
    expect((await e.admin.patch(`/usuarios/${yo.id}`, { rol: 'CAJERO' })).status).toBe(422);

    // El cambio de rol aplica en la siguiente petición, sin volver a iniciar sesión
    expect((await e.admin.patch(`/usuarios/${ids.CAJERO}`, { rol: 'VENDEDOR' })).body.rol).toBe('VENDEDOR');
    expect((await u.CAJERO!.get('/caja/actual')).status).toBe(403);

    expect((await e.admin.patch(`/usuarios/${ids.LABORATORIO}`, { activo: false })).status).toBe(200);
    expect((await u.LABORATORIO!.get('/ordenes-trabajo')).status).toBe(401);
  });
});

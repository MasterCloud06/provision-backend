import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entornoDePrueba } from './helpers.js';

type Entorno = Awaited<ReturnType<typeof entornoDePrueba>>;

/**
 * Un día típico en la óptica, de punta a punta:
 * stock → caja → venta de lentes con anticipo → laboratorio → abono y entrega →
 * anulación → arqueo → retiro del dueño a sus finanzas personales.
 */
describe('flujo completo de la óptica', () => {
  let e: Entorno;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    e = await entornoDePrueba();
    const productos = (await e.admin.get('/catalogo/productos?porPagina=50')).body.datos as {
      id: string;
      sku: string;
      stock: number;
    }[];
    for (const p of productos) ids[p.sku] = p.id;
  });
  afterAll(() => e.cerrar());

  it('rechaza peticiones sin token', async () => {
    const { default: request } = await import('supertest');
    const r = await request(e.app).get('/api/v1/catalogo/productos');
    expect(r.status).toBe(401);
  });

  it('lista productos con su stock de la sucursal', async () => {
    const r = await e.admin.get('/catalogo/productos?q=clubmaster');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.datos[0]).toMatchObject({ sku: 'MON-RB5154-NEG', stock: 4, marca: 'Ray-Ban' });
  });

  it('recepción de mercadería suma stock y recalcula el costo promedio', async () => {
    // 4 unidades a Bs 700 + 4 a Bs 900 → promedio Bs 800
    const r = await e.admin.post('/inventario/entradas', {
      documento: 'F-1001',
      items: [{ productoId: ids['MON-RB5154-NEG'], cantidad: 4, costoUnitario: 90000 }],
    });
    expect(r.status).toBe(201);
    const p = (await e.admin.get(`/catalogo/productos/${ids['MON-RB5154-NEG']}`)).body;
    expect(p.costoPromedio).toBe(80000);
    expect(p.existencias[0].cantidad).toBe(8);
  });

  it('no permite cobrar sin caja abierta', async () => {
    const r = await e.admin.post('/ventas', {
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 6500 }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.mensaje).toMatch(/caja abierta/);
  });

  it('abre caja con fondo de Bs 200 y no permite abrir otra', async () => {
    const r = await e.admin.post('/caja/abrir', { montoApertura: 20000 });
    expect(r.status).toBe(201);
    ids.sesion = r.body.id;
    expect((await e.admin.post('/caja/abrir', { montoApertura: 0 })).status).toBe(409);
  });

  it('registra cliente con receta coherente', async () => {
    const c = await e.admin.post('/clientes', { nombre: 'María Quispe', ci: '6543210', telefono: '70012345' });
    expect(c.status).toBe(201);
    ids.cliente = c.body.id;

    const mala = await e.admin.post(`/clientes/${ids.cliente}/recetas`, { fecha: '2026-10-10', odCilindro: -0.75 });
    expect(mala.status).toBe(400); // cilindro sin eje

    const rec = await e.admin.post(`/clientes/${ids.cliente}/recetas`, {
      fecha: '2026-10-10',
      profesional: 'Lic. Rojas',
      odEsfera: -1.5,
      odCilindro: -0.75,
      odEje: 180,
      oiEsfera: -1.25,
      dnpOd: 31.5,
      dnpOi: 32,
    });
    expect(rec.status).toBe(201);
    expect(rec.body.odEsfera).toBe(-1.5);
    ids.receta = rec.body.id;
  });

  it('venta de montura + lentes con anticipo: descuenta stock, deja saldo y crea orden de laboratorio', async () => {
    const r = await e.admin.post('/ventas', {
      clienteId: ids.cliente,
      recetaId: ids.receta,
      items: [
        { productoId: ids['MON-VIT-2201-CAR'], cantidad: 1 },
        { productoId: ids['LEN-156-AR'], cantidad: 1 },
      ],
      descuento: 5000, // Bs 50 de descuento
      pagos: [
        { metodo: 'EFECTIVO', monto: 20000 },
        { metodo: 'QR', monto: 10000, referencia: 'QR-778899' },
      ],
      ordenTrabajo: { fechaPrometida: '2026-10-18', instrucciones: 'Biselado fino' },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      numero: 'V-MAT-000001',
      subtotal: 80000,
      total: 75000,
      pagado: 30000,
      saldo: 45000,
      estadoPago: 'PARCIAL',
    });
    expect(r.body.ordenTrabajo.numero).toBe('OT-MAT-000001');
    ids.venta = r.body.id;
    ids.orden = r.body.ordenTrabajo.id;

    const stockMontura = (await e.admin.get(`/catalogo/productos/${ids['MON-VIT-2201-CAR']}`)).body.existencias[0];
    expect(stockMontura.cantidad).toBe(9);
  });

  it('el kardex registra la venta con stock resultante', async () => {
    const k = await e.admin.get(`/inventario/kardex/${ids['MON-VIT-2201-CAR']}`);
    expect(k.body[0]).toMatchObject({ tipo: 'VENTA', cantidad: -1, stockResultante: 9 });
  });

  it('valida reglas de venta: stock insuficiente, pagos de más y saldo sin cliente', async () => {
    const sinStock = await e.admin.post('/ventas', {
      items: [{ productoId: ids['MON-RB5154-NEG'], cantidad: 99 }],
      clienteId: ids.cliente,
    });
    expect(sinStock.status).toBe(422);
    expect(sinStock.body.error.detalles).toMatchObject({ disponible: 8, solicitado: 99 });

    const deMas = await e.admin.post('/ventas', {
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 10000 }],
    });
    expect(deMas.status).toBe(422);

    const sinCliente = await e.admin.post('/ventas', { items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1 }] });
    expect(sinCliente.status).toBe(422);
  });

  it('servicios no controlan stock', async () => {
    const r = await e.admin.post('/ventas', {
      items: [{ productoId: ids['SRV-CONSULTA'], cantidad: 1 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 10000 }],
    });
    expect(r.status).toBe(201);
    expect(r.body.estadoPago).toBe('PAGADA');
    expect(r.body.ordenTrabajo).toBeNull();
  });

  it('la orden avanza en laboratorio pero no se entrega con saldo pendiente', async () => {
    expect((await e.admin.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'ENTREGADO' })).status).toBe(422);
    expect((await e.admin.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'EN_LABORATORIO' })).status).toBe(200);
    expect((await e.admin.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'LISTO', nota: 'Montado' })).status).toBe(200);

    const bloqueada = await e.admin.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'ENTREGADO' });
    expect(bloqueada.status).toBe(422);
    expect(bloqueada.body.error.detalles.saldo).toBe(45000);
  });

  it('cobra el saldo y entrega los lentes', async () => {
    const demasiado = await e.admin.post(`/ventas/${ids.venta}/pagos`, { pagos: [{ metodo: 'EFECTIVO', monto: 50000 }] });
    expect(demasiado.status).toBe(422);

    const abono = await e.admin.post(`/ventas/${ids.venta}/pagos`, { pagos: [{ metodo: 'TARJETA', monto: 45000 }] });
    expect(abono.status).toBe(201);
    expect(abono.body.venta).toMatchObject({ saldo: 0, estadoPago: 'PAGADA' });

    const entrega = await e.admin.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'ENTREGADO' });
    expect(entrega.status).toBe(200);
    expect(entrega.body.entregadoEn).toBeTruthy();

    const detalle = await e.admin.get(`/ordenes-trabajo/${ids.orden}`);
    expect(detalle.body.historial.map((h: { estadoNuevo: string }) => h.estadoNuevo)).toEqual([
      'PENDIENTE',
      'EN_LABORATORIO',
      'LISTO',
      'ENTREGADO',
    ]);
  });

  it('anular una venta devuelve stock y reembolsa desde caja', async () => {
    const v = await e.admin.post('/ventas', {
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 2 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 13000 }],
    });
    expect(v.status).toBe(201);
    const an = await e.admin.post(`/ventas/${v.body.id}/anular`, { motivo: 'Cliente desistió de la compra' });
    expect(an.status).toBe(200);
    expect(an.body.venta.estado).toBe('ANULADA');
    expect(an.body.reembolso).toMatchObject({ tipo: 'EGRESO', concepto: 'DEVOLUCION', monto: 13000 });

    const liq = (await e.admin.get(`/catalogo/productos/${ids['LIQ-MULTI-360']}`)).body.existencias[0];
    expect(liq.cantidad).toBe(24);
    expect((await e.admin.post(`/ventas/${v.body.id}/anular`, { motivo: 'otra vez anular' })).status).toBe(422);
  });

  it('un vendedor no puede anular ventas, cambiar precios ni retirar como dueño', async () => {
    const u = await e.admin.post('/usuarios', {
      nombre: 'Carla Vendedora',
      email: 'carla@provision.bo',
      password: 'secreto123',
      sucursalId: e.semilla.admin.sucursalId,
    });
    expect(u.status).toBe(201);
    expect(u.body.rol).toBe('VENDEDOR');
    const vendedor = e.como(await e.login('carla@provision.bo', 'secreto123'));

    expect((await vendedor.post(`/ventas/${ids.venta}/anular`, { motivo: 'no autorizado' })).status).toBe(403);
    const precio = await vendedor.post('/ventas', {
      items: [{ productoId: ids['LIQ-MULTI-360'], cantidad: 1, precioUnitario: 100 }],
      pagos: [{ metodo: 'EFECTIVO', monto: 100 }],
    });
    expect(precio.status).toBe(403);
    expect(
      (await vendedor.post('/caja/movimientos', { concepto: 'RETIRO_DUENO', monto: 1000, descripcion: 'retiro' })).status,
    ).toBe(403);

    // Cambiar el nombre (PATCH) no debe alterar el rol
    const p = await e.admin.patch(`/usuarios/${u.body.id}`, { nombre: 'Carla M.' });
    expect(p.body.rol).toBe('VENDEDOR');
  });

  it('retiro del dueño sale de caja y entra a su cuenta personal', async () => {
    const cuenta = await e.admin.post('/finanzas/cuentas', { nombre: 'Billetera', tipo: 'EFECTIVO' });
    expect(cuenta.status).toBe(201);
    ids.cuenta = cuenta.body.id;

    const sinFondos = await e.admin.post('/caja/movimientos', {
      concepto: 'RETIRO_DUENO',
      monto: 99_999_00,
      descripcion: 'Retiro grande',
      cuentaPersonalId: ids.cuenta,
    });
    expect(sinFondos.status).toBe(422);

    const r = await e.admin.post('/caja/movimientos', {
      concepto: 'RETIRO_DUENO',
      monto: 15000,
      descripcion: 'Retiro para gastos de la casa',
      cuentaPersonalId: ids.cuenta,
    });
    expect(r.status).toBe(201);
    expect(r.body.transaccionPersonal).toMatchObject({ tipo: 'INGRESO', monto: 15000 });

    const gasto = await e.admin.post('/caja/movimientos', { concepto: 'GASTO', monto: 2000, descripcion: 'Limpieza del local' });
    expect(gasto.status).toBe(201);
  });

  it('arqueo: cierra caja calculando faltante o sobrante en efectivo', async () => {
    const actual = (await e.admin.get('/caja/actual')).body;
    // 200 apertura + 200 anticipo + 100 consulta + 130 venta − 130 reembolso − 150 retiro − 20 gasto = 330
    expect(actual.efectivoEsperado).toBe(33000);
    expect(actual.porMetodo.QR.ingresos).toBe(10000);
    expect(actual.porMetodo.TARJETA.ingresos).toBe(45000);

    const cierre = await e.admin.post('/caja/cerrar', { efectivoContado: 32500 });
    expect(cierre.status).toBe(200);
    expect(cierre.body.sesion).toMatchObject({ estado: 'CERRADA', efectivoEsperado: 33000, diferencia: -500 });
    expect((await e.admin.get('/caja/actual')).body).toBeNull();
  });

  it('finanzas personales: gastos, transferencias, presupuesto y resumen del mes', async () => {
    const cats = (await e.admin.get('/finanzas/categorias')).body as { id: string; nombre: string; tipo: string }[];
    const alimentacion = cats.find((c) => c.nombre === 'Alimentación')!;
    const banco = await e.admin.post('/finanzas/cuentas', { nombre: 'Banco Unión', tipo: 'BANCO', saldoInicial: 500000 });

    const mes = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 7);
    expect(
      (await e.admin.put('/finanzas/presupuestos', { categoriaId: alimentacion.id, mes, monto: 100000 })).status,
    ).toBe(200);

    const g = await e.admin.post('/finanzas/transacciones', {
      tipo: 'GASTO',
      cuentaId: banco.body.id,
      categoriaId: alimentacion.id,
      monto: 120000,
      descripcion: 'Mercado del mes',
    });
    expect(g.status).toBe(201);

    // Una categoría de gasto no sirve para un ingreso
    const mal = await e.admin.post('/finanzas/transacciones', {
      tipo: 'INGRESO',
      cuentaId: banco.body.id,
      categoriaId: alimentacion.id,
      monto: 100,
    });
    expect(mal.status).toBe(422);

    const tr = await e.admin.post('/finanzas/transacciones', {
      tipo: 'TRANSFERENCIA',
      cuentaId: banco.body.id,
      cuentaDestinoId: ids.cuenta,
      monto: 30000,
    });
    expect(tr.status).toBe(201);

    const { cuentas, patrimonio } = (await e.admin.get('/finanzas/cuentas')).body;
    const saldo = (n: string) => cuentas.find((c: { nombre: string }) => c.nombre === n).saldo;
    expect(saldo('Billetera')).toBe(15000 + 30000);
    expect(saldo('Banco Unión')).toBe(500000 - 120000 - 30000);
    expect(patrimonio).toBe(395000);

    const res = (await e.admin.get(`/finanzas/resumen?mes=${mes}`)).body;
    expect(res).toMatchObject({ ingresos: 15000, gastos: 120000, ingresosDesdeNegocio: 15000 });
    expect(res.presupuesto[0]).toMatchObject({ categoria: 'Alimentación', gastado: 120000, excedido: true });

    // La transacción que vino de caja no se edita desde finanzas
    const tx = (await e.admin.get('/finanzas/transacciones')).body.find((t: { desdeCaja: boolean }) => t.desdeCaja);
    expect((await e.admin.delete(`/finanzas/transacciones/${tx.id}`)).status).toBe(422);
  });

  it('dashboard resume ventas, margen, cobranzas y laboratorio', async () => {
    const d = await e.admin.get('/reportes/dashboard');
    expect(d.status).toBe(200);
    // Activas: 75000 (lentes) + 10000 (consulta); la anulada no cuenta
    expect(d.body.ventas.monto).toBe(85000);
    expect(d.body.ventas.ventas).toBe(2);
    expect(d.body.margenBruto.costo).toBe(18000 + 12000);
    expect(d.body.cuentasPorCobrar.monto).toBe(0);
    expect(d.body.topProductos.length).toBeGreaterThan(0);
  });

  it('ajuste por conteo físico y transferencia entre sucursales', async () => {
    const aj = await e.admin.post('/inventario/ajustes', {
      motivo: 'Inventario de fin de mes',
      items: [{ productoId: ids['LEN-156-AR'], cantidadContada: 17 }],
    });
    expect(aj.status).toBe(201);
    expect(aj.body.movimientos[0]).toMatchObject({ tipo: 'AJUSTE', cantidad: -2, stockResultante: 17 });

    const suc = await e.admin.post('/sucursales', { nombre: 'Sucursal Centro', codigo: 'cen' });
    expect(suc.body.codigo).toBe('CEN');
    const t = await e.admin.post('/inventario/transferencias', {
      origenId: e.semilla.admin.sucursalId,
      destinoId: suc.body.id,
      items: [{ productoId: ids['LEN-156-AR'], cantidad: 5 }],
    });
    expect(t.status).toBe(201);
    const p = (await e.admin.get(`/catalogo/productos/${ids['LEN-156-AR']}`)).body;
    const en = (s: string) => p.existencias.find((x: { sucursalId: string }) => x.sucursalId === s).cantidad;
    expect(en(e.semilla.admin.sucursalId!)).toBe(12);
    expect(en(suc.body.id)).toBe(5);

    const alertas = (await e.admin.get('/inventario/alertas')).body;
    expect(Array.isArray(alertas)).toBe(true);
  });
});

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { pedidosWeb, stock } from '../src/db/schema/index.js';
import type { DatosSesion, EventoPago, PasarelaPagos, SesionPago } from '../src/lib/pagos.js';
import { liberarVencidos } from '../src/modules/tienda/servicio.js';
import { entornoDePrueba } from './helpers.js';

/** Stripe de mentira: guarda las sesiones en memoria y deja marcar una como pagada. */
function pasarelaFalsa() {
  const sesiones = new Map<string, SesionPago & { datos: DatosSesion }>();
  const reembolsos: string[] = [];
  let n = 0;
  const pasarela: PasarelaPagos = {
    async crearSesion(datos) {
      const id = `cs_test_${++n}`;
      const url = `https://checkout.stripe.test/${id}`;
      sesiones.set(id, { id, pedidoId: datos.pedidoId, estado: 'open', pagado: false, paymentIntent: null, url, datos });
      return { id, url };
    },
    async obtenerSesion(id) {
      const s = sesiones.get(id);
      if (!s) throw new Error('no existe');
      return { ...s };
    },
    async expirarSesion(id) {
      const s = sesiones.get(id)!;
      if (s.estado === 'open') s.estado = 'expired';
    },
    async reembolsar(pi) {
      reembolsos.push(pi);
    },
    leerWebhook(cuerpo, firma): EventoPago {
      if (firma !== 'firma-valida') throw new Error('Firma inválida');
      const e = JSON.parse(cuerpo.toString());
      const s = sesiones.get(e.sesion)!;
      return e.tipo === 'pagado' ? { tipo: 'pagado', sesion: { ...s } } : { tipo: 'vencido', sesion: { ...s } };
    },
  };
  const pagar = (id: string) => {
    const s = sesiones.get(id)!;
    Object.assign(s, { estado: 'complete', pagado: true, paymentIntent: `pi_${id}` });
  };
  return { pasarela, sesiones, reembolsos, pagar };
}

type Entorno = Awaited<ReturnType<typeof entornoDePrueba>>;

describe('tienda web', () => {
  let e: Entorno;
  let ids: Record<string, string>;
  let falsa: ReturnType<typeof pasarelaFalsa>;
  let tk: string; // cliente Ana
  let sucursalId: string;

  const pub = () => request(e.app);
  const cli = (token: string) => ({
    get: (u: string) => request(e.app).get(`/api/v1/tienda${u}`).set('Authorization', `Bearer ${token}`),
    post: (u: string, b?: object) => request(e.app).post(`/api/v1/tienda${u}`).set('Authorization', `Bearer ${token}`).send(b ?? {}),
    put: (u: string, b: object) => request(e.app).put(`/api/v1/tienda${u}`).set('Authorization', `Bearer ${token}`).send(b),
    patch: (u: string, b: object) => request(e.app).patch(`/api/v1/tienda${u}`).set('Authorization', `Bearer ${token}`).send(b),
  });
  const stockDe = async (productoId: string | undefined) =>
    (await e.db.select().from(stock).where(eq(stock.productoId, productoId!))).find((s) => s.sucursalId === sucursalId)?.cantidad;
  const datosRetiro = { entrega: 'RETIRO', metodoPago: 'EN_TIENDA', nombreContacto: 'Ana Pérez', telefono: '70012345' };

  beforeAll(async () => {
    falsa = pasarelaFalsa();
    e = await entornoDePrueba({ pagos: falsa.pasarela });
    ids = await e.prepararCatalogo();
    sucursalId = e.semilla.sucursal.id;
    // Un producto oculto de la tienda
    await e.admin.patch(`/catalogo/productos/${ids['LEN-156-AR']}`, { visibleTienda: false, imagenUrl: 'https://img.test/lente.jpg' });
  });
  afterAll(() => e.cerrar());

  it('el catálogo es público y no muestra costos ni productos ocultos', async () => {
    const r = await pub().get('/api/v1/tienda/productos?porPagina=48');
    expect(r.status).toBe(200);
    const skus = r.body.datos.map((p: { nombre: string }) => p.nombre);
    expect(skus).toContain('Montura Clubmaster negro');
    expect(skus).not.toContain('Lente monofocal 1.56 antirreflejo (par)');
    const montura = r.body.datos.find((p: { id: string }) => p.id === ids['MON-RB5154-NEG']);
    expect(montura).toMatchObject({ precio: 120000, disponible: 4, marca: 'Ray-Ban' });
    expect(montura.costoPromedio).toBeUndefined();
    // El servicio no controla stock: disponible null (sin límite)
    expect(r.body.datos.find((p: { id: string }) => p.id === ids['SRV-CONSULTA']).disponible).toBeNull();

    const busca = await pub().get('/api/v1/tienda/productos?q=ray-ban');
    expect(busca.body.total).toBe(1);
    const caros = await pub().get('/api/v1/tienda/productos?orden=precio_desc&tipo=MONTURA');
    expect(caros.body.datos[0].precio).toBe(120000);

    const oculto = await pub().get(`/api/v1/tienda/productos/${ids['LEN-156-AR']}`);
    expect(oculto.status).toBe(404);
    const info = await pub().get('/api/v1/tienda/info');
    expect(info.body).toMatchObject({ pagoEnLinea: true, costoEnvio: 2000 });
    expect(info.body.marcas.map((m: { nombre: string }) => m.nombre)).toEqual(['Ray-Ban', 'Vitaly']);
  });

  it('un cliente se registra, ingresa y su token no abre el sistema interno', async () => {
    const reg = await pub().post('/api/v1/tienda/auth/registro').send({ nombre: 'Ana Pérez', email: 'Ana@Correo.bo', password: 'secreto123', telefono: '70012345' });
    expect(reg.status).toBe(201);
    expect(reg.body.cuenta).toMatchObject({ email: 'ana@correo.bo', nombre: 'Ana Pérez' });
    const dup = await pub().post('/api/v1/tienda/auth/registro').send({ nombre: 'Otra', email: 'ana@correo.bo', password: 'secreto123' });
    expect(dup.status).toBe(409);

    const mal = await pub().post('/api/v1/tienda/auth/login').send({ email: 'ana@correo.bo', password: 'otra-cosa' });
    expect(mal.status).toBe(401);
    const ok = await pub().post('/api/v1/tienda/auth/login').send({ email: 'ana@correo.bo', password: 'secreto123' });
    expect(ok.status).toBe(200);
    tk = ok.body.token;

    // El token de cliente no sirve para el personal, y el del personal no sirve en la tienda.
    expect((await e.como(tk).get('/panel')).status).toBe(401);
    expect((await e.como(tk).get('/clientes')).status).toBe(401);
    const tkAdmin = await e.login('admin@prueba.bo', 'ClaveDePrueba123');
    expect((await cli(tkAdmin).get('/carrito')).status).toBe(401);

    // El personal ve al cliente registrado como cualquier otro cliente.
    const clientes = await e.admin.get('/clientes?q=Ana');
    expect(clientes.body.datos?.[0]?.nombre ?? clientes.body[0]?.nombre).toBe('Ana Pérez');

    const perfil = await cli(tk).patch('/cuenta', { direccion: 'Av. Arce 123', nit: '1234567' });
    expect(perfil.body).toMatchObject({ direccion: 'Av. Arce 123', nit: '1234567' });
    expect((await cli(tk).post('/cuenta/password', { actual: 'mala', nueva: 'nueva-clave-1' })).status).toBe(422);
  });

  it('el carrito respeta el stock y junta el carrito del visitante', async () => {
    const mucho = await cli(tk).put(`/carrito/${ids['MON-RB5154-NEG']}`, { cantidad: 5 });
    expect(mucho.status).toBe(422);
    expect(mucho.body.error.detalles.disponible).toBe(4);

    const ok = await cli(tk).put(`/carrito/${ids['MON-RB5154-NEG']}`, { cantidad: 2 });
    expect(ok.body).toMatchObject({ unidades: 2, subtotal: 240000, listoParaPagar: true });

    // Lo que armó sin sesión: suma, sin pasar lo disponible, e ignora lo oculto.
    const f = await cli(tk).post('/carrito/fusionar', {
      items: [
        { productoId: ids['MON-RB5154-NEG'], cantidad: 9 },
        { productoId: ids['LIQ-MULTI-360'], cantidad: 2 },
        { productoId: ids['LEN-156-AR'], cantidad: 1 },
      ],
    });
    expect(f.body.items.map((i: { productoId: string; cantidad: number }) => [i.productoId, i.cantidad])).toEqual([
      [ids['MON-RB5154-NEG'], 4],
      [ids['LIQ-MULTI-360'], 2],
    ]);
    await cli(tk).put(`/carrito/${ids['MON-RB5154-NEG']}`, { cantidad: 1 });
  });

  it('pedido con pago al retirar: reserva el stock, el personal lo prepara y lo entrega', async () => {
    const envioEnTienda = await cli(tk).post('/pedidos', { ...datosRetiro, entrega: 'ENVIO', direccion: 'Calle 1 #2' });
    expect(envioEnTienda.status).toBe(400);

    const r = await cli(tk).post('/pedidos', datosRetiro);
    expect(r.status).toBe(201);
    expect(r.body.urlPago).toBeNull();
    expect(r.body.pedido).toMatchObject({ numero: 'W-MAT-000001', estado: 'PENDIENTE_PAGO', total: 120000 + 13000 });
    const id = r.body.pedido.id;
    expect(await stockDe(ids['MON-RB5154-NEG'])).toBe(3);
    expect(await stockDe(ids['LIQ-MULTI-360'])).toBe(22);
    expect((await cli(tk).get('/carrito')).body.items).toHaveLength(0);

    // Otro cliente no puede ver el pedido
    const otro = await pub().post('/api/v1/tienda/auth/registro').send({ nombre: 'Luis', email: 'luis@correo.bo', password: 'secreto123' });
    expect((await cli(otro.body.token).get(`/pedidos/${id}`)).status).toBe(404);

    // Personal: el panel avisa y el pedido avanza
    const cajero = await e.admin.post('/usuarios', { nombre: 'Caja', email: 'caja@prueba.bo', password: 'ClaveCaja123', rol: 'CAJERO', sucursalId });
    expect(cajero.status).toBe(201);
    const caja = e.como(await e.login('caja@prueba.bo', 'ClaveCaja123'));
    const panel = await caja.get('/panel');
    expect(panel.body.tareas.find((t: { clave: string }) => t.clave === 'pedidos-web')?.cantidad).toBe(1);

    const lista = await caja.get('/pedidos-web?estado=POR_ATENDER');
    expect(lista.body.datos).toHaveLength(1);
    expect(lista.body.datos[0]).toMatchObject({ email: 'ana@correo.bo', unidades: 3 });
    const det = await caja.get(`/pedidos-web/${id}`);
    expect(det.body.siguientes).toEqual(['PREPARANDO', 'LISTO']);

    expect((await caja.post(`/pedidos-web/${id}/estado`, { estado: 'ENVIADO' })).status).toBe(409);
    expect((await caja.post(`/pedidos-web/${id}/estado`, { estado: 'LISTO', nota: 'En vitrina 2' })).status).toBe(200);
    // Entregar un pedido con pago al retirar exige cobrarlo en caja
    expect((await caja.get(`/pedidos-web/${id}`)).body.cobrarAlEntregar).toBe(true);
    expect((await caja.post(`/pedidos-web/${id}/estado`, { estado: 'ENTREGADO' })).status).toBe(422);
    const sinCaja = await caja.post(`/pedidos-web/${id}/estado`, { estado: 'ENTREGADO', pagos: [{ metodo: 'EFECTIVO', monto: 133000 }] });
    expect(sinCaja.status).toBe(422);
    expect(sinCaja.body.error.mensaje).toMatch(/caja abierta/);
    await caja.post('/caja/abrir', { montoApertura: 10000 });
    expect((await caja.post(`/pedidos-web/${id}/estado`, { estado: 'ENTREGADO', pagos: [{ metodo: 'EFECTIVO', monto: 100000 }] })).status).toBe(422);
    const entregado = await caja.post(`/pedidos-web/${id}/estado`, {
      estado: 'ENTREGADO',
      pagos: [
        { metodo: 'EFECTIVO', monto: 100000 },
        { metodo: 'QR', monto: 33000, referencia: 'QR-778' },
      ],
    });
    expect(entregado.status).toBe(200);
    expect(entregado.body.estado).toBe('ENTREGADO');
    expect(entregado.body.pagadoEn).not.toBeNull();
    // Quedó como venta pagada, con el cobro en la caja
    const det2 = await caja.get(`/pedidos-web/${id}`);
    expect(det2.body.ventaNumero).toMatch(/^V-MAT-/);
    const venta = (await caja.get(`/ventas/${entregado.body.ventaId}`)).body;
    expect(venta).toMatchObject({ total: 133000, pagado: 133000, saldo: 0, estadoPago: 'PAGADA' });
    expect(venta.notas).toContain('W-MAT-000001');
    const cajaActual = (await caja.get('/caja/actual')).body;
    expect(cajaActual.efectivoEsperado).toBe(10000 + 100000);
    expect(cajaActual.porMetodo.QR.ingresos).toBe(33000);
    // El stock no se descontó dos veces
    expect(await stockDe(ids['MON-RB5154-NEG'])).toBe(3);
    // Y cuenta en los reportes
    const rep = (await e.admin.get('/reportes/dashboard')).body;
    expect(rep.hoy.monto).toBeGreaterThanOrEqual(133000);
    expect((await cli(tk).get(`/pedidos/${id}`)).body.notasInternas).toBeUndefined();

    // Un optometrista no atiende pedidos web
    await e.admin.post('/usuarios', { nombre: 'Opto', email: 'opto@prueba.bo', password: 'ClaveOpto123', rol: 'OPTOMETRISTA', sucursalId });
    const opto = e.como(await e.login('opto@prueba.bo', 'ClaveOpto123'));
    expect((await opto.get('/pedidos-web')).status).toBe(403);

    // Queda en la auditoría
    const ev = await e.admin.get('/auditoria/eventos?modulo=tienda');
    expect(ev.body.datos?.length ?? ev.body.length).toBeGreaterThan(0);
  });

  it('pago con Stripe: abre el pago, confirma por verificación y por webhook sin duplicar', async () => {
    await cli(tk).put(`/carrito/${ids['MON-VIT-2201-CAR']}`, { cantidad: 2 });
    const r = await cli(tk).post('/pedidos', { entrega: 'ENVIO', metodoPago: 'STRIPE', nombreContacto: 'Ana', telefono: '70012345', direccion: 'Av. Arce 123', ciudad: 'La Paz' });
    expect(r.status).toBe(201);
    expect(r.body.urlPago).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const id = r.body.pedido.id;
    expect(r.body.pedido.total).toBe(90000 + 2000);
    const sesionId = [...falsa.sesiones.values()].find((s) => s.pedidoId === id)!.id;
    const sesion = falsa.sesiones.get(sesionId)!;
    expect(sesion.datos.costoEnvio).toBe(2000);
    expect(sesion.datos.urlExito).toBe(`http://localhost:5173/pedidos/${id}?pago=exito`);

    // Sin pagar todavía
    expect((await cli(tk).post(`/pedidos/${id}/verificar`)).body.estado).toBe('PENDIENTE_PAGO');
    // Reintentar el pago devuelve la misma sesión abierta
    expect((await cli(tk).post(`/pedidos/${id}/pagar`)).body.urlPago).toBe(sesion.url);

    falsa.pagar(sesionId);
    const v = await cli(tk).post(`/pedidos/${id}/verificar`);
    expect(v.body.estado).toBe('PAGADO');
    expect(v.body.stripeSessionId).toBeUndefined();

    const malFirmado = await pub().post('/api/v1/tienda/stripe/webhook').set('stripe-signature', 'x').set('content-type', 'application/json').send(JSON.stringify({ tipo: 'pagado', sesion: sesionId }));
    expect(malFirmado.status).toBe(400);
    const wh = await pub().post('/api/v1/tienda/stripe/webhook').set('stripe-signature', 'firma-valida').set('content-type', 'application/json').send(JSON.stringify({ tipo: 'pagado', sesion: sesionId }));
    expect(wh.status).toBe(200);
    const [p] = await e.db.select().from(pedidosWeb).where(eq(pedidosWeb.id, id));
    expect(p!.estado).toBe('PAGADO');
    expect(await stockDe(ids['MON-VIT-2201-CAR'])).toBe(8);

    // Ya pagado: el cliente no lo cancela; el personal sí, con reembolso y devolución de stock.
    expect((await cli(tk).post(`/pedidos/${id}/cancelar`)).status).toBe(422);
    // Un pedido con tarjeta se entrega sin cobrar en caja y queda como venta pagada
    expect((await e.admin.get(`/pedidos-web/${id}`)).body.cobrarAlEntregar).toBe(false);
    const c = await e.admin.post(`/pedidos-web/${id}/cancelar`, { motivo: 'Sin stock de color' });
    expect(c.status).toBe(200);
    expect(c.body.canceladoMotivo).toContain('reembolsado');
    expect(falsa.reembolsos).toEqual([`pi_${sesionId}`]);
    expect(await stockDe(ids['MON-VIT-2201-CAR'])).toBe(10);
  });

  it('cancelar o dejar vencer un pago devuelve el stock', async () => {
    await cli(tk).put(`/carrito/${ids['MON-VIT-2201-CAR']}`, { cantidad: 1 });
    const a = await cli(tk).post('/pedidos', { ...datosRetiro, metodoPago: 'STRIPE' });
    expect(await stockDe(ids['MON-VIT-2201-CAR'])).toBe(9);
    const cancelado = await cli(tk).post(`/pedidos/${a.body.pedido.id}/cancelar`);
    expect(cancelado.body.estado).toBe('CANCELADO');
    expect(await stockDe(ids['MON-VIT-2201-CAR'])).toBe(10);
    const sesion = [...falsa.sesiones.values()].find((s) => s.pedidoId === a.body.pedido.id)!;
    expect(sesion.estado).toBe('expired');

    // Vence sin pagar
    await cli(tk).put(`/carrito/${ids['MON-VIT-2201-CAR']}`, { cantidad: 3 });
    const b = await cli(tk).post('/pedidos', { ...datosRetiro, metodoPago: 'STRIPE' });
    expect(await stockDe(ids['MON-VIT-2201-CAR'])).toBe(7);
    await e.db.update(pedidosWeb).set({ expiraEn: new Date(Date.now() - 1000) }).where(eq(pedidosWeb.id, b.body.pedido.id));
    expect(await liberarVencidos(e.db, falsa.pasarela)).toBe(1);
    expect((await cli(tk).get(`/pedidos/${b.body.pedido.id}`)).body.estado).toBe('CANCELADO');
    expect(await stockDe(ids['MON-VIT-2201-CAR'])).toBe(10);

    // Pero si el pago llegó tarde, se confirma igual y el stock se vuelve a reservar.
    falsa.pagar([...falsa.sesiones.values()].find((s) => s.pedidoId === b.body.pedido.id)!.id);
    const v = await e.db.select().from(pedidosWeb).where(eq(pedidosWeb.id, b.body.pedido.id));
    expect(v[0]!.estado).toBe('CANCELADO');
    const sId = [...falsa.sesiones.values()].find((s) => s.pedidoId === b.body.pedido.id)!.id;
    await pub().post('/api/v1/tienda/stripe/webhook').set('stripe-signature', 'firma-valida').set('content-type', 'application/json').send(JSON.stringify({ tipo: 'pagado', sesion: sId }));
    expect((await cli(tk).get(`/pedidos/${b.body.pedido.id}`)).body.estado).toBe('PAGADO');
    expect(await stockDe(ids['MON-VIT-2201-CAR'])).toBe(7);

    // Pagado con tarjeta: se entrega sin pasar por caja y queda como venta pagada
    const antes = (await e.admin.get('/caja/actual')).body.totalIngresos;
    await e.admin.post(`/pedidos-web/${b.body.pedido.id}/estado`, { estado: 'LISTO' });
    const ent = await e.admin.post(`/pedidos-web/${b.body.pedido.id}/estado`, { estado: 'ENTREGADO' });
    expect(ent.status).toBe(200);
    const vb = (await e.admin.get(`/ventas/${ent.body.ventaId}`)).body;
    expect(vb).toMatchObject({ total: 135000, pagado: 135000, saldo: 0 });
    expect(vb.notas).toContain('Stripe');
    expect((await e.admin.get('/caja/actual')).body.totalIngresos).toBe(antes);
    expect(await stockDe(ids['MON-VIT-2201-CAR'])).toBe(7);

    const mios = await cli(tk).get('/pedidos');
    expect(mios.body.length).toBe(4);
  });

  it('sin Stripe configurado solo se puede pagar al retirar', async () => {
    const sinStripe = crearApp(e.db, { pagos: null });
    const info = await request(sinStripe).get('/api/v1/tienda/info');
    expect(info.body.pagoEnLinea).toBe(false);
    await cli(tk).put(`/carrito/${ids['LIQ-MULTI-360']}`, { cantidad: 1 });
    const r = await request(sinStripe)
      .post('/api/v1/tienda/pedidos')
      .set('Authorization', `Bearer ${tk}`)
      .send({ ...datosRetiro, metodoPago: 'STRIPE' });
    expect(r.status).toBe(503);
    expect(r.body.error.codigo).toBe('PAGOS_NO_CONFIGURADOS');
    // El carrito sigue intacto
    expect((await cli(tk).get('/carrito')).body.unidades).toBe(1);
  });
});

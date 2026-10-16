import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { crearApp } from '../src/app.js';
import { plantilla, type Correo, type Mensaje } from '../src/lib/correo.js';
import { ahoraBolivia, sumarDias } from '../src/lib/horario.js';
import { entornoDePrueba } from './helpers.js';

describe('correos a clientes', () => {
  const enviados: Mensaje[] = [];
  const correo: Correo = { enviar: async (m) => void enviados.push(m) };
  let e: Awaited<ReturnType<typeof entornoDePrueba>>;
  let ids: Record<string, string>;

  /** Los correos salen sin frenar la respuesta: se espera a que lleguen. */
  const esperarCorreo = (asunto: RegExp) =>
    vi.waitFor(() => {
      const m = enviados.find((x) => asunto.test(x.asunto));
      if (!m) throw new Error(`sin correo ${asunto}`);
      return m;
    });
  const enlaceDe = (m: Mensaje) => m.texto.match(/https?:\/\/\S+/)![0];
  const tiendaPost = (u: string, b: object, tk?: string) => {
    const r = request(e.app).post(`/api/v1/tienda${u}`);
    return (tk ? r.set('Authorization', `Bearer ${tk}`) : r).send(b);
  };

  beforeAll(async () => {
    e = await entornoDePrueba({ pagos: null, correo });
    ids = await e.prepararCatalogo();
  });
  afterAll(() => e.cerrar());

  it('recuperar contraseña: enlace por correo, de un solo uso, y cierra las sesiones viejas', async () => {
    const reg = await tiendaPost('/auth/registro', { nombre: 'Luz Choque', email: 'luz@correo.bo', password: 'vieja-clave-1' });
    const tokenViejo = reg.body.token;
    expect((await request(e.app).get('/api/v1/tienda/info')).body.recuperacionPorCorreo).toBe(true);

    // La respuesta es igual exista o no la cuenta
    const nadie = await tiendaPost('/auth/recuperar', { email: 'nadie@correo.bo' });
    const luz = await tiendaPost('/auth/recuperar', { email: 'LUZ@correo.bo' });
    expect(nadie.status).toBe(200);
    expect(luz.body).toEqual(nadie.body);

    const m = await esperarCorreo(/nueva contraseña/);
    expect(m.para).toBe('luz@correo.bo');
    expect(enviados.filter((x) => /nueva contraseña/.test(x.asunto))).toHaveLength(1);
    const enlace = enlaceDe(m);
    expect(enlace).toMatch(/^http:\/\/localhost:5173\/restablecer\?token=/);
    const token = new URL(enlace).searchParams.get('token')!;

    expect((await tiendaPost('/auth/restablecer', { token, password: 'corta' })).status).toBe(400);
    const ok = await tiendaPost('/auth/restablecer', { token, password: 'nueva-clave-2' });
    expect(ok.status).toBe(200);
    expect(ok.body.cuenta.email).toBe('luz@correo.bo');

    // El enlace no sirve dos veces; la sesión vieja quedó cerrada; la clave nueva funciona
    expect((await tiendaPost('/auth/restablecer', { token, password: 'otra-clave-3' })).status).toBe(422);
    expect((await request(e.app).get('/api/v1/tienda/cuenta').set('Authorization', `Bearer ${tokenViejo}`)).status).toBe(401);
    expect((await request(e.app).get('/api/v1/tienda/cuenta').set('Authorization', `Bearer ${ok.body.token}`)).status).toBe(200);
    expect((await tiendaPost('/auth/login', { email: 'luz@correo.bo', password: 'vieja-clave-1' })).status).toBe(401);
    expect((await tiendaPost('/auth/login', { email: 'luz@correo.bo', password: 'nueva-clave-2' })).status).toBe(200);
  });

  it('cambiar la contraseña devuelve un token nuevo y cierra las otras sesiones', async () => {
    const reg = await tiendaPost('/auth/registro', { nombre: 'Juan Mamani', email: 'juan@correo.bo', password: 'clave-juan-1' });
    const otroDispositivo = (await tiendaPost('/auth/login', { email: 'juan@correo.bo', password: 'clave-juan-1' })).body.token;
    const cambio = await tiendaPost('/cuenta/password', { actual: 'clave-juan-1', nueva: 'clave-juan-2' }, reg.body.token);
    expect(cambio.status).toBe(200);
    expect((await request(e.app).get('/api/v1/tienda/cuenta').set('Authorization', `Bearer ${cambio.body.token}`)).status).toBe(200);
    expect((await request(e.app).get('/api/v1/tienda/cuenta').set('Authorization', `Bearer ${otroDispositivo}`)).status).toBe(401);
  });

  it('avisa al cliente: pedido recibido, listo y cancelado', async () => {
    const reg = await tiendaPost('/auth/registro', { nombre: 'Ana Pérez', email: 'ana@correo.bo', password: 'secreto123' });
    const tk = reg.body.token;
    await request(e.app).put(`/api/v1/tienda/carrito/${ids['LIQ-MULTI-360']}`).set('Authorization', `Bearer ${tk}`).send({ cantidad: 2 });
    const p = await tiendaPost('/pedidos', { entrega: 'RETIRO', metodoPago: 'EN_TIENDA', nombreContacto: 'Ana Pérez', telefono: '70012345' }, tk);
    const numero = p.body.pedido.numero;
    const recibido = await esperarCorreo(new RegExp(`Recibimos tu pedido ${numero}`));
    expect(recibido.para).toBe('ana@correo.bo');
    expect(recibido.texto).toContain('Bs 130,00');

    await e.admin.post(`/pedidos-web/${p.body.pedido.id}/estado`, { estado: 'LISTO' });
    const listo = await esperarCorreo(/está listo/);
    expect(listo.texto).toContain('El total a pagar es Bs 130,00');

    await e.admin.post(`/pedidos-web/${p.body.pedido.id}/cancelar`, { motivo: 'El cliente no pasó a retirarlo' });
    const cancelado = await esperarCorreo(/cancelado/);
    expect(cancelado.texto).toContain('El cliente no pasó a retirarlo');
    expect(cancelado.texto).toContain('No se hizo ningún cobro');
  });

  it('confirma por correo la cita reservada en la tienda', async () => {
    const tk = (await tiendaPost('/auth/registro', { nombre: 'Rosa Mamani', email: 'rosa@correo.bo', password: 'secreto123' })).body.token;
    let dia = sumarDias(ahoraBolivia().fecha, 1);
    while ([0, 6].includes(new Date(`${dia}T12:00:00Z`).getUTCDay())) dia = sumarDias(dia, 1);
    const r = await tiendaPost('/citas', { fecha: dia, hora: '10:00', telefono: '71234567' }, tk);
    expect(r.status).toBe(201);
    const m = await esperarCorreo(/Tu cita del/);
    expect(m.para).toBe('rosa@correo.bo');
    expect(m.asunto).toContain('a las 10:00');
    expect(m.texto).toContain('examen de la vista');
  });

  it('sin servicio de correo, recuperar avisa que no está disponible', async () => {
    const sinCorreo = crearApp(e.db, { pagos: null, correo: null });
    expect((await request(sinCorreo).get('/api/v1/tienda/info')).body.recuperacionPorCorreo).toBe(false);
    const r = await request(sinCorreo).post('/api/v1/tienda/auth/recuperar').send({ email: 'ana@correo.bo' });
    expect(r.status).toBe(503);
    expect(r.body.error.codigo).toBe('CORREO_NO_CONFIGURADO');
  });

  it('la plantilla escapa lo que escribe el cliente', () => {
    const m = plantilla({ para: 'a@b.bo', asunto: 'x', saludo: 'Hola <script>alert(1)</script>:', parrafos: ['"comillas" & más'] });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('&quot;comillas&quot; &amp; más');
  });
});

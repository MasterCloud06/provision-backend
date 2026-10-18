import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ahoraBolivia, leerHorario, sumarDias, turnosDelDia } from '../src/lib/horario.js';
import { entornoDePrueba } from './helpers.js';

describe('horario de atención', () => {
  it('lee el horario como lo escribe una persona', () => {
    const h = leerHorario('lun-vie 09:00-13:00 15:00-19:00; sab 09:00-12:00');
    expect(turnosDelDia(h, '2026-10-19', 30)).toHaveLength(16); // lunes
    expect(turnosDelDia(h, '2026-10-24', 60)).toEqual(['09:00', '10:00', '11:00']); // sábado
    expect(turnosDelDia(h, '2026-10-25', 30)).toEqual([]); // domingo
    expect(() => leerHorario('lunes 9-13')).toThrow();
  });
});

describe('citas', () => {
  let e: Awaited<ReturnType<typeof entornoDePrueba>>;
  let tk: string;
  /** Un día hábil (lunes a viernes) dentro de los próximos días. */
  let dia: string;

  beforeAll(async () => {
    e = await entornoDePrueba();
    const reg = await request(e.app).post('/api/v1/tienda/auth/registro').send({ nombre: 'Rosa Mamani', email: 'rosa@correo.bo', password: 'secreto123' });
    tk = reg.body.token;
    dia = sumarDias(ahoraBolivia().fecha, 1);
    while ([0, 6].includes(new Date(`${dia}T12:00:00Z`).getUTCDay())) dia = sumarDias(dia, 1);
  });
  afterAll(() => e.cerrar());

  const tienda = (u: string) => request(e.app).post(`/api/v1/tienda${u}`).set('Authorization', `Bearer ${tk}`);

  it('muestra los turnos libres sin necesidad de cuenta', async () => {
    const r = await request(e.app).get(`/api/v1/tienda/citas/disponibilidad?desde=${dia}&dias=1`);
    expect(r.status).toBe(200);
    expect(r.body.dias[0].fecha).toBe(dia);
    expect(r.body.dias[0].turnos[0]).toEqual({ hora: '09:00', libre: true });
    expect(r.body.motivos.EXAMEN_VISTA).toBe('Examen de la vista');
  });

  it('el cliente reserva, el turno se ocupa y no puede tener más de 2 citas', async () => {
    const c = await tienda('/citas').send({ fecha: dia, hora: '09:00', telefono: '70011122', notas: 'Me duele la cabeza al leer' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ estado: 'PENDIENTE', nombreContacto: 'Rosa Mamani', motivoTexto: 'Examen de la vista' });

    const otra = await request(e.app).post('/api/v1/tienda/auth/registro').send({ nombre: 'Juan', email: 'juan@correo.bo', password: 'secreto123' });
    const ocupado = await request(e.app).post('/api/v1/tienda/citas').set('Authorization', `Bearer ${otra.body.token}`).send({ fecha: dia, hora: '09:00', telefono: '70099999' });
    expect(ocupado.status).toBe(409);

    const disp = await request(e.app).get(`/api/v1/tienda/citas/disponibilidad?desde=${dia}&dias=1`);
    expect(disp.body.dias[0].turnos[0]).toEqual({ hora: '09:00', libre: false });

    expect((await tienda('/citas').send({ fecha: dia, hora: '08:00', telefono: '70011122' })).status).toBe(422); // fuera de horario
    expect((await tienda('/citas').send({ fecha: dia, hora: '09:30', telefono: '70011122' })).status).toBe(201);
    const tercera = await tienda('/citas').send({ fecha: dia, hora: '10:00', telefono: '70011122' });
    expect(tercera.status).toBe(422);
    expect(tercera.body.error.mensaje).toMatch(/2 citas/);

    const mias = await request(e.app).get('/api/v1/tienda/citas').set('Authorization', `Bearer ${tk}`);
    expect(mias.body).toHaveLength(2);
    const cancelada = await tienda(`/citas/${mias.body[0].id}/cancelar`);
    expect(cancelada.body.estado).toBe('CANCELADA');
  });

  it('el personal ve la agenda, reserva por teléfono y marca la atención', async () => {
    const agenda = await e.admin.get(`/citas?desde=${dia}&hasta=${dia}`);
    expect(agenda.status).toBe(200);
    expect(agenda.body.map((c: { hora: string }) => c.hora)).toEqual(['09:00', '09:30']);
    const rosa = agenda.body.find((c: { estado: string }) => c.estado === 'PENDIENTE');
    expect(rosa).toMatchObject({ desdeTienda: true, siguientes: ['CONFIRMADA', 'ATENDIDA', 'NO_ASISTIO', 'CANCELADA'] });

    const tel = await e.admin.post('/citas', { fecha: dia, hora: '11:00', motivo: 'CONTROL', nombreContacto: 'Pedro Quispe', telefono: '76543210' });
    expect(tel.status).toBe(201);
    expect(tel.body.estado).toBe('CONFIRMADA');
    // Se creó su ficha de cliente para cargarle la receta después
    expect(tel.body.clienteId).toBeTruthy();

    expect((await e.admin.post(`/citas/${rosa.id}/estado`, { estado: 'CONFIRMADA' })).body.estado).toBe('CONFIRMADA');
    const atendida = await e.admin.post(`/citas/${rosa.id}/estado`, { estado: 'ATENDIDA', nota: 'Receta nueva' });
    expect(atendida.body).toMatchObject({ estado: 'ATENDIDA' });
    expect(atendida.body.notasInternas).toContain('Receta nueva');
    expect((await e.admin.post(`/citas/${rosa.id}/estado`, { estado: 'CANCELADA' })).status).toBe(409);

    // El laboratorio no maneja la agenda; el optometrista sí
    await e.admin.post('/usuarios', { nombre: 'Lab', email: 'lab@p.bo', password: 'ClaveLab1234', rol: 'LABORATORIO', sucursalId: e.semilla.sucursal.id });
    expect((await e.como(await e.login('lab@p.bo', 'ClaveLab1234')).get('/citas')).status).toBe(403);
    await e.admin.post('/usuarios', { nombre: 'Opto', email: 'opto@p.bo', password: 'ClaveOpto1234', rol: 'OPTOMETRISTA', sucursalId: e.semilla.sucursal.id });
    const opto = e.como(await e.login('opto@p.bo', 'ClaveOpto1234'));
    expect((await opto.get(`/citas?desde=${dia}&hasta=${dia}`)).status).toBe(200);
  });

  it('Mi panel avisa las citas de hoy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${dia}T08:00:00-04:00`));
    try {
      // Sesión nueva "a esa hora": la del inicio de las pruebas puede haber vencido si el día elegido está lejos.
      const panel = await e.como(await e.login('admin@prueba.bo', 'ClaveDePrueba123')).get('/panel');
      const t = panel.body.tareas.find((x: { clave: string }) => x.clave === 'citas-hoy');
      expect(t).toMatchObject({ cantidad: 1, pantalla: 'agenda' }); // la de Pedro (confirmada)
    } finally {
      vi.useRealTimers();
    }
  });
});

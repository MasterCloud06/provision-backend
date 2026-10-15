import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hoy } from '../src/lib/fechas.js';
import { entornoDePrueba } from './helpers.js';

type Entorno = Awaited<ReturnType<typeof entornoDePrueba>>;
type Cliente = ReturnType<Entorno['como']>;
type Tarea = { clave: string; cantidad: number | null; urgencia: string; pantalla: string | null };

/** "Mi panel": cada rol ve para qué existe y qué tiene que hacer ahora, con datos reales. */
describe('panel por rol', () => {
  let e: Entorno;
  const ids: Record<string, string> = {};
  const u: Record<string, Cliente> = {};
  const panel = async (c: Cliente) => {
    const r = await c.get('/panel');
    expect(r.status).toBe(200);
    return r.body as { rol: string; nombreRol: string; proposito: string; responsabilidades: string[]; tareas: Tarea[]; indicadores: { titulo: string; valor: string }[] };
  };
  const tarea = (p: { tareas: Tarea[] }, clave: string) => p.tareas.find((t) => t.clave === clave);
  const ayer = () => new Date(Date.now() - 28 * 3600_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    e = await entornoDePrueba();
    Object.assign(ids, await e.prepararCatalogo());
    u.SUPERADMIN = e.admin;
    for (const rol of ['ENCARGADO', 'CAJERO', 'VENDEDOR', 'OPTOMETRISTA', 'LABORATORIO'] as const) {
      const email = `${rol.toLowerCase()}@prueba.bo`;
      await e.admin.post('/usuarios', { nombre: `Usuario ${rol}`, email, password: 'clave12345', rol, sucursalId: e.semilla.sucursal.id });
      u[rol] = e.como(await e.login(email, 'clave12345'));
    }
  });
  afterAll(() => e.cerrar());

  it('cada rol recibe su propósito, responsabilidades e indicadores', async () => {
    for (const [rol, c] of Object.entries(u)) {
      const p = await panel(c);
      expect(p.rol).toBe(rol);
      expect(p.proposito.length).toBeGreaterThan(40);
      expect(p.responsabilidades.length).toBeGreaterThanOrEqual(3);
      expect(p.indicadores.length).toBeGreaterThanOrEqual(3);
      expect(p.tareas.length).toBeGreaterThan(0);
    }
    const roles = (await e.admin.get('/auth/roles')).body;
    expect(roles[0].proposito).toMatch(/dueño del sistema/);
  });

  it('el día empieza: el cajero debe abrir caja; el laboratorio no tiene trabajo', async () => {
    expect(tarea(await panel(u.CAJERO!), 'abrir-caja')).toMatchObject({ urgencia: 'ALTA', pantalla: 'caja' });
    expect(tarea(await panel(u.LABORATORIO!), 'al-dia')).toMatchObject({ urgencia: 'OK' });
    expect(tarea(await panel(u.ENCARGADO!), 'caja-cerrada')).toBeTruthy();
  });

  it('el ejecutivo registra una venta de lentes atrasada: cada rol ve su parte', async () => {
    const c = await u.OPTOMETRISTA!.post('/clientes', { nombre: 'Juan Pérez' });
    await u.OPTOMETRISTA!.post(`/clientes/${c.body.id}/recetas`, { fecha: hoy(), odEsfera: -1, oiEsfera: -1 });
    const opto = await panel(u.OPTOMETRISTA!);
    expect(opto.indicadores.find((i) => i.titulo === 'Recetas de hoy')!.valor).toBe('1');

    const v = await u.VENDEDOR!.post('/ventas', {
      clienteId: c.body.id,
      items: [{ productoId: ids['MON-VIT-2201-CAR'], cantidad: 1 }, { productoId: ids['LEN-156-AR'], cantidad: 1 }],
      ordenTrabajo: { fechaPrometida: ayer() },
    });
    expect(v.status).toBe(201);
    ids.venta = v.body.id;
    ids.orden = v.body.ordenTrabajo.id;

    expect(tarea(await panel(u.CAJERO!), 'esperando-cobro')).toMatchObject({ cantidad: 1, urgencia: 'ALTA', pantalla: 'ventas' });
    const vend = await panel(u.VENDEDOR!);
    expect(tarea(vend, 'mandar-a-caja')).toMatchObject({ cantidad: 1 });
    expect(tarea(vend, 'atrasadas')).toMatchObject({ cantidad: 1 });
    const lab = await panel(u.LABORATORIO!);
    expect(tarea(lab, 'atrasadas')).toMatchObject({ cantidad: 1, urgencia: 'ALTA' });
    expect(tarea(lab, 'pendientes')).toMatchObject({ cantidad: 1 });
    expect(lab.tareas[0]!.urgencia).toBe('ALTA'); // ordenadas por urgencia
    expect(tarea(await panel(u.ENCARGADO!), 'ordenes-atrasadas')).toMatchObject({ cantidad: 1 });
  });

  it('caja cobra, laboratorio termina: el ejecutivo debe avisar al cliente y caja entregar', async () => {
    await u.CAJERO!.post('/caja/abrir', { montoApertura: 10000 });
    await u.CAJERO!.post(`/ventas/${ids.venta}/pagos`, { pagos: [{ metodo: 'EFECTIVO', monto: 80000 }] });
    const caja = await panel(u.CAJERO!);
    expect(tarea(caja, 'abrir-caja')).toBeUndefined();
    expect(tarea(caja, 'cerrar-caja')).toBeTruthy();
    expect(caja.indicadores.find((i) => i.titulo === 'Cobrado por ti hoy')!.valor).toBe('Bs 800,00');

    await u.LABORATORIO!.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'EN_LABORATORIO' });
    await u.LABORATORIO!.post(`/ordenes-trabajo/${ids.orden}/estado`, { estado: 'LISTO' });
    expect((await panel(u.LABORATORIO!)).indicadores.find((i) => i.titulo === 'Terminadas por ti hoy')!.valor).toBe('1');
    expect(tarea(await panel(u.VENDEDOR!), 'avisar-cliente')).toMatchObject({ cantidad: 1, urgencia: 'ALTA' });
    expect(tarea(await panel(u.CAJERO!), 'listas-pagadas')).toMatchObject({ cantidad: 1, pantalla: 'laboratorio' });
  });

  it('el super administrador ve los intentos negados del día', async () => {
    await u.VENDEDOR!.post('/caja/abrir', { montoApertura: 100 });
    const p = await panel(u.SUPERADMIN!);
    expect(tarea(p, 'negados')).toMatchObject({ urgencia: 'ALTA', pantalla: 'auditoria' });
    expect(p.indicadores.map((i) => i.titulo)).toContain('Actividad de hoy');
  });
});

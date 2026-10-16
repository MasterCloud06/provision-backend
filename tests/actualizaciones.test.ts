import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { crearApp } from '../src/app.js';
import { compilacionDe, leerCliente, Versiones, type Plataforma, type Version } from '../src/lib/versiones.js';
import { entornoDePrueba } from './helpers.js';

const version = (compilacion: number, ext: string): Version => ({
  compilacion,
  version: `Provisión 0.1 (compilación ${compilacion})`,
  url: `https://github.com/x/y/releases/download/t/provision.${ext}`,
  tamano: 1000,
  notas: null,
  publicadaEn: '2026-10-16T04:00:00Z',
});

describe('actualización obligatoria', () => {
  const publicadas: Record<Plataforma, Version | null> = { escritorio: version(30, 'exe'), android: version(12, 'apk') };
  let e: Awaited<ReturnType<typeof entornoDePrueba>>;
  let app: ReturnType<typeof crearApp>;

  beforeAll(async () => {
    e = await entornoDePrueba();
    app = crearApp(e.db, { pagos: null, versiones: async (p) => publicadas[p] });
    // Deja que la consulta inicial termine
    await request(app).get('/api/v1/actualizaciones');
  });
  afterAll(() => e.cerrar());

  const login = (cabecera?: string) => {
    const r = request(app).post('/api/v1/auth/login');
    return (cabecera ? r.set('X-Provision-App', cabecera) : r).send({ email: 'admin@prueba.bo', password: 'ClaveDePrueba123' });
  };

  it('publica la última versión de cada app', async () => {
    const r = await request(app).get('/api/v1/actualizaciones');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ obligatoria: true, escritorio: { compilacion: 30 }, android: { compilacion: 12 } });
  });

  it('una app vieja no puede ingresar ni operar; la al día sí', async () => {
    const vieja = await login('escritorio/29');
    expect(vieja.status).toBe(426);
    expect(vieja.body.error).toMatchObject({ codigo: 'ACTUALIZACION_REQUERIDA', detalles: { plataforma: 'escritorio', actual: 29, ultima: { compilacion: 30 } } });

    const alDia = await login('escritorio/30');
    expect(alDia.status).toBe(200);
    const tk = alDia.body.token;
    expect((await request(app).get('/api/v1/panel').set('Authorization', `Bearer ${tk}`).set('X-Provision-App', 'android/11')).status).toBe(426);
    expect((await request(app).get('/api/v1/panel').set('Authorization', `Bearer ${tk}`).set('X-Provision-App', 'android/12')).status).toBe(200);
  });

  it('no bloquea compilaciones de desarrollo, ni a la tienda web, ni si no hay versiones publicadas', async () => {
    expect((await login('escritorio/0')).status).toBe(200);
    expect((await login()).status).toBe(200);
    expect((await request(app).get('/api/v1/tienda/info')).status).toBe(200);
    const sinVersiones = crearApp(e.db, { pagos: null, versiones: async () => null });
    expect((await request(sinVersiones).post('/api/v1/auth/login').set('X-Provision-App', 'android/1').send({ email: 'admin@prueba.bo', password: 'ClaveDePrueba123' })).status).toBe(200);
  });

  it('si GitHub falla, sigue con lo último que supo y no bloquea a nadie por error', async () => {
    let falla = false;
    const v = new Versiones(async () => {
      if (falla) throw new Error('GitHub caído');
      return version(5, 'apk');
    }, 0);
    expect((await v.ultima('android'))?.compilacion).toBe(5);
    falla = true;
    const silencio = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await v.ultima('android'))?.compilacion).toBe(5);
    silencio.mockRestore();
  });

  it('lee etiquetas y cabeceras', () => {
    expect(compilacionDe('v0.1.0-23')).toBe(23);
    expect(compilacionDe('escritorio-41')).toBe(41);
    expect(compilacionDe('beta')).toBeNull();
    expect(leerCliente('android/15')).toEqual({ plataforma: 'android', compilacion: 15 });
    expect(leerCliente('ios/3')).toBeNull();
    expect(leerCliente(undefined)).toBeNull();
  });
});

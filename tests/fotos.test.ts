import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { esImagen, firmar, type AlmacenFotos } from '../src/lib/fotos.js';
import { entornoDePrueba } from './helpers.js';

// El JPG más chico posible (los primeros bytes son los que importan).
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(200)]);

describe('fotos de productos', () => {
  const guardadas = new Map<string, number>();
  const almacen: AlmacenFotos = {
    async subir(id, imagen) {
      guardadas.set(id, imagen.length);
      return `https://res.cloudinary.com/demo/image/upload/v1/provision/productos/${id}.jpg`;
    },
    async borrar(id) {
      guardadas.delete(id);
    },
  };
  let e: Awaited<ReturnType<typeof entornoDePrueba>>;
  let ids: Record<string, string>;
  let token: string;

  beforeAll(async () => {
    e = await entornoDePrueba({ pagos: null, fotos: almacen });
    ids = await e.prepararCatalogo();
    token = await e.login('admin@prueba.bo', 'ClaveDePrueba123');
  });
  afterAll(() => e.cerrar());

  const subir = (id: string, cuerpo: Buffer, tipo = 'image/jpeg', tk = token) =>
    request(e.app).put(`/api/v1/catalogo/productos/${id}/foto`).set('Authorization', `Bearer ${tk}`).set('Content-Type', tipo).send(cuerpo);

  it('sube la foto, la muestra en la tienda y se puede quitar', async () => {
    const id = ids['MON-RB5154-NEG']!;
    const r = await subir(id, JPG);
    expect(r.status).toBe(200);
    expect(r.body.imagenUrl).toContain(`provision/productos/${id}`);
    expect(guardadas.get(id)).toBe(JPG.length);

    const tienda = await request(e.app).get(`/api/v1/tienda/productos/${id}`);
    expect(tienda.body.imagenUrl).toBe(r.body.imagenUrl);

    const q = await e.admin.delete(`/catalogo/productos/${id}/foto`);
    expect(q.body.imagenUrl).toBeNull();
    expect(guardadas.has(id)).toBe(false);
  });

  it('rechaza lo que no es una imagen y a quien no gestiona el catálogo', async () => {
    const id = ids['MON-VIT-2201-CAR']!;
    expect((await subir(id, Buffer.from('<?php echo 1; ?>'.padEnd(100)), 'image/jpeg')).status).toBe(415);
    expect((await subir(id, JPG, 'application/pdf')).status).toBe(415);

    await e.admin.post('/usuarios', { nombre: 'Lab', email: 'lab@prueba.bo', password: 'ClaveLab1234', rol: 'LABORATORIO', sucursalId: e.semilla.sucursal.id });
    const lab = await e.login('lab@prueba.bo', 'ClaveLab1234');
    expect((await subir(id, JPG, 'image/jpeg', lab)).status).toBe(403);
  });

  it('el producto guarda descripción, características y si se ve en la tienda', async () => {
    const id = ids['MON-VIT-2201-CAR']!;
    const r = await e.admin.patch(`/catalogo/productos/${id}`, {
      descripcion: 'Acetato italiano, bisagras flexibles',
      atributos: { genero: 'MUJER', material: 'Acetato', color: 'Carey', forma: 'Cat-eye', calibre: 52, puente: 18, varilla: 140 },
      visibleTienda: false,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ descripcion: 'Acetato italiano, bisagras flexibles', visibleTienda: false });
    expect((await request(e.app).get(`/api/v1/tienda/productos/${id}`)).status).toBe(404);
    const lista = await e.admin.get('/catalogo/productos?q=2201');
    expect(lista.body.datos[0]).toMatchObject({ visibleTienda: false, descripcion: 'Acetato italiano, bisagras flexibles' });
  });

  it('sin Cloudinary configurado avisa con un mensaje claro', async () => {
    const sinFotos = crearApp(e.db, { pagos: null, fotos: null });
    const r = await request(sinFotos)
      .put(`/api/v1/catalogo/productos/${ids['LIQ-MULTI-360']}/foto`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'image/jpeg')
      .send(JPG);
    expect(r.status).toBe(503);
    expect(r.body.error.codigo).toBe('FOTOS_NO_CONFIGURADAS');
  });

  it('reconoce formatos y firma como Cloudinary', () => {
    expect(esImagen(JPG)).toBe(true);
    expect(esImagen(Buffer.from('GIF89a........'))).toBe(false);
    // Ejemplo de la documentación de Cloudinary
    expect(firmar({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: '1315060510' }, 'abcd')).toBe(
      'bfd09f95f331f558cbd1320e67aa8d488770583e',
    );
  });
});

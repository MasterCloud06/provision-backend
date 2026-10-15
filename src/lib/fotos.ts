import { createHash } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Dónde se guardan las fotos de productos. Render borra los archivos en cada reinicio,
 * así que van a Cloudinary. Los tests usan un almacén falso con la misma forma.
 */
export interface AlmacenFotos {
  /** Sube (o reemplaza) la foto de un producto y devuelve su URL pública https. */
  subir(productoId: string, imagen: Buffer, tipo: string): Promise<string>;
  /** Borra la foto del producto. */
  borrar(productoId: string): Promise<void>;
}

/** La foto más grande que se acepta (las de un celular moderno pesan 3 a 6 MB). */
export const MAX_FOTO_BYTES = 12 * 1024 * 1024;
export const TIPOS_FOTO = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

/** Reconoce el formato por los primeros bytes, sin confiar solo en el Content-Type. */
export function esImagen(b: Buffer): boolean {
  if (b.length < 12) return false;
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';
  const heic = b.subarray(4, 8).toString('ascii') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(b.subarray(8, 12).toString('ascii'));
  return jpeg || png || webp || heic;
}

type Credenciales = { nube: string; clave: string; secreto: string };

function leerUrl(url: string): Credenciales {
  const u = new URL(url);
  return { clave: decodeURIComponent(u.username), secreto: decodeURIComponent(u.password), nube: u.hostname };
}

/** Firma de Cloudinary: parámetros ordenados "a=1&b=2" + secreto, en SHA-1. */
export function firmar(params: Record<string, string>, secreto: string) {
  const texto = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(texto + secreto).digest('hex');
}

export function crearAlmacenCloudinary(url: string, carpeta = 'provision'): AlmacenFotos {
  const c = leerUrl(url);
  const base = `https://api.cloudinary.com/v1_1/${c.nube}/image`;
  const idPublico = (productoId: string) => `${carpeta}/productos/${productoId}`;

  async function llamar(accion: 'upload' | 'destroy', params: Record<string, string>, archivo?: Blob) {
    const firmados = { ...params, timestamp: String(Math.floor(Date.now() / 1000)) };
    const form = new FormData();
    for (const [k, v] of Object.entries(firmados)) form.set(k, v);
    form.set('api_key', c.clave);
    form.set('signature', firmar(firmados, c.secreto));
    if (archivo) form.set('file', archivo);
    const r = await fetch(`${base}/${accion}`, { method: 'POST', body: form });
    const datos = (await r.json().catch(() => ({}))) as { secure_url?: string; error?: { message?: string } };
    if (!r.ok) throw new Error(`Cloudinary: ${datos.error?.message ?? r.status}`);
    return datos;
  }

  return {
    async subir(productoId, imagen, tipo) {
      const r = await llamar(
        'upload',
        {
          public_id: idPublico(productoId),
          overwrite: 'true',
          invalidate: 'true',
          // Se guarda a lo sumo en 1600 px: suficiente para la tienda y mucho más liviana.
          transformation: 'c_limit,w_1600,h_1600',
        },
        new Blob([new Uint8Array(imagen)], { type: tipo }),
      );
      if (!r.secure_url) throw new Error('Cloudinary no devolvió la URL de la foto');
      return r.secure_url;
    },
    async borrar(productoId) {
      await llamar('destroy', { public_id: idPublico(productoId), invalidate: 'true' });
    },
  };
}

/** El almacén configurado, o null si falta CLOUDINARY_URL. */
export function almacenDesdeEntorno(): AlmacenFotos | null {
  if (!env.CLOUDINARY_URL) return null;
  return crearAlmacenCloudinary(env.CLOUDINARY_URL, env.APP_ENV === 'desarrollo' ? 'provision-dev' : `provision-${env.APP_ENV}`);
}

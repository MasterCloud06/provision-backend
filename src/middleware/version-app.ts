import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { leerCliente, type Versiones } from '../lib/versiones.js';

/**
 * Actualización obligatoria: si la app (escritorio o Android) dice ser una compilación anterior
 * a la última publicada, la petición se rechaza con 426 y la app muestra la pantalla para actualizar.
 * Las compilaciones 0 (las de desarrollo, en la PC de quien programa) nunca se bloquean.
 */
export function exigirVersion(versiones: Versiones): RequestHandler {
  return (req, res, next) => {
    if (!env.ACTUALIZACION_OBLIGATORIA) return next();
    const cliente = leerCliente(req.header('x-provision-app'));
    if (!cliente || cliente.compilacion === 0) return next();
    const ultima = versiones.conocida(cliente.plataforma);
    if (!ultima || cliente.compilacion >= ultima.compilacion) return next();
    res.status(426).json({
      error: {
        codigo: 'ACTUALIZACION_REQUERIDA',
        mensaje: 'Hay una versión nueva de Provisión. Actualiza la app para seguir trabajando.',
        detalles: { plataforma: cliente.plataforma, actual: cliente.compilacion, ultima },
      },
    });
  };
}

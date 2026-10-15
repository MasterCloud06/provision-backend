import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

/** Errores de Postgres que vale la pena traducir a algo entendible. */
function traducirPg(err: unknown): AppError | null {
  const e = (err as { cause?: unknown })?.cause ?? err;
  const code = (e as { code?: string })?.code;
  const constraint = (e as { constraint?: string })?.constraint;
  switch (code) {
    case '23505':
      return new AppError(409, 'DUPLICADO', 'Ya existe un registro con esos datos', { constraint });
    case '23503':
      return new AppError(422, 'REFERENCIA_INVALIDA', 'Hace referencia a un registro que no existe', {
        constraint,
      });
    case '23514':
      return new AppError(422, 'REGLA_NEGOCIO', 'Los datos violan una regla del sistema', { constraint });
    default:
      return null;
  }
}

export const noEncontradoRuta: RequestHandler = (req, res) => {
  res.status(404).json({ error: { codigo: 'RUTA_NO_ENCONTRADA', mensaje: `${req.method} ${req.path}` } });
};

export const manejadorErrores: ErrorRequestHandler = (err, _req, res, _next) => {
  const appErr = err instanceof AppError ? err : traducirPg(err);
  if (appErr) {
    res.status(appErr.status).json({
      error: { codigo: appErr.codigo, mensaje: appErr.message, detalles: appErr.detalles },
    });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { codigo: 'JSON_INVALIDO', mensaje: 'El cuerpo no es JSON válido' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { codigo: 'ERROR_INTERNO', mensaje: 'Error inesperado' } });
};

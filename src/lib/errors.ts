export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    message: string,
    public readonly detalles?: unknown,
  ) {
    super(message);
  }
}

export const noEncontrado = (que: string) => new AppError(404, 'NO_ENCONTRADO', `${que} no encontrado`);
export const conflicto = (msg: string, detalles?: unknown) => new AppError(409, 'CONFLICTO', msg, detalles);
export const reglaNegocio = (msg: string, detalles?: unknown) =>
  new AppError(422, 'REGLA_NEGOCIO', msg, detalles);
export const noAutorizado = (msg = 'No autenticado') => new AppError(401, 'NO_AUTENTICADO', msg);
export const prohibido = (msg = 'No tienes permiso para esta acción') => new AppError(403, 'PROHIBIDO', msg);

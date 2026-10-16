import type { RequestHandler } from 'express';
import type { DB } from '../db/client.js';
import { eventos } from '../db/schema/index.js';

type Resultado = (typeof eventos.$inferInsert)['resultado'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cuerpo = any;

const bs = (c: unknown) =>
  typeof c === 'number' ? `Bs ${(c / 100).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';

/**
 * Cómo se describe cada acción. La clave es "MÉTODO /ruta" con los ids reemplazados por ":id".
 * `titulo` se usa cuando la acción no llegó a hacerse (negada o rechazada);
 * `detalle` arma una frase con la respuesta cuando salió bien.
 */
const REGLAS: Record<string, { modulo: string; titulo: string; detalle?: (r: Cuerpo, b: Cuerpo) => string }> = {
  'POST /auth/login': { modulo: 'acceso', titulo: 'Iniciar sesión', detalle: () => 'Inició sesión' },
  'POST /auth/cambiar-password': { modulo: 'acceso', titulo: 'Cambiar contraseña', detalle: () => 'Cambió su contraseña' },

  'POST /usuarios': { modulo: 'usuarios', titulo: 'Crear usuario', detalle: (r) => `Creó al usuario ${r.email} (${r.nombreRol ?? r.rol})` },
  'PATCH /usuarios/:id': {
    modulo: 'usuarios',
    titulo: 'Modificar usuario',
    detalle: (r, b) =>
      `Modificó al usuario ${r.email}` +
      (b.rol ? ` · rol ${r.rol}` : '') +
      (b.activo === false ? ' · desactivado' : b.activo === true ? ' · activo' : '') +
      (b.password ? ' · contraseña restablecida' : ''),
  },
  'POST /sucursales': { modulo: 'sucursales', titulo: 'Crear sucursal', detalle: (r) => `Creó la sucursal ${r.nombre}` },
  'PATCH /sucursales/:id': { modulo: 'sucursales', titulo: 'Modificar sucursal', detalle: (r) => `Modificó la sucursal ${r.nombre}` },

  'POST /catalogo/productos': { modulo: 'catalogo', titulo: 'Crear producto', detalle: (r) => `Creó el producto ${r.nombre} (${r.sku})` },
  'PATCH /catalogo/productos/:id': {
    modulo: 'catalogo',
    titulo: 'Editar producto',
    detalle: (r, b) => (b.activo === true && Object.keys(b).length === 1 ? `Reactivó ${r.nombre}` : `Editó el producto ${r.nombre}`),
  },
  'PUT /catalogo/productos/:id/foto': { modulo: 'catalogo', titulo: 'Subir foto de producto', detalle: (r) => `Cambió la foto de ${r.nombre}` },
  'DELETE /catalogo/productos/:id/foto': { modulo: 'catalogo', titulo: 'Quitar foto de producto', detalle: (r) => `Quitó la foto de ${r.nombre}` },
  'DELETE /catalogo/productos/:id': { modulo: 'catalogo', titulo: 'Eliminar producto', detalle: (r) => r.mensaje },
  'POST /catalogo/marcas': { modulo: 'catalogo', titulo: 'Crear marca', detalle: (r) => `Creó la marca ${r.nombre}` },
  'PATCH /catalogo/marcas/:id': { modulo: 'catalogo', titulo: 'Editar marca', detalle: (r) => `Editó la marca ${r.nombre}` },
  'POST /catalogo/proveedores': { modulo: 'catalogo', titulo: 'Crear proveedor', detalle: (r) => `Creó el proveedor ${r.nombre}` },
  'PATCH /catalogo/proveedores/:id': { modulo: 'catalogo', titulo: 'Editar proveedor', detalle: (r) => `Editó el proveedor ${r.nombre}` },

  'POST /inventario/entradas': {
    modulo: 'inventario',
    titulo: 'Recibir mercadería',
    detalle: (r) => `Recibió mercadería (${r.movimientos?.length ?? 0} productos)`,
  },
  'POST /inventario/salidas': { modulo: 'inventario', titulo: 'Registrar baja', detalle: (_r, b) => `Registró una baja: ${b.motivo}` },
  'POST /inventario/ajustes': { modulo: 'inventario', titulo: 'Ajustar inventario', detalle: (r) => `Ajustó inventario (${r.ajustados} productos)` },
  'POST /inventario/transferencias': {
    modulo: 'inventario',
    titulo: 'Transferir entre sucursales',
    detalle: (r) => `Transfirió mercadería entre sucursales (${(r.movimientos?.length ?? 0) / 2} productos)`,
  },
  'PATCH /inventario/ubicacion/:id': { modulo: 'inventario', titulo: 'Cambiar ubicación', detalle: () => 'Cambió la ubicación de un producto' },

  'POST /clientes': { modulo: 'clientes', titulo: 'Registrar cliente', detalle: (r) => `Registró al cliente ${r.nombre}` },
  'PATCH /clientes/:id': { modulo: 'clientes', titulo: 'Editar cliente', detalle: (r) => `Editó al cliente ${r.nombre}` },
  'POST /clientes/:id/recetas': { modulo: 'clientes', titulo: 'Registrar receta', detalle: () => 'Registró una receta' },
  'PATCH /clientes/:id/recetas/:id': { modulo: 'clientes', titulo: 'Editar receta', detalle: () => 'Editó una receta' },

  'POST /caja/abrir': { modulo: 'caja', titulo: 'Abrir caja', detalle: (r) => `Abrió caja con ${bs(r.montoApertura)}` },
  'POST /caja/cerrar': {
    modulo: 'caja',
    titulo: 'Cerrar caja',
    detalle: (r) => {
      const d = r.sesion?.diferencia ?? 0;
      return `Cerró caja: contó ${bs(r.sesion?.efectivoContado)}` + (d === 0 ? ', cuadra exacto' : d < 0 ? `, faltante ${bs(-d)}` : `, sobrante ${bs(d)}`);
    },
  },
  'POST /caja/movimientos': {
    modulo: 'caja',
    titulo: 'Movimiento de caja',
    detalle: (r, b) =>
      ({ GASTO: 'Gasto', DEPOSITO: 'Depósito', RETIRO_DUENO: 'Retiro del dueño', OTRO: 'Movimiento' } as Record<string, string>)[b.concepto] +
      ` de ${bs(r.movimiento?.monto)}: ${b.descripcion}`,
  },

  'POST /ventas': {
    modulo: 'ventas',
    titulo: 'Registrar venta',
    detalle: (r) => `Registró la venta ${r.numero} por ${bs(r.total)}` + (r.saldo > 0 ? ` (saldo ${bs(r.saldo)})` : ''),
  },
  'POST /ventas/:id/pagos': {
    modulo: 'ventas',
    titulo: 'Cobrar venta',
    detalle: (r) => `Cobró ${bs(r.pagos?.reduce((a: number, p: Cuerpo) => a + p.monto, 0))} de la venta ${r.venta?.numero}`,
  },
  'POST /ventas/:id/anular': {
    modulo: 'ventas',
    titulo: 'Anular venta',
    detalle: (r, b) => `Anuló la venta ${r.venta?.numero}: ${b.motivo}`,
  },

  'POST /citas': { modulo: 'citas', titulo: 'Reservar cita', detalle: (r) => `Reservó una cita para ${r.nombreContacto} el ${r.fecha} a las ${r.hora}` },
  'POST /citas/:id/estado': {
    modulo: 'citas',
    titulo: 'Cambiar estado de cita',
    detalle: (r) => `Cita de ${r.nombreContacto} (${r.fecha} ${r.hora}) → ${r.estado}`,
  },
  'POST /pedidos-web/:id/estado': {
    modulo: 'tienda',
    titulo: 'Atender pedido web',
    detalle: (r) => `Pedido web ${r.numero} → ${r.estado}`,
  },
  'POST /pedidos-web/:id/cancelar': {
    modulo: 'tienda',
    titulo: 'Cancelar pedido web',
    detalle: (r) => `Canceló el pedido web ${r.numero} (${bs(r.total)}): ${r.canceladoMotivo ?? ''}`,
  },
  'POST /pedidos-web/:id/notas': { modulo: 'tienda', titulo: 'Notas de pedido web', detalle: (r) => `Anotó en el pedido web ${r.numero}` },

  'PATCH /ordenes-trabajo/:id': { modulo: 'laboratorio', titulo: 'Editar orden', detalle: (r) => `Editó la orden ${r.numero}` },
  'POST /ordenes-trabajo/:id/estado': {
    modulo: 'laboratorio',
    titulo: 'Cambiar estado de orden',
    detalle: (r) => `Orden ${r.numero} → ${r.estado}`,
  },
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function normalizar(url: string) {
  const ruta = url.split('?')[0]!.replace(/^\/api\/v1/, '').replace(/\/$/, '') || '/';
  return {
    ruta: ruta.split('/').map((s) => (UUID.test(s) ? ':id' : s)).join('/'),
    entidadId: ruta.match(UUID)?.[0] ?? null,
  };
}

function resultadoDe(status: number, ruta: string): Resultado | null {
  if (status < 400) return 'EXITO';
  if (status === 403) return 'DENEGADO';
  if ((status === 401 || status === 429) && ruta === '/auth/login') return 'FALLIDO';
  if (status === 409 || status === 422) return 'RECHAZADO';
  if (status >= 500) return 'ERROR';
  return null; // 400 de validación, 404: ruido, no se registran
}

/**
 * Registra en `eventos` toda operación que modifica datos (POST, PATCH, PUT, DELETE),
 * salga bien o no. Las finanzas personales no se registran: son privadas de cada usuario.
 * El registro se escribe antes de responder, así el historial nunca queda atrás de lo que el usuario vio.
 */
export function auditoria(db: DB): RequestHandler {
  return (req, res, next) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
    const { ruta, entidadId } = normalizar(req.originalUrl);
    // Finanzas personales: privadas. Tienda: acciones de clientes, no del personal.
    if (ruta.startsWith('/finanzas') || ruta.startsWith('/tienda')) return next();

    const clave = `${req.method} ${ruta}`;
    const regla = REGLAS[clave] ?? { modulo: ruta.split('/')[1] ?? 'otro', titulo: clave };
    // Del cuerpo solo se usan campos inofensivos para la descripción; nunca se guarda.
    const enviado: Cuerpo = { ...(req.body ?? {}) };
    delete enviado.password;
    delete enviado.actual;
    delete enviado.nueva;

    let registrado = false;
    const registrar = async (respuesta: Cuerpo) => {
      if (registrado) return;
      registrado = true;
      const resultado = resultadoDe(res.statusCode, ruta);
      if (!resultado) return;
      try {
        // En el login todavía no hay req.usuario: se toma de la respuesta (o del email intentado).
        const u = req.usuario ?? (ruta === '/auth/login' ? respuesta?.usuario : undefined);
        let descripcion: string;
        if (resultado === 'EXITO') {
          descripcion = regla.detalle?.(respuesta ?? {}, enviado) ?? regla.titulo;
        } else if (resultado === 'FALLIDO') {
          descripcion =
            res.statusCode === 429
              ? `Ingreso bloqueado por demasiados intentos con ${String(enviado.email ?? '').slice(0, 120)}`
              : `Intento de ingreso fallido con ${String(enviado.email ?? '').slice(0, 120)}`;
        } else {
          descripcion = `${regla.titulo}: ${respuesta?.error?.mensaje ?? `error ${res.statusCode}`}`;
        }
        await db.insert(eventos).values({
          usuarioId: u?.id ?? null,
          usuarioNombre: u?.nombre ?? null,
          rol: u?.rol ?? null,
          sucursalId: u?.sucursalId ?? null,
          modulo: regla.modulo,
          accion: clave,
          descripcion: descripcion.slice(0, 1000),
          resultado,
          entidadId: entidadId ?? (typeof respuesta?.id === 'string' && UUID.test(respuesta.id) ? respuesta.id : null),
          metodo: req.method,
          ruta,
          ip: (req.ip ?? '').slice(0, 64) || null,
        });
      } catch (err) {
        console.error('[auditoria] no se pudo registrar el evento', err);
      }
    };

    const json = res.json.bind(res);
    res.json = ((cuerpo: Cuerpo) => {
      void registrar(cuerpo).then(() => json(cuerpo));
      return res;
    }) as typeof res.json;

    const end = res.end.bind(res) as (...a: unknown[]) => typeof res;
    res.end = ((...args: unknown[]) => {
      if (registrado) return end(...args);
      void registrar(undefined).then(() => end(...args));
      return res;
    }) as typeof res.end;

    next();
  };
}

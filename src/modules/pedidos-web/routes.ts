import { and, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { clientes, cuentasTienda, estadoPedidoWeb, pedidosWeb } from '../../db/schema/index.js';
import { conflicto, noEncontrado, reglaNegocio } from '../../lib/errors.js';
import { body, offset, paginacion, param, query, usuarioDe } from '../../lib/http.js';
import type { PasarelaPagos } from '../../lib/pagos.js';
import { requierePermiso } from '../../middleware/auth.js';
import { cancelarPedido, conteoItems, liberarVencidos, pedidoConItems, type EstadoPedido } from '../tienda/servicio.js';

/** Activos: los que el personal todavía tiene que atender. */
export const ESTADOS_POR_ATENDER: EstadoPedido[] = ['PAGADO', 'PREPARANDO', 'LISTO', 'ENVIADO'];

type Pedido = typeof pedidosWeb.$inferSelect;

/** A qué estados puede pasar un pedido (cancelar va por su propia ruta). */
function siguientes(p: Pedido): EstadoPedido[] {
  const final = p.entrega === 'RETIRO' ? 'LISTO' : 'ENVIADO';
  switch (p.estado) {
    // Pago al retirar: se prepara aunque no esté pagado; se cobra al entregar.
    case 'PENDIENTE_PAGO':
      return p.metodoPago === 'EN_TIENDA' ? ['PREPARANDO', 'LISTO'] : [];
    case 'PAGADO':
      return ['PREPARANDO', final];
    case 'PREPARANDO':
      return [final];
    case 'LISTO':
    case 'ENVIADO':
      return ['ENTREGADO'];
    default:
      return [];
  }
}

const NOMBRE_ESTADO: Record<EstadoPedido, string> = {
  PENDIENTE_PAGO: 'pendiente de pago',
  PAGADO: 'pagado',
  PREPARANDO: 'en preparación',
  LISTO: 'listo para retirar',
  ENVIADO: 'enviado',
  ENTREGADO: 'entregado',
  CANCELADO: 'cancelado',
};

/** Pedidos de la tienda web, para el personal. */
export function rutasPedidosWeb(db: DB, pasarela: PasarelaPagos | null) {
  const r = Router();
  r.use(requierePermiso('tienda.gestionar'));

  r.get('/', async (req, res) => {
    const f = query(
      req,
      paginacion.extend({
        estado: z.enum([...estadoPedidoWeb.enumValues, 'POR_ATENDER']).optional(),
        q: z.string().trim().max(100).optional(),
      }),
    );
    // De paso, libera los pedidos sin pagar que ya vencieron (el stock vuelve a la venta).
    await liberarVencidos(db, pasarela);
    const filtros: (SQL | undefined)[] = [
      f.estado === 'POR_ATENDER'
        ? or(inArray(pedidosWeb.estado, ESTADOS_POR_ATENDER), and(eq(pedidosWeb.estado, 'PENDIENTE_PAGO'), eq(pedidosWeb.metodoPago, 'EN_TIENDA')))
        : f.estado
          ? eq(pedidosWeb.estado, f.estado)
          : undefined,
      f.q ? or(ilike(pedidosWeb.numero, `%${f.q}%`), ilike(pedidosWeb.nombreContacto, `%${f.q}%`), ilike(cuentasTienda.email, `%${f.q}%`)) : undefined,
    ];
    const where = and(...filtros);
    const [datos, [conteo]] = await Promise.all([
      db
        .select({
          id: pedidosWeb.id,
          numero: pedidosWeb.numero,
          estado: pedidosWeb.estado,
          metodoPago: pedidosWeb.metodoPago,
          entrega: pedidosWeb.entrega,
          nombreContacto: pedidosWeb.nombreContacto,
          telefono: pedidosWeb.telefono,
          email: cuentasTienda.email,
          total: pedidosWeb.total,
          pagadoEn: pedidosWeb.pagadoEn,
          expiraEn: pedidosWeb.expiraEn,
          creadoEn: pedidosWeb.creadoEn,
        })
        .from(pedidosWeb)
        .innerJoin(cuentasTienda, eq(cuentasTienda.id, pedidosWeb.cuentaId))
        .where(where)
        .orderBy(desc(pedidosWeb.creadoEn))
        .limit(f.porPagina)
        .offset(offset(f)),
      db.select({ total: count() }).from(pedidosWeb).innerJoin(cuentasTienda, eq(cuentasTienda.id, pedidosWeb.cuentaId)).where(where),
    ]);
    const n = await conteoItems(db, datos.map((p) => p.id));
    res.json({ datos: datos.map((p) => ({ ...p, unidades: n.get(p.id) ?? 0 })), total: conteo!.total, pagina: f.pagina, porPagina: f.porPagina });
  });

  r.get('/:id', async (req, res) => {
    const p = await pedidoConItems(db, param(req));
    if (!p) throw noEncontrado('Pedido');
    const [cliente] = await db
      .select({ id: clientes.id, nombre: clientes.nombre, email: cuentasTienda.email, telefono: clientes.telefono, ci: clientes.ci, nit: clientes.nit })
      .from(clientes)
      .innerJoin(cuentasTienda, eq(cuentasTienda.clienteId, clientes.id))
      .where(eq(cuentasTienda.id, p.cuentaId));
    res.json({ ...p, cliente, siguientes: siguientes(p) });
  });

  /** Avanza el pedido: preparando → listo / enviado → entregado. */
  r.post('/:id/estado', async (req, res) => {
    const u = usuarioDe(req);
    const d = body(req, z.object({ estado: z.enum(estadoPedidoWeb.enumValues), nota: z.string().trim().max(500).optional() }));
    const actualizado = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(pedidosWeb).where(eq(pedidosWeb.id, param(req))).for('update');
      if (!p) throw noEncontrado('Pedido');
      if (d.estado === 'CANCELADO') throw reglaNegocio('Para cancelar usa la opción Cancelar pedido');
      const permitidos = siguientes(p);
      if (!permitidos.includes(d.estado)) {
        throw conflicto(
          `Un pedido ${NOMBRE_ESTADO[p.estado]} no puede pasar a ${NOMBRE_ESTADO[d.estado]}` +
            (permitidos.length ? ` (puede pasar a: ${permitidos.map((e) => NOMBRE_ESTADO[e]).join(', ')})` : ''),
        );
      }
      const [fila] = await tx
        .update(pedidosWeb)
        .set({
          estado: d.estado,
          atendidoPor: u.id,
          // Pago al retirar: ya no vence una vez que el personal lo toma; se cobra al entregar.
          expiraEn: null,
          ...(d.estado === 'ENTREGADO' && !p.pagadoEn ? { pagadoEn: new Date() } : {}),
          ...(d.nota ? { notasInternas: [p.notasInternas, `${u.nombre}: ${d.nota}`].filter(Boolean).join('\n') } : {}),
        })
        .where(eq(pedidosWeb.id, p.id))
        .returning();
      return fila!;
    });
    res.json(actualizado);
  });

  /** Cancela: devuelve el stock y, si se pagó con tarjeta, reembolsa en Stripe. */
  r.post('/:id/cancelar', async (req, res) => {
    const u = usuarioDe(req);
    const d = body(req, z.object({ motivo: z.string().trim().min(3).max(300) }));
    res.json(await cancelarPedido(db, pasarela, param(req), d.motivo, u.id));
  });

  r.post('/:id/notas', async (req, res) => {
    const d = body(req, z.object({ notasInternas: z.string().trim().max(2000) }));
    const [p] = await db.update(pedidosWeb).set({ notasInternas: d.notasInternas || null }).where(eq(pedidosWeb.id, param(req))).returning();
    if (!p) throw noEncontrado('Pedido');
    res.json(p);
  });

  return r;
}

import { and, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { clientes, cuentasTienda, estadoPedidoWeb, pedidosWeb } from '../../db/schema/index.js';
import { conflicto, noEncontrado, reglaNegocio } from '../../lib/errors.js';
import { body, offset, paginacion, param, query, usuarioDe } from '../../lib/http.js';
import type { PasarelaPagos } from '../../lib/pagos.js';
import { requierePermiso } from '../../middleware/auth.js';
import { cancelarPedido, conteoItems, liberarVencidos, pedidoConItems, registrarVentaDePedido, type EstadoPedido } from '../tienda/servicio.js';
import { metodoPago, ventas } from '../../db/schema/index.js';
import { centavosPositivo, puede } from '../../lib/http.js';
import { prohibido } from '../../lib/errors.js';

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
    // Cuántos hay en cada estado, para las pestañas de las apps.
    const porEstado = await db.select({ estado: pedidosWeb.estado, n: count() }).from(pedidosWeb).groupBy(pedidosWeb.estado);
    const conteos = Object.fromEntries(porEstado.map((e) => [e.estado, e.n]));
    const [porAtender] = await db
      .select({ n: count() })
      .from(pedidosWeb)
      .where(or(inArray(pedidosWeb.estado, ESTADOS_POR_ATENDER), and(eq(pedidosWeb.estado, 'PENDIENTE_PAGO'), eq(pedidosWeb.metodoPago, 'EN_TIENDA'))));
    res.json({
      datos: datos.map((p) => ({ ...p, unidades: n.get(p.id) ?? 0 })),
      total: conteo!.total,
      pagina: f.pagina,
      porPagina: f.porPagina,
      conteos: { ...conteos, POR_ATENDER: porAtender!.n },
    });
  });

  r.get('/:id', async (req, res) => {
    const p = await pedidoConItems(db, param(req));
    if (!p) throw noEncontrado('Pedido');
    const [cliente] = await db
      .select({ id: clientes.id, nombre: clientes.nombre, email: cuentasTienda.email, telefono: clientes.telefono, ci: clientes.ci, nit: clientes.nit })
      .from(clientes)
      .innerJoin(cuentasTienda, eq(cuentasTienda.clienteId, clientes.id))
      .where(eq(cuentasTienda.id, p.cuentaId));
    const [venta] = p.ventaId ? await db.select({ numero: ventas.numero }).from(ventas).where(eq(ventas.id, p.ventaId)) : [];
    res.json({
      ...p,
      cliente,
      siguientes: siguientes(p),
      ventaNumero: venta?.numero ?? null,
      // Al entregar un pedido con pago al retirar hay que cobrarlo en caja.
      cobrarAlEntregar: p.metodoPago === 'EN_TIENDA' && !p.pagadoEn,
    });
  });

  /** Avanza el pedido: preparando → listo / enviado → entregado. */
  r.post('/:id/estado', async (req, res) => {
    const u = usuarioDe(req);
    const d = body(
      req,
      z.object({
        estado: z.enum(estadoPedidoWeb.enumValues),
        nota: z.string().trim().max(500).optional(),
        /** Al entregar un pedido con pago al retirar: cómo pagó el cliente (pueden ser varios métodos). */
        pagos: z
          .array(z.object({ metodo: z.enum(metodoPago.enumValues), monto: centavosPositivo, referencia: z.string().trim().max(80).nullish() }))
          .max(4)
          .optional(),
      }),
    );
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
      // Entregar: se registra la venta (reportes) y, si paga al retirar, se cobra en la caja abierta.
      let ventaId = p.ventaId;
      if (d.estado === 'ENTREGADO' && !ventaId) {
        const cobra = p.metodoPago === 'EN_TIENDA' && !p.pagadoEn;
        if (cobra && !puede(req, 'caja.operar')) throw prohibido('Este pedido se paga al retirar: lo entrega quien opera la caja');
        if (cobra && !d.pagos?.length) throw reglaNegocio('Indica cómo pagó el cliente para cobrar el pedido en caja');
        ventaId = (await registrarVentaDePedido(tx, p, u, cobra ? d.pagos! : null)).id;
      }
      const [fila] = await tx
        .update(pedidosWeb)
        .set({
          estado: d.estado,
          atendidoPor: u.id,
          ventaId,
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

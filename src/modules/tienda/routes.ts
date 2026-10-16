import { and, asc, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import express, { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { DB } from '../../db/client.js';
import { carritoItems, citas, marcas, motivoCita, pedidosWeb, productos, tipoProducto } from '../../db/schema/index.js';
import { citasActivasDeCuenta, disponibilidad, MOTIVOS, reservar } from '../citas/servicio.js';
import { AppError, noEncontrado, reglaNegocio } from '../../lib/errors.js';
import { body, boolQuery, offset, param, query } from '../../lib/http.js';
import type { PasarelaPagos } from '../../lib/pagos.js';
import type { Avisos } from './avisos.js';
import { autenticarCliente, clienteDe, rutasAuthTienda, rutasCuentaTienda } from './auth.js';
import {
  cancelarPedido,
  confirmarPago,
  conteoItems,
  crearPedidoDesdeCarrito,
  disponibleSql,
  pedidoConItems,
  publicado,
  sucursalTienda,
} from './servicio.js';

const tipo = z.enum(tipoProducto.enumValues);

/** Lo que un cliente puede ver de un producto (sin costos, proveedores ni stock mínimo). */
const columnasPublicas = (sucursalId: string) => ({
  id: productos.id,
  nombre: productos.nombre,
  descripcion: productos.descripcion,
  tipo: productos.tipo,
  marcaId: productos.marcaId,
  marca: marcas.nombre,
  modelo: productos.modelo,
  atributos: productos.atributos,
  precio: productos.precioVenta,
  imagenUrl: productos.imagenUrl,
  disponible: disponibleSql(sucursalId).mapWith((v) => (v == null ? null : Number(v))),
  creadoEn: productos.creadoEn,
});

/** Avisa a la pasarela; si Stripe no está configurado responde 503 con un mensaje claro. */
function exigirPasarela(p: PasarelaPagos | null): PasarelaPagos {
  if (!p) throw new AppError(503, 'PAGOS_NO_CONFIGURADOS', 'El pago con tarjeta todavía no está habilitado. Elige pagar al retirar en la tienda.');
  return p;
}

/**
 * Webhook de Stripe. Va antes de express.json(): la firma se calcula sobre el cuerpo crudo.
 * Stripe reintenta si no respondemos 2xx, por eso los errores propios devuelven 500.
 */
export function webhookStripe(db: DB, pasarela: PasarelaPagos | null, avisos: Avisos): RequestHandler[] {
  return [
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      if (!pasarela) {
        res.status(503).json({ error: { codigo: 'PAGOS_NO_CONFIGURADOS', mensaje: 'Stripe no está configurado' } });
        return;
      }
      let evento;
      try {
        evento = pasarela.leerWebhook(req.body as Buffer, String(req.headers['stripe-signature'] ?? ''));
      } catch (err) {
        res.status(400).json({ error: { codigo: 'FIRMA_INVALIDA', mensaje: (err as Error).message } });
        return;
      }
      if (evento.tipo === 'pagado') {
        await confirmarPago(db, evento.sesion, avisos);
      } else if (evento.tipo === 'vencido' && evento.sesion.pedidoId) {
        const [p] = await db.select().from(pedidosWeb).where(eq(pedidosWeb.id, evento.sesion.pedidoId));
        // Solo si es la sesión vigente del pedido (un "reintentar pago" crea otra).
        if (p?.estado === 'PENDIENTE_PAGO' && p.stripeSessionId === evento.sesion.id) {
          await cancelarPedido(db, pasarela, p.id, 'No se completó el pago a tiempo', null, avisos);
        }
      }
      res.json({ recibido: true });
    },
  ];
}

export function rutasTienda(db: DB, pasarela: PasarelaPagos | null, avisos: Avisos) {
  const r = Router();

  // Frena ataques de fuerza bruta sobre contraseñas y registros masivos.
  const limite = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => env.APP_ENV === 'test',
    handler: (_req, res) =>
      void res.status(429).json({ error: { codigo: 'DEMASIADOS_INTENTOS', mensaje: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' } }),
  });
  r.use('/auth', limite, rutasAuthTienda(db, avisos));

  /* ───────────── Catálogo público ───────────── */

  /** Datos generales para armar la tienda: sucursal, envío, si hay pago en línea, categorías y marcas. */
  r.get('/info', async (_req, res) => {
    const s = await sucursalTienda(db);
    const [categorias, listaMarcas] = await Promise.all([
      db.select({ tipo: productos.tipo, cantidad: count() }).from(productos).where(publicado).groupBy(productos.tipo),
      db
        .select({ id: marcas.id, nombre: marcas.nombre, cantidad: count() })
        .from(marcas)
        .innerJoin(productos, eq(productos.marcaId, marcas.id))
        .where(and(publicado, eq(marcas.activa, true)))
        .groupBy(marcas.id, marcas.nombre)
        .orderBy(asc(marcas.nombre)),
    ]);
    res.json({
      sucursal: { nombre: s.nombre, direccion: s.direccion, telefono: s.telefono },
      costoEnvio: env.TIENDA_COSTO_ENVIO,
      pagoEnLinea: pasarela != null,
      recuperacionPorCorreo: avisos.habilitado,
      minutosReserva: env.TIENDA_MINUTOS_RESERVA,
      diasRetiro: env.TIENDA_DIAS_RETIRO,
      categorias,
      marcas: listaMarcas,
    });
  });

  /** Búsqueda de productos publicados con filtros y orden. */
  r.get('/productos', async (req, res) => {
    const f = query(
      req,
      z.object({
        q: z.string().trim().max(100).optional(),
        tipo: tipo.optional(),
        marcaId: z.uuid().optional(),
        genero: z.enum(['HOMBRE', 'MUJER', 'NINO', 'UNISEX']).optional(),
        precioMin: z.coerce.number().int().nonnegative().optional(),
        precioMax: z.coerce.number().int().nonnegative().optional(),
        disponibles: boolQuery.optional(),
        orden: z.enum(['nuevos', 'precio_asc', 'precio_desc', 'nombre']).default('nuevos'),
        pagina: z.coerce.number().int().min(1).default(1),
        porPagina: z.coerce.number().int().min(1).max(48).default(24),
      }),
    );
    const s = await sucursalTienda(db);
    const disponible = disponibleSql(s.id);
    const filtros: (SQL | undefined)[] = [
      publicado,
      f.q
        ? or(
            ilike(productos.nombre, `%${f.q}%`),
            ilike(productos.modelo, `%${f.q}%`),
            ilike(productos.descripcion, `%${f.q}%`),
            ilike(marcas.nombre, `%${f.q}%`),
          )
        : undefined,
      f.tipo ? eq(productos.tipo, f.tipo) : undefined,
      f.marcaId ? eq(productos.marcaId, f.marcaId) : undefined,
      f.genero ? sql`${productos.atributos}->>'genero' in (${f.genero}, 'UNISEX')` : undefined,
      f.precioMin != null ? gte(productos.precioVenta, f.precioMin) : undefined,
      f.precioMax != null ? lte(productos.precioVenta, f.precioMax) : undefined,
      f.disponibles ? sql`coalesce(${disponible}, 1) > 0` : undefined,
    ];
    const where = and(...filtros);
    const orden = {
      nuevos: [desc(productos.creadoEn)],
      precio_asc: [asc(productos.precioVenta), asc(productos.nombre)],
      precio_desc: [desc(productos.precioVenta), asc(productos.nombre)],
      nombre: [asc(productos.nombre)],
    }[f.orden];
    const [datos, [conteo]] = await Promise.all([
      db
        .select(columnasPublicas(s.id))
        .from(productos)
        .leftJoin(marcas, eq(marcas.id, productos.marcaId))
        .where(where)
        // Los agotados al final, sin esconderlos.
        .orderBy(sql`case when coalesce(${disponible}, 1) > 0 then 0 else 1 end`, ...orden)
        .limit(f.porPagina)
        .offset(offset(f)),
      db.select({ total: count() }).from(productos).leftJoin(marcas, eq(marcas.id, productos.marcaId)).where(where),
    ]);
    res.json({ datos, total: conteo!.total, pagina: f.pagina, porPagina: f.porPagina });
  });

  r.get('/productos/:id', async (req, res) => {
    const s = await sucursalTienda(db);
    const [p] = await db
      .select(columnasPublicas(s.id))
      .from(productos)
      .leftJoin(marcas, eq(marcas.id, productos.marcaId))
      .where(and(publicado, eq(productos.id, param(req))));
    if (!p) throw noEncontrado('Producto');
    // Sugerencias: del mismo tipo, con stock.
    const relacionados = await db
      .select(columnasPublicas(s.id))
      .from(productos)
      .leftJoin(marcas, eq(marcas.id, productos.marcaId))
      .where(and(publicado, eq(productos.tipo, p.tipo), sql`${productos.id} <> ${p.id}`, sql`coalesce(${disponibleSql(s.id)}, 1) > 0`))
      .orderBy(desc(productos.creadoEn))
      .limit(4);
    res.json({ ...p, relacionados });
  });

  /* ───────────── Con sesión de cliente ───────────── */

  const conSesion = autenticarCliente(db);
  r.use('/cuenta', conSesion, rutasCuentaTienda(db));

  /* Citas (examen de la vista) */

  /** Turnos libres de los próximos días. Público: se puede mirar antes de crear la cuenta. */
  r.get('/citas/disponibilidad', async (req, res) => {
    const f = query(req, z.object({ desde: z.iso.date().optional(), dias: z.coerce.number().int().min(1).max(31).default(14) }));
    const s = await sucursalTienda(db);
    res.json({ dias: await disponibilidad(db, s.id, f.desde, f.dias), duracion: env.CITAS_DURACION, motivos: MOTIVOS });
  });

  const citaPublica = (c: typeof citas.$inferSelect) => ({
    id: c.id,
    fecha: c.fecha,
    hora: c.hora,
    duracion: c.duracion,
    motivo: c.motivo,
    motivoTexto: MOTIVOS[c.motivo],
    estado: c.estado,
    nombreContacto: c.nombreContacto,
    telefono: c.telefono,
    notas: c.notas,
    canceladaMotivo: c.canceladaMotivo,
    creadoEn: c.creadoEn,
  });

  r.get('/citas', conSesion, async (req, res) => {
    const lista = await db.select().from(citas).where(eq(citas.cuentaId, clienteDe(req).cuentaId)).orderBy(desc(citas.fecha), desc(citas.hora)).limit(50);
    res.json(lista.map(citaPublica));
  });

  r.post('/citas', conSesion, async (req, res) => {
    const c = clienteDe(req);
    const d = body(
      req,
      z.object({
        fecha: z.iso.date(),
        hora: z.string().regex(/^\d{2}:\d{2}$/),
        motivo: z.enum(motivoCita.enumValues).default('EXAMEN_VISTA'),
        nombreContacto: z.string().trim().min(2).max(160).optional(),
        telefono: z.string().trim().min(6, 'Escribe tu teléfono o WhatsApp').max(40),
        notas: z.string().trim().max(500).nullish(),
      }),
    );
    if ((await citasActivasDeCuenta(db, c.cuentaId)).length >= 2) {
      throw reglaNegocio('Ya tienes 2 citas por venir. Cancela una para reservar otra.');
    }
    const s = await sucursalTienda(db);
    const cita = await reservar(db, {
      ...d,
      nombreContacto: d.nombreContacto ?? c.nombre,
      sucursalId: s.id,
      clienteId: c.clienteId,
      cuentaId: c.cuentaId,
    });
    void avisos.citaReservada(cita.id);
    res.status(201).json(citaPublica(cita));
  });

  r.post('/citas/:id/cancelar', conSesion, async (req, res) => {
    const c = clienteDe(req);
    const [cita] = await db.select().from(citas).where(and(eq(citas.id, param(req)), eq(citas.cuentaId, c.cuentaId)));
    if (!cita) throw noEncontrado('Cita');
    if (cita.estado !== 'PENDIENTE' && cita.estado !== 'CONFIRMADA') throw reglaNegocio('Esta cita ya no se puede cancelar');
    const [act] = await db.update(citas).set({ estado: 'CANCELADA', canceladaMotivo: 'Cancelada por el cliente' }).where(eq(citas.id, cita.id)).returning();
    res.json(citaPublica(act!));
  });

  /* Carrito */

  async function verCarrito(cuentaId: string) {
    const s = await sucursalTienda(db);
    const items = await db
      .select({
        productoId: carritoItems.productoId,
        cantidad: carritoItems.cantidad,
        nombre: productos.nombre,
        tipo: productos.tipo,
        marca: marcas.nombre,
        precio: productos.precioVenta,
        imagenUrl: productos.imagenUrl,
        disponible: disponibleSql(s.id).mapWith((v) => (v == null ? null : Number(v))),
        aLaVenta: sql<boolean>`${productos.activo} and ${productos.visibleTienda}`,
      })
      .from(carritoItems)
      .innerJoin(productos, eq(productos.id, carritoItems.productoId))
      .leftJoin(marcas, eq(marcas.id, productos.marcaId))
      .where(eq(carritoItems.cuentaId, cuentaId))
      .orderBy(asc(carritoItems.agregadoEn));
    const conDatos = items.map((i) => ({
      ...i,
      subtotal: i.precio * i.cantidad,
      /** Qué impide comprarlo ahora (null = todo bien). */
      problema: !i.aLaVenta
        ? 'Ya no está a la venta'
        : i.disponible != null && i.disponible < i.cantidad
          ? i.disponible === 0
            ? 'Agotado'
            : `Solo quedan ${i.disponible}`
          : null,
    }));
    return {
      items: conDatos,
      unidades: conDatos.reduce((a, i) => a + i.cantidad, 0),
      subtotal: conDatos.reduce((a, i) => a + i.subtotal, 0),
      costoEnvio: env.TIENDA_COSTO_ENVIO,
      listoParaPagar: conDatos.length > 0 && conDatos.every((i) => i.problema == null),
    };
  }

  /** Producto comprable y cuántas unidades hay. */
  async function revisarProducto(productoId: string) {
    const s = await sucursalTienda(db);
    const [p] = await db
      .select({ nombre: productos.nombre, disponible: disponibleSql(s.id).mapWith((v) => (v == null ? null : Number(v))) })
      .from(productos)
      .where(and(publicado, eq(productos.id, productoId)));
    if (!p) throw noEncontrado('Producto');
    return p;
  }

  const cantidad = z.number().int().min(0).max(99);

  r.get('/carrito', conSesion, async (req, res) => {
    res.json(await verCarrito(clienteDe(req).cuentaId));
  });

  /** Fija la cantidad de un producto en el carrito (0 lo quita). */
  r.put('/carrito/:productoId', conSesion, async (req, res) => {
    const c = clienteDe(req);
    const productoId = param(req, 'productoId');
    const d = body(req, z.object({ cantidad }));
    if (d.cantidad === 0) {
      await db.delete(carritoItems).where(and(eq(carritoItems.cuentaId, c.cuentaId), eq(carritoItems.productoId, productoId)));
    } else {
      const p = await revisarProducto(productoId);
      if (p.disponible != null && d.cantidad > p.disponible) {
        throw reglaNegocio(p.disponible === 0 ? `"${p.nombre}" está agotado` : `Solo quedan ${p.disponible} de "${p.nombre}"`, {
          disponible: p.disponible,
        });
      }
      await db
        .insert(carritoItems)
        .values({ cuentaId: c.cuentaId, productoId, cantidad: d.cantidad })
        .onConflictDoUpdate({ target: [carritoItems.cuentaId, carritoItems.productoId], set: { cantidad: d.cantidad } });
    }
    res.json(await verCarrito(c.cuentaId));
  });

  r.delete('/carrito/:productoId', conSesion, async (req, res) => {
    const c = clienteDe(req);
    await db.delete(carritoItems).where(and(eq(carritoItems.cuentaId, c.cuentaId), eq(carritoItems.productoId, param(req, 'productoId'))));
    res.json(await verCarrito(c.cuentaId));
  });

  r.delete('/carrito', conSesion, async (req, res) => {
    const c = clienteDe(req);
    await db.delete(carritoItems).where(eq(carritoItems.cuentaId, c.cuentaId));
    res.json(await verCarrito(c.cuentaId));
  });

  /**
   * Junta el carrito que el visitante armó sin sesión con el de su cuenta, al ingresar.
   * Suma cantidades sin pasar lo disponible; ignora lo que ya no está a la venta.
   */
  r.post('/carrito/fusionar', conSesion, async (req, res) => {
    const c = clienteDe(req);
    const d = body(req, z.object({ items: z.array(z.object({ productoId: z.uuid(), cantidad: cantidad.min(1) })).max(50) }));
    const actuales = new Map(
      (await db.select().from(carritoItems).where(eq(carritoItems.cuentaId, c.cuentaId))).map((i) => [i.productoId, i.cantidad]),
    );
    for (const item of d.items) {
      let p;
      try {
        p = await revisarProducto(item.productoId);
      } catch {
        continue;
      }
      let total = Math.min(99, (actuales.get(item.productoId) ?? 0) + item.cantidad);
      if (p.disponible != null) total = Math.min(total, p.disponible);
      if (total <= 0) continue;
      await db
        .insert(carritoItems)
        .values({ cuentaId: c.cuentaId, productoId: item.productoId, cantidad: total })
        .onConflictDoUpdate({ target: [carritoItems.cuentaId, carritoItems.productoId], set: { cantidad: total } });
      actuales.set(item.productoId, total);
    }
    res.json(await verCarrito(c.cuentaId));
  });

  /* Pedidos */

  /** Abre (o reabre) el pago en Stripe de un pedido pendiente. */
  async function iniciarPago(pedidoId: string, email: string) {
    const pago = exigirPasarela(pasarela);
    const p = (await pedidoConItems(db, pedidoId))!;
    // Stripe exige al menos 30 minutos de vigencia para la sesión.
    const minimo = Date.now() + 31 * 60_000;
    const maximo = Date.now() + 23 * 60 * 60_000; // y como máximo 24 horas
    const expiraEn = new Date(Math.min(Math.max(p.expiraEn?.getTime() ?? 0, minimo), maximo));
    const sesion = await pago.crearSesion({
      pedidoId: p.id,
      numero: p.numero,
      email,
      items: p.items.map((i) => ({ nombre: i.nombre, precioUnitario: i.precioUnitario, cantidad: i.cantidad, imagenUrl: i.imagenUrl })),
      costoEnvio: p.costoEnvio,
      expiraEn,
      urlExito: `${env.TIENDA_URL}/pedidos/${p.id}?pago=exito`,
      urlCancelar: `${env.TIENDA_URL}/pedidos/${p.id}?pago=cancelado`,
    });
    // La reserva dura unos minutos más que la sesión: así el aviso de Stripe llega antes de liberar.
    await db
      .update(pedidosWeb)
      .set({ stripeSessionId: sesion.id, expiraEn: new Date(expiraEn.getTime() + 5 * 60_000) })
      .where(eq(pedidosWeb.id, p.id));
    return sesion.url;
  }

  /** Pedido de la cuenta en sesión (404 si es de otro cliente). */
  async function miPedido(req: express.Request) {
    const c = clienteDe(req);
    const p = await pedidoConItems(db, param(req));
    if (!p || p.cuentaId !== c.cuentaId) throw noEncontrado('Pedido');
    const { notasInternas: _n, atendidoPor: _a, stripePaymentIntent: _pi, stripeSessionId: _s, cuentaId: _c, clienteId: _cl, ...publico } = p;
    return publico;
  }

  r.get('/pedidos', conSesion, async (req, res) => {
    const c = clienteDe(req);
    const f = query(req, z.object({ pagina: z.coerce.number().int().min(1).default(1), porPagina: z.coerce.number().int().min(1).max(50).default(20) }));
    const lista = await db
      .select({
        id: pedidosWeb.id,
        numero: pedidosWeb.numero,
        estado: pedidosWeb.estado,
        metodoPago: pedidosWeb.metodoPago,
        entrega: pedidosWeb.entrega,
        total: pedidosWeb.total,
        pagadoEn: pedidosWeb.pagadoEn,
        expiraEn: pedidosWeb.expiraEn,
        creadoEn: pedidosWeb.creadoEn,
      })
      .from(pedidosWeb)
      .where(eq(pedidosWeb.cuentaId, c.cuentaId))
      .orderBy(desc(pedidosWeb.creadoEn))
      .limit(f.porPagina)
      .offset(offset(f));
    const n = await conteoItems(db, lista.map((p) => p.id));
    res.json(lista.map((p) => ({ ...p, unidades: n.get(p.id) ?? 0 })));
  });

  /** Confirma la compra: crea el pedido con el carrito y, si es con tarjeta, devuelve la URL de pago de Stripe. */
  r.post('/pedidos', conSesion, async (req, res) => {
    const c = clienteDe(req);
    const d = body(
      req,
      z
        .object({
          entrega: z.enum(['RETIRO', 'ENVIO']),
          metodoPago: z.enum(['STRIPE', 'EN_TIENDA']),
          nombreContacto: z.string().trim().min(2).max(160),
          telefono: z.string().trim().min(6).max(40),
          direccion: z.string().trim().max(400).nullish(),
          ciudad: z.string().trim().max(80).nullish(),
          notas: z.string().trim().max(500).nullish(),
        })
        .refine((v) => v.entrega !== 'ENVIO' || (v.direccion?.length ?? 0) >= 5, {
          path: ['direccion'],
          message: 'Escribe la dirección de envío',
        })
        .refine((v) => v.metodoPago !== 'EN_TIENDA' || v.entrega === 'RETIRO', {
          path: ['metodoPago'],
          message: 'El pago en tienda solo es posible si retiras el pedido',
        }),
    );
    if (d.metodoPago === 'STRIPE') exigirPasarela(pasarela);
    const pedido = await crearPedidoDesdeCarrito(db, { ...d, cuentaId: c.cuentaId, clienteId: c.clienteId });

    let urlPago: string | null = null;
    if (d.metodoPago === 'STRIPE') {
      try {
        urlPago = await iniciarPago(pedido.id, c.email);
      } catch (err) {
        // Si Stripe falla, el pedido no queda colgado: se cancela, el stock vuelve y el carrito se restaura.
        console.error('[tienda] Stripe no pudo crear la sesión', err);
        const items = (await pedidoConItems(db, pedido.id))!.items;
        await cancelarPedido(db, null, pedido.id, 'No se pudo iniciar el pago', null);
        for (const i of items) {
          await db
            .insert(carritoItems)
            .values({ cuentaId: c.cuentaId, productoId: i.productoId, cantidad: i.cantidad })
            .onConflictDoNothing();
        }
        throw new AppError(502, 'PAGO_NO_INICIADO', 'No se pudo abrir el pago con tarjeta. Tu carrito sigue intacto: intenta de nuevo en un momento.');
      }
    }
    // Con tarjeta, el correo sale cuando se confirma el pago.
    if (d.metodoPago === 'EN_TIENDA') void avisos.pedidoRecibido(pedido.id);
    res.status(201).json({ pedido: { id: pedido.id, numero: pedido.numero, estado: pedido.estado, total: pedido.total }, urlPago });
  });

  r.get('/pedidos/:id', conSesion, async (req, res) => {
    res.json(await miPedido(req));
  });

  /** Vuelve a abrir el pago con tarjeta de un pedido que sigue pendiente. */
  r.post('/pedidos/:id/pagar', conSesion, async (req, res) => {
    const p = await miPedido(req);
    if (p.estado !== 'PENDIENTE_PAGO' || p.metodoPago !== 'STRIPE') throw reglaNegocio('Este pedido no tiene un pago pendiente con tarjeta');
    const [fila] = await db.select({ s: pedidosWeb.stripeSessionId }).from(pedidosWeb).where(eq(pedidosWeb.id, p.id));
    const pago = exigirPasarela(pasarela);
    if (fila?.s) {
      const s = await pago.obtenerSesion(fila.s);
      if (s.pagado) {
        await confirmarPago(db, s, avisos);
        throw reglaNegocio('Este pedido ya está pagado');
      }
      if (s.estado === 'open' && s.url) {
        res.json({ urlPago: s.url });
        return;
      }
    }
    res.json({ urlPago: await iniciarPago(p.id, clienteDe(req).email) });
  });

  /**
   * Al volver de Stripe, el navegador pide verificar el pago. Normalmente el webhook ya lo confirmó;
   * si no llegó (p. ej. en local), se consulta directamente a Stripe.
   */
  r.post('/pedidos/:id/verificar', conSesion, async (req, res) => {
    const p = await miPedido(req);
    if (p.estado === 'PENDIENTE_PAGO' && p.metodoPago === 'STRIPE' && pasarela) {
      const [fila] = await db.select({ s: pedidosWeb.stripeSessionId }).from(pedidosWeb).where(eq(pedidosWeb.id, p.id));
      if (fila?.s) await confirmarPago(db, await pasarela.obtenerSesion(fila.s), avisos);
    }
    res.json(await miPedido(req));
  });

  r.post('/pedidos/:id/cancelar', conSesion, async (req, res) => {
    const p = await miPedido(req);
    if (p.estado !== 'PENDIENTE_PAGO') {
      throw reglaNegocio('Solo puedes cancelar pedidos que aún no se pagaron. Para los demás, comunícate con la óptica.');
    }
    await cancelarPedido(db, pasarela, p.id, 'Cancelado por el cliente', null);
    res.json(await miPedido(req));
  });

  return r;
}

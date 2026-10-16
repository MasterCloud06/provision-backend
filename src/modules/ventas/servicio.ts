import { and, eq, inArray } from 'drizzle-orm';
import type { Exec } from '../../db/client.js';
import {
  clientes,
  historialTrabajo,
  ordenesTrabajo,
  pagos,
  productos,
  recetas,
  ventaItems,
  ventas,
} from '../../db/schema/index.js';
import { siguienteNumero } from '../../lib/correlativo.js';
import { noEncontrado, prohibido, reglaNegocio } from '../../lib/errors.js';
import type { UsuarioSesion } from '../../lib/http.js';
import { tienePermiso } from '../../lib/permisos.js';
import { cajaAbierta, registrarMovimientoCaja, resumenSesion } from '../caja/servicio.js';
import { moverStock } from '../inventario/servicio.js';

type Metodo = (typeof pagos.$inferInsert)['metodo'];
type EstadoTrabajo = (typeof ordenesTrabajo.$inferSelect)['estado'];

export type PagoEntrada = { metodo: Metodo; monto: number; referencia?: string | null };

export type NuevaVenta = {
  sucursalId: string;
  clienteId?: string | null;
  recetaId?: string | null;
  items: { productoId: string; cantidad: number; precioUnitario?: number; descuento?: number }[];
  descuento?: number;
  pagos?: PagoEntrada[];
  notas?: string | null;
  /** Datos de la orden de laboratorio. Si hay lentes oftálmicos y no se envía, se crea igual. */
  ordenTrabajo?: { fechaPrometida?: string | null; instrucciones?: string | null; laboratorioExterno?: string | null } | null;
};

const estadoPagoDe = (total: number, pagado: number) =>
  pagado >= total ? ('PAGADA' as const) : pagado > 0 ? ('PARCIAL' as const) : ('PENDIENTE' as const);

/** Registra los pagos en la caja abierta de la sucursal (también lo usan los pedidos web al entregarse). */
export async function cobrar(
  tx: Exec,
  venta: { id: string; numero: string; sucursalId: string },
  lista: PagoEntrada[],
  usuarioId: string,
) {
  const sesion = await cajaAbierta(tx, venta.sucursalId);
  const registrados = [];
  for (const p of lista) {
    const [pago] = await tx
      .insert(pagos)
      .values({ ventaId: venta.id, sesionCajaId: sesion.id, metodo: p.metodo, monto: p.monto, referencia: p.referencia, usuarioId })
      .returning();
    await registrarMovimientoCaja(tx, {
      sesionCajaId: sesion.id,
      tipo: 'INGRESO',
      concepto: 'COBRO_VENTA',
      metodo: p.metodo,
      monto: p.monto,
      descripcion: `Cobro ${venta.numero}`,
      ventaId: venta.id,
      pagoId: pago!.id,
      usuarioId,
    });
    registrados.push(pago!);
  }
  return registrados;
}

export async function crearVenta(tx: Exec, d: NuevaVenta, usuario: UsuarioSesion) {
  // Cliente y receta
  if (d.clienteId) {
    const [c] = await tx.select({ id: clientes.id }).from(clientes).where(eq(clientes.id, d.clienteId));
    if (!c) throw noEncontrado('Cliente');
  }
  if (d.recetaId) {
    const [rec] = await tx.select().from(recetas).where(eq(recetas.id, d.recetaId));
    if (!rec) throw noEncontrado('Receta');
    if (rec.clienteId !== d.clienteId) throw reglaNegocio('La receta no pertenece al cliente de la venta');
  }

  // Productos y cálculo de montos
  const ids = [...new Set(d.items.map((i) => i.productoId))];
  const lista = await tx.select().from(productos).where(inArray(productos.id, ids));
  const porId = new Map(lista.map((p) => [p.id, p]));

  const lineas = d.items.map((it) => {
    const p = porId.get(it.productoId);
    if (!p) throw noEncontrado(`Producto ${it.productoId}`);
    if (!p.activo) throw reglaNegocio(`"${p.nombre}" está inactivo y no se puede vender`);
    const precio = it.precioUnitario ?? p.precioVenta;
    if (precio !== p.precioVenta && !tienePermiso(usuario.rol, 'precios.modificar')) {
      throw prohibido('No puedes cambiar el precio de lista; usa un descuento');
    }
    const bruto = precio * it.cantidad;
    const descuento = it.descuento ?? 0;
    if (descuento > bruto) throw reglaNegocio(`El descuento de "${p.nombre}" supera su importe`);
    return {
      producto: p,
      cantidad: it.cantidad,
      precioUnitario: precio,
      descuento,
      total: bruto - descuento,
    };
  });

  // Quien no opera caja (p. ej. el ejecutivo de ventas) registra la venta y el cobro lo hace caja.
  if (d.pagos?.length && !tienePermiso(usuario.rol, 'caja.operar')) {
    throw prohibido('No puedes cobrar: registra la venta sin pagos y el cajero la cobra');
  }

  const subtotal = lineas.reduce((a, l) => a + l.total, 0);
  const descuento = d.descuento ?? 0;
  if (descuento > subtotal) throw reglaNegocio('El descuento supera el subtotal');
  const total = subtotal - descuento;
  const pagado = (d.pagos ?? []).reduce((a, p) => a + p.monto, 0);
  if (pagado > total) {
    throw reglaNegocio('Los pagos superan el total de la venta (el cambio se calcula fuera)', { total, pagado });
  }
  if (pagado < total && !d.clienteId) {
    throw reglaNegocio(
      tienePermiso(usuario.rol, 'caja.operar')
        ? 'Para dejar saldo pendiente, la venta debe tener un cliente asignado'
        : 'Asigna un cliente a la venta para que caja pueda cobrarla',
    );
  }

  const numero = await siguienteNumero(tx, d.sucursalId, 'V');
  const [venta] = await tx
    .insert(ventas)
    .values({
      numero,
      sucursalId: d.sucursalId,
      clienteId: d.clienteId ?? null,
      vendedorId: usuario.id,
      recetaId: d.recetaId ?? null,
      subtotal,
      descuento,
      total,
      pagado,
      saldo: total - pagado,
      estadoPago: estadoPagoDe(total, pagado),
      notas: d.notas ?? null,
    })
    .returning();

  const items = await tx
    .insert(ventaItems)
    .values(
      lineas.map((l) => ({
        ventaId: venta!.id,
        productoId: l.producto.id,
        descripcion: l.producto.nombre,
        cantidad: l.cantidad,
        precioUnitario: l.precioUnitario,
        descuento: l.descuento,
        total: l.total,
        costoUnitario: l.producto.costoPromedio,
      })),
    )
    .returning();

  for (const l of lineas) {
    await moverStock(tx, {
      productoId: l.producto.id,
      sucursalId: d.sucursalId,
      tipo: 'VENTA',
      cantidad: -l.cantidad,
      motivo: `Venta ${numero}`,
      referenciaTipo: 'VENTA',
      referenciaId: venta!.id,
      usuarioId: usuario.id,
    });
  }

  const pagosRegistrados = d.pagos?.length ? await cobrar(tx, venta!, d.pagos, usuario.id) : [];

  let orden = null;
  const llevaLentes = lineas.some((l) => l.producto.tipo === 'LENTE_OFTALMICO');
  if (d.ordenTrabajo || llevaLentes) {
    [orden] = await tx
      .insert(ordenesTrabajo)
      .values({
        numero: await siguienteNumero(tx, d.sucursalId, 'OT'),
        ventaId: venta!.id,
        sucursalId: d.sucursalId,
        recetaId: d.recetaId ?? null,
        fechaPrometida: d.ordenTrabajo?.fechaPrometida ?? null,
        instrucciones: d.ordenTrabajo?.instrucciones ?? null,
        laboratorioExterno: d.ordenTrabajo?.laboratorioExterno ?? null,
      })
      .returning();
    await tx
      .insert(historialTrabajo)
      .values({ ordenId: orden!.id, estadoNuevo: 'PENDIENTE', nota: 'Orden creada con la venta', usuarioId: usuario.id });
  }

  return { ...venta!, items, pagos: pagosRegistrados, ordenTrabajo: orden };
}

async function ventaBloqueada(tx: Exec, ventaId: string) {
  const [v] = await tx.select().from(ventas).where(eq(ventas.id, ventaId)).for('update');
  if (!v) throw noEncontrado('Venta');
  return v;
}

/** Abono a una venta con saldo (p. ej. el cliente paga el resto al recoger sus lentes). */
export async function registrarPagos(tx: Exec, ventaId: string, lista: PagoEntrada[], usuario: UsuarioSesion) {
  const v = await ventaBloqueada(tx, ventaId);
  if (v.estado === 'ANULADA') throw reglaNegocio('La venta está anulada');
  if (v.sucursalId !== usuario.sucursalId && !tienePermiso(usuario.rol, 'sucursales.todas')) throw prohibido();
  const monto = lista.reduce((a, p) => a + p.monto, 0);
  if (monto > v.saldo) throw reglaNegocio('El pago supera el saldo pendiente', { saldo: v.saldo, monto });

  const registrados = await cobrar(tx, v, lista, usuario.id);
  const pagado = v.pagado + monto;
  const [act] = await tx
    .update(ventas)
    .set({ pagado, saldo: v.total - pagado, estadoPago: estadoPagoDe(v.total, pagado) })
    .where(eq(ventas.id, v.id))
    .returning();
  return { venta: act!, pagos: registrados };
}

/**
 * Anula una venta: devuelve el stock, reembolsa lo cobrado desde la caja abierta
 * y cancela la orden de trabajo si aún no se entregó.
 */
export async function anularVenta(
  tx: Exec,
  ventaId: string,
  d: { motivo: string; metodoReembolso?: Metodo },
  usuario: UsuarioSesion,
) {
  const v = await ventaBloqueada(tx, ventaId);
  if (v.estado === 'ANULADA') throw reglaNegocio('La venta ya está anulada');

  const [ot] = await tx.select().from(ordenesTrabajo).where(eq(ordenesTrabajo.ventaId, v.id));
  if (ot?.estado === 'ENTREGADO') {
    throw reglaNegocio('Los lentes ya fueron entregados; registra una devolución en vez de anular');
  }

  const items = await tx.select().from(ventaItems).where(eq(ventaItems.ventaId, v.id));
  for (const it of items) {
    await moverStock(tx, {
      productoId: it.productoId,
      sucursalId: v.sucursalId,
      tipo: 'DEVOLUCION_VENTA',
      cantidad: it.cantidad,
      motivo: `Anulación ${v.numero}: ${d.motivo}`,
      referenciaTipo: 'VENTA',
      referenciaId: v.id,
      usuarioId: usuario.id,
    });
  }

  let reembolso = null;
  if (v.pagado > 0) {
    const sesion = await cajaAbierta(tx, v.sucursalId);
    const metodo = d.metodoReembolso ?? 'EFECTIVO';
    if (metodo === 'EFECTIVO') {
      const { efectivoEsperado } = await resumenSesion(tx, sesion.id);
      if (v.pagado > efectivoEsperado) {
        throw reglaNegocio('No hay suficiente efectivo en caja para el reembolso', {
          requerido: v.pagado,
          disponible: efectivoEsperado,
        });
      }
    }
    reembolso = await registrarMovimientoCaja(tx, {
      sesionCajaId: sesion.id,
      tipo: 'EGRESO',
      concepto: 'DEVOLUCION',
      metodo,
      monto: v.pagado,
      descripcion: `Reembolso por anulación ${v.numero}`,
      ventaId: v.id,
      usuarioId: usuario.id,
    });
  }

  if (ot && ot.estado !== 'CANCELADO') {
    await tx.update(ordenesTrabajo).set({ estado: 'CANCELADO' }).where(eq(ordenesTrabajo.id, ot.id));
    await tx.insert(historialTrabajo).values({
      ordenId: ot.id,
      estadoAnterior: ot.estado,
      estadoNuevo: 'CANCELADO',
      nota: `Venta anulada: ${d.motivo}`,
      usuarioId: usuario.id,
    });
  }

  const [anulada] = await tx
    .update(ventas)
    .set({ estado: 'ANULADA', saldo: 0, anuladaPor: usuario.id, anuladaEn: new Date(), motivoAnulacion: d.motivo })
    .where(eq(ventas.id, v.id))
    .returning();
  return { venta: anulada!, reembolso };
}

const TRANSICIONES: Record<EstadoTrabajo, EstadoTrabajo[]> = {
  PENDIENTE: ['EN_LABORATORIO', 'LISTO', 'CANCELADO'],
  EN_LABORATORIO: ['LISTO', 'PENDIENTE', 'CANCELADO'],
  LISTO: ['ENTREGADO', 'EN_LABORATORIO'],
  ENTREGADO: [],
  CANCELADO: [],
};

/** Avanza una orden de trabajo. No se entregan lentes con saldo pendiente. */
export async function cambiarEstadoTrabajo(
  tx: Exec,
  ordenId: string,
  d: { estado: EstadoTrabajo; nota?: string | null },
  usuario: UsuarioSesion,
) {
  const [ot] = await tx.select().from(ordenesTrabajo).where(eq(ordenesTrabajo.id, ordenId)).for('update');
  if (!ot) throw noEncontrado('Orden de trabajo');
  const permiso =
    d.estado === 'ENTREGADO' ? 'laboratorio.entregar' : d.estado === 'CANCELADO' ? 'laboratorio.cancelar' : 'laboratorio.gestionar';
  if (!tienePermiso(usuario.rol, permiso)) {
    throw prohibido(
      d.estado === 'ENTREGADO'
        ? 'La entrega al cliente la registra caja o ventas'
        : d.estado === 'CANCELADO'
          ? 'No puedes cancelar órdenes (normalmente se anula la venta)'
          : 'No puedes cambiar el estado de las órdenes de laboratorio',
    );
  }
  if (!TRANSICIONES[ot.estado].includes(d.estado)) {
    throw reglaNegocio(`No se puede pasar de ${ot.estado} a ${d.estado}`, { permitidos: TRANSICIONES[ot.estado] });
  }
  if (d.estado === 'ENTREGADO') {
    const [v] = await tx.select().from(ventas).where(and(eq(ventas.id, ot.ventaId)));
    if (v && v.saldo > 0) {
      throw reglaNegocio('El cliente tiene saldo pendiente; cobra el saldo antes de entregar', { saldo: v.saldo });
    }
  }
  const [act] = await tx
    .update(ordenesTrabajo)
    .set({ estado: d.estado, entregadoEn: d.estado === 'ENTREGADO' ? new Date() : ot.entregadoEn })
    .where(eq(ordenesTrabajo.id, ot.id))
    .returning();
  await tx.insert(historialTrabajo).values({
    ordenId: ot.id,
    estadoAnterior: ot.estado,
    estadoNuevo: d.estado,
    nota: d.nota ?? null,
    usuarioId: usuario.id,
  });
  return act!;
}

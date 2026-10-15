import { and, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { metodoPago, movimientosCaja, sesionesCaja, transaccionesPersonales, usuarios, ventas } from '../../db/schema/index.js';
import { conflicto, prohibido, reglaNegocio } from '../../lib/errors.js';
import { body, puede, centavos, centavosPositivo, offset, paginacion, param, query, sucursalDe, usuarioDe } from '../../lib/http.js';
import { hoy } from '../../lib/fechas.js';
import { requierePermiso } from '../../middleware/auth.js';
import { CATEGORIA_RETIROS, categoriaPorNombre, cuentaDelUsuario } from '../finanzas/servicio.js';
import { cajaAbierta, registrarMovimientoCaja, resumenSesion } from './servicio.js';

export function rutasCaja(db: DB) {
  const r = Router();
  r.use(requierePermiso('caja.operar'));

  /** Estado actual de la caja de la sucursal (o null si está cerrada). */
  r.get('/actual', async (req, res) => {
    const { sucursalId: s } = query(req, z.object({ sucursalId: z.uuid().optional() }));
    const sucursalId = sucursalDe(req, s);
    const [sesion] = await db
      .select({ id: sesionesCaja.id })
      .from(sesionesCaja)
      .where(and(eq(sesionesCaja.sucursalId, sucursalId), eq(sesionesCaja.estado, 'ABIERTA')));
    res.json(sesion ? await resumenSesion(db, sesion.id) : null);
  });

  r.post('/abrir', async (req, res) => {
    const d = body(
      req,
      z.object({ sucursalId: z.uuid().optional(), montoApertura: centavos, observaciones: z.string().trim().optional() }),
    );
    const sucursalId = sucursalDe(req, d.sucursalId);
    const usuario = usuarioDe(req);
    const sesion = await db.transaction(async (tx) => {
      const [ya] = await tx
        .select({ id: sesionesCaja.id })
        .from(sesionesCaja)
        .where(and(eq(sesionesCaja.sucursalId, sucursalId), eq(sesionesCaja.estado, 'ABIERTA')));
      if (ya) throw conflicto('Ya hay una caja abierta en esta sucursal', { sesionId: ya.id });
      const [s] = await tx
        .insert(sesionesCaja)
        .values({
          sucursalId,
          montoApertura: d.montoApertura,
          abiertaPor: usuario.id,
          observaciones: d.observaciones,
        })
        .returning();
      return s!;
    });
    res.status(201).json(sesion);
  });

  /**
   * Cierre con arqueo: se declara el efectivo contado y el sistema calcula la diferencia
   * contra lo esperado (apertura + ingresos en efectivo − egresos en efectivo).
   */
  r.post('/cerrar', async (req, res) => {
    const d = body(
      req,
      z.object({
        sucursalId: z.uuid().optional(),
        efectivoContado: centavos,
        observaciones: z.string().trim().optional(),
      }),
    );
    const sucursalId = sucursalDe(req, d.sucursalId);
    const usuario = usuarioDe(req);
    const resultado = await db.transaction(async (tx) => {
      const sesion = await cajaAbierta(tx, sucursalId);
      const resumen = await resumenSesion(tx, sesion.id);
      const diferencia = d.efectivoContado - resumen.efectivoEsperado;
      const [cerrada] = await tx
        .update(sesionesCaja)
        .set({
          estado: 'CERRADA',
          cerradaPor: usuario.id,
          cerradaEn: new Date(),
          efectivoEsperado: resumen.efectivoEsperado,
          efectivoContado: d.efectivoContado,
          diferencia,
          observaciones: [sesion.observaciones, d.observaciones].filter(Boolean).join(' | ') || null,
        })
        .where(eq(sesionesCaja.id, sesion.id))
        .returning();
      return { ...resumen, sesion: cerrada! };
    });
    res.json(resultado);
  });

  /**
   * Movimiento manual de caja: gastos (pasajes, limpieza), depósitos de sencillo,
   * o retiro del dueño. Un retiro con cuentaPersonalId se refleja en sus finanzas personales.
   */
  r.post('/movimientos', async (req, res) => {
    const d = body(
      req,
      z
        .object({
          sucursalId: z.uuid().optional(),
          concepto: z.enum(['GASTO', 'RETIRO_DUENO', 'DEPOSITO', 'OTRO']),
          tipo: z.enum(['INGRESO', 'EGRESO']).optional(),
          metodo: z.enum(metodoPago.enumValues).optional(),
          monto: centavosPositivo,
          descripcion: z.string().trim().min(3).max(300),
          cuentaPersonalId: z.uuid().optional(),
        })
        .refine((v) => !v.cuentaPersonalId || v.concepto === 'RETIRO_DUENO', {
          message: 'Solo un retiro del dueño puede ir a una cuenta personal',
          path: ['cuentaPersonalId'],
        }),
    );
    const usuario = usuarioDe(req);
    if (d.concepto === 'RETIRO_DUENO' && !puede(req, 'caja.retiro_dueno')) {
      throw prohibido('Solo el dueño puede registrar retiros del dueño');
    }
    const tipo =
      d.concepto === 'GASTO' || d.concepto === 'RETIRO_DUENO' ? 'EGRESO' : d.concepto === 'DEPOSITO' ? 'INGRESO' : d.tipo;
    if (!tipo) throw reglaNegocio('Indica tipo (INGRESO o EGRESO) para el concepto OTRO');
    const metodo = d.metodo ?? 'EFECTIVO';
    const sucursalId = sucursalDe(req, d.sucursalId);

    const resultado = await db.transaction(async (tx) => {
      const sesion = await cajaAbierta(tx, sucursalId);
      if (tipo === 'EGRESO' && metodo === 'EFECTIVO') {
        const { efectivoEsperado } = await resumenSesion(tx, sesion.id);
        if (d.monto > efectivoEsperado) {
          throw reglaNegocio('No hay suficiente efectivo en caja', { disponible: efectivoEsperado });
        }
      }
      const movimiento = await registrarMovimientoCaja(tx, {
        sesionCajaId: sesion.id,
        tipo,
        concepto: d.concepto,
        metodo,
        monto: d.monto,
        descripcion: d.descripcion,
        usuarioId: usuario.id,
      });
      let transaccionPersonal = null;
      if (d.cuentaPersonalId) {
        await cuentaDelUsuario(tx, usuario.id, d.cuentaPersonalId);
        const categoria = await categoriaPorNombre(tx, usuario.id, CATEGORIA_RETIROS, 'INGRESO');
        [transaccionPersonal] = await tx
          .insert(transaccionesPersonales)
          .values({
            usuarioId: usuario.id,
            tipo: 'INGRESO',
            cuentaId: d.cuentaPersonalId,
            categoriaId: categoria.id,
            monto: d.monto,
            fecha: hoy(),
            descripcion: d.descripcion,
            movimientoCajaId: movimiento.id,
          })
          .returning();
      }
      return { movimiento, transaccionPersonal };
    });
    res.status(201).json(resultado);
  });

  /** Historial de sesiones (turnos) de la sucursal. */
  r.get('/sesiones', async (req, res) => {
    const f = query(req, paginacion.extend({ sucursalId: z.uuid().optional() }));
    const sucursalId = sucursalDe(req, f.sucursalId);
    res.json(
      await db
        .select()
        .from(sesionesCaja)
        .where(eq(sesionesCaja.sucursalId, sucursalId))
        .orderBy(desc(sesionesCaja.abiertaEn))
        .limit(f.porPagina)
        .offset(offset(f)),
    );
  });

  /** Detalle de una sesión: resumen y todos sus movimientos. */
  r.get('/sesiones/:id', async (req, res) => {
    const id = param(req);
    const resumen = await resumenSesion(db, id);
    sucursalDe(req, resumen.sesion.sucursalId); // valida acceso a la sucursal
    const movimientos = await db
      .select({
        id: movimientosCaja.id,
        tipo: movimientosCaja.tipo,
        concepto: movimientosCaja.concepto,
        metodo: movimientosCaja.metodo,
        monto: movimientosCaja.monto,
        descripcion: movimientosCaja.descripcion,
        ventaId: movimientosCaja.ventaId,
        ventaNumero: ventas.numero,
        usuario: usuarios.nombre,
        creadoEn: movimientosCaja.creadoEn,
      })
      .from(movimientosCaja)
      .leftJoin(ventas, eq(ventas.id, movimientosCaja.ventaId))
      .leftJoin(usuarios, eq(usuarios.id, movimientosCaja.usuarioId))
      .where(eq(movimientosCaja.sesionCajaId, id))
      .orderBy(desc(movimientosCaja.creadoEn));
    res.json({ ...resumen, movimientos });
  });

  return r;
}

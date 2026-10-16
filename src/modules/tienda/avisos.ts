import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import type { Exec } from '../../db/client.js';
import { citas, clientes, cuentasTienda, pedidosWeb } from '../../db/schema/index.js';
import { plantilla, type Correo, type Mensaje } from '../../lib/correo.js';
import { MOTIVOS } from '../citas/servicio.js';
import { sucursalTienda } from './servicio.js';

const bs = (c: number) => `Bs ${(c / 100).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** "2026-10-16" → "viernes 16 de octubre" */
const diaLargo = (f: string) => {
  const d = new Date(`${f}T12:00:00Z`);
  return `${dias[d.getUTCDay()]} ${d.getUTCDate()} de ${meses[d.getUTCMonth()]}`;
};

/**
 * Correos a los clientes de la tienda. Nunca frenan ni hacen fallar la operación:
 * si no hay servicio de correo configurado no hacen nada, y si el envío falla solo queda en el log.
 */
export type Avisos = ReturnType<typeof crearAvisos>;

export function crearAvisos(db: Exec, correo: Correo | null) {
  const enviar = async (armar: () => Promise<Mensaje | null>) => {
    if (!correo) return;
    try {
      const m = await armar();
      if (m) await correo.enviar(m);
    } catch (err) {
      console.error('[correo] no se pudo enviar', err);
    }
  };

  async function datosPedido(id: string) {
    const [p] = await db
      .select({ pedido: pedidosWeb, email: cuentasTienda.email, nombre: clientes.nombre })
      .from(pedidosWeb)
      .innerJoin(cuentasTienda, eq(cuentasTienda.id, pedidosWeb.cuentaId))
      .innerJoin(clientes, eq(clientes.id, pedidosWeb.clienteId))
      .where(eq(pedidosWeb.id, id));
    if (!p) return null;
    const s = await sucursalTienda(db);
    const lugar = `${s.nombre}${s.direccion ? `, ${s.direccion}` : ''}`;
    return { ...p, lugar, telefono: s.telefono, url: `${env.TIENDA_URL}/pedidos/${id}`, primerNombre: p.nombre.split(' ')[0] ?? p.nombre };
  }

  return {
    /** Habilitado = hay servicio de correo configurado. */
    habilitado: correo != null,

    /** Pedido confirmado con pago al retirar (los de tarjeta avisan al pagarse). */
    pedidoRecibido: (id: string) =>
      enviar(async () => {
        const d = await datosPedido(id);
        if (!d) return null;
        const p = d.pedido;
        return plantilla({
          para: d.email,
          asunto: `Recibimos tu pedido ${p.numero}`,
          saludo: `Hola ${d.primerNombre}:`,
          parrafos: [
            `Recibimos tu pedido ${p.numero} por ${bs(p.total)}. Lo pagas al retirarlo en ${d.lugar}.`,
            'Te avisamos cuando esté listo. Mientras tanto, puedes ver cómo va desde tu cuenta.',
          ],
          boton: { texto: 'Ver mi pedido', url: d.url },
        });
      }),

    pagoRecibido: (id: string) =>
      enviar(async () => {
        const d = await datosPedido(id);
        if (!d) return null;
        const p = d.pedido;
        return plantilla({
          para: d.email,
          asunto: `Pago recibido: pedido ${p.numero}`,
          saludo: `Hola ${d.primerNombre}:`,
          parrafos: [
            `Recibimos el pago de ${bs(p.total)} de tu pedido ${p.numero}. Ya lo estamos preparando.`,
            p.entrega === 'RETIRO' ? `Te avisamos cuando puedas retirarlo en ${d.lugar}.` : 'Te avisamos cuando salga hacia tu domicilio.',
          ],
          boton: { texto: 'Ver mi pedido', url: d.url },
        });
      }),

    /** Listo para retirar o enviado. */
    pedidoEnCamino: (id: string) =>
      enviar(async () => {
        const d = await datosPedido(id);
        if (!d) return null;
        const p = d.pedido;
        const listo = p.estado === 'LISTO';
        return plantilla({
          para: d.email,
          asunto: listo ? `Tu pedido ${p.numero} está listo` : `Tu pedido ${p.numero} va en camino`,
          saludo: `Hola ${d.primerNombre}:`,
          parrafos: listo
            ? [
                `Tu pedido ${p.numero} ya está listo. Pasa a retirarlo en ${d.lugar} y menciona el número del pedido.`,
                ...(p.pagadoEn ? [] : [`El total a pagar es ${bs(p.total)}: efectivo, QR o tarjeta.`]),
              ]
            : [`Tu pedido ${p.numero} salió hacia ${p.direccion ?? 'tu domicilio'}. Si no estás, te llamamos al ${p.telefono}.`],
          boton: { texto: 'Ver mi pedido', url: d.url },
        });
      }),

    pedidoCancelado: (id: string) =>
      enviar(async () => {
        const d = await datosPedido(id);
        if (!d) return null;
        const p = d.pedido;
        const reembolso = p.metodoPago === 'STRIPE' && p.pagadoEn != null;
        return plantilla({
          para: d.email,
          asunto: `Pedido ${p.numero} cancelado`,
          saludo: `Hola ${d.primerNombre}:`,
          parrafos: [
            `Tu pedido ${p.numero} se canceló. Motivo: ${(p.canceladoMotivo ?? 'sin detalle').replace(' · pago reembolsado', '')}.`,
            reembolso
              ? `Devolvimos ${bs(p.total)} a tu tarjeta; según tu banco, puede tardar de 5 a 10 días en verse.`
              : 'No se hizo ningún cobro.',
            ...(d.telefono ? [`Si tienes dudas, llámanos al ${d.telefono}.`] : []),
          ],
          boton: { texto: 'Volver a la tienda', url: env.TIENDA_URL },
        });
      }),

    citaReservada: (id: string) =>
      enviar(async () => {
        const [c] = await db
          .select({ cita: citas, email: cuentasTienda.email })
          .from(citas)
          .innerJoin(cuentasTienda, eq(cuentasTienda.id, citas.cuentaId))
          .where(eq(citas.id, id));
        if (!c) return null;
        const s = await sucursalTienda(db);
        return plantilla({
          para: c.email,
          asunto: `Tu cita del ${diaLargo(c.cita.fecha)} a las ${c.cita.hora}`,
          saludo: `Hola ${c.cita.nombreContacto.split(' ')[0]}:`,
          parrafos: [
            `Reservaste ${MOTIVOS[c.cita.motivo].toLowerCase()} el ${diaLargo(c.cita.fecha)} a las ${c.cita.hora} en ${s.nombre}${s.direccion ? `, ${s.direccion}` : ''}.`,
            `Te escribiremos al ${c.cita.telefono} para confirmarla. Si usas lentes, tráelos.`,
            'Si no puedes venir, cancélala desde la tienda para liberar el turno.',
          ],
          boton: { texto: 'Ver mis citas', url: `${env.TIENDA_URL}/citas` },
        });
      }),

    recuperarPassword: (email: string, nombre: string, enlace: string) =>
      enviar(async () =>
        plantilla({
          para: email,
          asunto: 'Crea una nueva contraseña',
          saludo: `Hola ${nombre.split(' ')[0]}:`,
          parrafos: [
            'Pediste crear una nueva contraseña para tu cuenta de la tienda. El enlace sirve una sola vez y vence en 1 hora.',
            'Si no fuiste tú, ignora este correo: tu contraseña sigue igual.',
          ],
          boton: { texto: 'Crear nueva contraseña', url: enlace },
        }),
      ),
  };
}

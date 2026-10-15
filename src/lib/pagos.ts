import Stripe from 'stripe';
import { env } from '../config/env.js';

/**
 * Lo que la tienda necesita de una pasarela de pagos. La implementación real usa Stripe Checkout
 * (la página de pago la aloja Stripe: los datos de la tarjeta nunca pasan por nuestro servidor).
 * Los tests usan una pasarela falsa con la misma forma.
 */
export interface PasarelaPagos {
  crearSesion(datos: DatosSesion): Promise<{ id: string; url: string }>;
  /** Estado de una sesión de pago consultado directamente a Stripe. */
  obtenerSesion(id: string): Promise<SesionPago>;
  /** Cierra una sesión abierta para que ya no se pueda pagar. */
  expirarSesion(id: string): Promise<void>;
  /** Devuelve el dinero de un pago completo. */
  reembolsar(paymentIntent: string): Promise<void>;
  /** Valida la firma del webhook y devuelve el evento. Lanza error si la firma no es válida. */
  leerWebhook(cuerpo: Buffer, firma: string): EventoPago;
}

export type DatosSesion = {
  pedidoId: string;
  numero: string;
  email: string;
  items: { nombre: string; precioUnitario: number; cantidad: number; imagenUrl?: string | null }[];
  costoEnvio: number;
  expiraEn: Date;
  urlExito: string;
  urlCancelar: string;
};

export type SesionPago = {
  id: string;
  pedidoId: string | null;
  /** open = esperando pago; complete = terminó; expired = venció. */
  estado: 'open' | 'complete' | 'expired';
  pagado: boolean;
  paymentIntent: string | null;
  url: string | null;
};

export type EventoPago =
  | { tipo: 'pagado'; sesion: SesionPago }
  | { tipo: 'vencido'; sesion: SesionPago }
  | { tipo: 'otro'; nombre: string };

/** Centavos de boliviano → unidad mínima de la moneda de cobro. */
export function aMonedaCobro(centavosBs: number): number {
  if (env.STRIPE_MONEDA === 'bob') return centavosBs;
  return Math.round(centavosBs / env.STRIPE_TIPO_CAMBIO);
}

function aSesion(s: Stripe.Checkout.Session): SesionPago {
  const pi = s.payment_intent;
  return {
    id: s.id,
    pedidoId: s.client_reference_id ?? s.metadata?.pedidoId ?? null,
    estado: (s.status ?? 'open') as SesionPago['estado'],
    pagado: s.payment_status === 'paid' || s.payment_status === 'no_payment_required',
    paymentIntent: typeof pi === 'string' ? pi : (pi?.id ?? null),
    url: s.url ?? null,
  };
}

export function crearPasarelaStripe(secreto: string, secretoWebhook?: string): PasarelaPagos {
  const stripe = new Stripe(secreto, { appInfo: { name: 'provision-backend' } });
  return {
    async crearSesion(d) {
      const lineas: Stripe.Checkout.SessionCreateParams.LineItem[] = d.items.map((i) => ({
        quantity: i.cantidad,
        price_data: {
          currency: env.STRIPE_MONEDA,
          unit_amount: aMonedaCobro(i.precioUnitario),
          product_data: {
            name: i.nombre,
            ...(i.imagenUrl?.startsWith('https://') ? { images: [i.imagenUrl] } : {}),
          },
        },
      }));
      if (d.costoEnvio > 0) {
        lineas.push({
          quantity: 1,
          price_data: {
            currency: env.STRIPE_MONEDA,
            unit_amount: aMonedaCobro(d.costoEnvio),
            product_data: { name: 'Envío a domicilio' },
          },
        });
      }
      const s = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: lineas,
          customer_email: d.email,
          client_reference_id: d.pedidoId,
          metadata: { pedidoId: d.pedidoId, numero: d.numero },
          payment_intent_data: { metadata: { pedidoId: d.pedidoId, numero: d.numero }, description: `Pedido ${d.numero}` },
          expires_at: Math.floor(d.expiraEn.getTime() / 1000),
          success_url: d.urlExito,
          cancel_url: d.urlCancelar,
          locale: 'es',
        },
        // Si la petición se reintenta, Stripe no crea una segunda sesión para el mismo pedido.
        { idempotencyKey: `pedido-${d.pedidoId}-${d.expiraEn.getTime()}` },
      );
      if (!s.url) throw new Error('Stripe no devolvió la URL de pago');
      return { id: s.id, url: s.url };
    },
    async obtenerSesion(id) {
      return aSesion(await stripe.checkout.sessions.retrieve(id));
    },
    async expirarSesion(id) {
      const s = await stripe.checkout.sessions.retrieve(id);
      if (s.status === 'open') await stripe.checkout.sessions.expire(id);
    },
    async reembolsar(paymentIntent) {
      await stripe.refunds.create({ payment_intent: paymentIntent });
    },
    leerWebhook(cuerpo, firma) {
      if (!secretoWebhook) throw new Error('STRIPE_WEBHOOK_SECRET no está configurado');
      const e = stripe.webhooks.constructEvent(cuerpo, firma, secretoWebhook);
      switch (e.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          const sesion = aSesion(e.data.object);
          return sesion.pagado ? { tipo: 'pagado', sesion } : { tipo: 'otro', nombre: e.type };
        }
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed':
          return { tipo: 'vencido', sesion: aSesion(e.data.object) };
        default:
          return { tipo: 'otro', nombre: e.type };
      }
    },
  };
}

/** La pasarela configurada por variables de entorno, o null si Stripe aún no está configurado. */
export function pasarelaDesdeEntorno(): PasarelaPagos | null {
  return env.STRIPE_SECRET_KEY ? crearPasarelaStripe(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET) : null;
}

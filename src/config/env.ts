import { z } from 'zod';
import { cargarEntorno } from './cargar-entorno.js';
import { leerHorario } from '../lib/horario.js';

const APP_ENV = cargarEntorno();

const comun = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CORS_ORIGIN: z.string().default('*'),
  /** true si la base exige conexión cifrada (típico en un servidor remoto). */
  DATABASE_SSL: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  LOG_HTTP: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  ADMIN_NOMBRE: z.string().default('Administrador'),
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  SUCURSAL_NOMBRE: z.string().default('Casa matriz'),
  SUCURSAL_CODIGO: z.string().regex(/^[A-Z0-9]{2,10}$/).default('MAT'),

  /* Tienda web */
  /** Dirección pública de la tienda (sin / al final): Stripe vuelve aquí después de pagar. */
  TIENDA_URL: z.url().transform((u) => u.replace(/\/+$/, '')).default('http://localhost:5173'),
  /** Código de la sucursal que despacha los pedidos web. Por defecto, la primera sucursal activa. */
  TIENDA_SUCURSAL_CODIGO: z.string().optional(),
  /** Costo de envío a domicilio en centavos (Bs 20 = 2000). */
  TIENDA_COSTO_ENVIO: z.coerce.number().int().nonnegative().default(2000),
  /** Minutos que se reserva el stock de un pedido mientras el cliente paga con tarjeta. */
  TIENDA_MINUTOS_RESERVA: z.coerce.number().int().min(30).max(1440).default(30),
  /** Días que se guarda el stock de un pedido "pago al retirar" antes de cancelarlo. */
  TIENDA_DIAS_RETIRO: z.coerce.number().int().min(1).max(30).default(3),

  /* Stripe: sin STRIPE_SECRET_KEY la tienda funciona, pero solo con pago al retirar. */
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  /** Moneda del cobro en Stripe (minúsculas). bob = bolivianos, sin conversión. */
  STRIPE_MONEDA: z.string().regex(/^[a-z]{3}$/).default('bob'),
  /** Bolivianos por 1 unidad de STRIPE_MONEDA (solo si no es bob). Ej.: 6.96 para usd. */
  STRIPE_TIPO_CAMBIO: z.coerce.number().positive().default(1),

  /* Citas para examen de la vista */
  /** Horario de atención: "lun-vie 09:00-13:00 15:00-19:00; sab 09:00-13:00". */
  CITAS_HORARIO: z
    .string()
    .default('lun-vie 09:00-13:00 15:00-19:00; sab 09:00-13:00')
    .refine((v) => {
      try {
        return leerHorario(v).size > 0;
      } catch {
        return false;
      }
    }, 'Horario inválido. Ejemplo: "lun-vie 09:00-13:00 15:00-19:00; sab 09:00-13:00"'),
  /** Minutos por cita. */
  CITAS_DURACION: z.coerce.number().int().min(10).max(180).default(30),
  /** Citas al mismo tiempo (cuántos optometristas atienden a la vez). */
  CITAS_CUPOS: z.coerce.number().int().min(1).max(20).default(1),
  /** Hasta cuántos días adelante se puede reservar. */
  CITAS_DIAS_ADELANTE: z.coerce.number().int().min(1).max(120).default(30),

  /* Correo (Resend): recuperar contraseña y avisos de pedidos y citas. Sin RESEND_API_KEY no se envían correos. */
  RESEND_API_KEY: z.string().startsWith('re_').optional(),
  /** Remitente. Sin dominio verificado en Resend, solo funciona onboarding@resend.dev (y solo hacia tu propio correo). */
  CORREO_REMITENTE: z.string().default('Provisión <onboarding@resend.dev>'),

  /* Cloudinary: fotos de productos. Es la "API environment variable" del dashboard:
     cloudinary://API_KEY:API_SECRET@CLOUD_NAME. Sin ella, no se pueden subir fotos. */
  CLOUDINARY_URL: z
    .string()
    .regex(/^cloudinary:\/\/[^:]+:[^@]+@[^/?#]+$/, 'Debe tener la forma cloudinary://API_KEY:API_SECRET@CLOUD_NAME')
    .optional(),
});

/** Local: valores cómodos por defecto para levantar todo con docker compose. */
const local = comun.extend({
  DATABASE_URL: z.string().default('postgres://provision:provision@localhost:5432/provision'),
  JWT_SECRET: z.string().min(16).default('secreto-local-solo-para-esta-maquina'),
});

/** Desarrollo: servidor compartido. Nada se asume: todo debe venir configurado. */
const desarrollo = comun.extend({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio en desarrollo'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres en desarrollo'),
  CORS_ORIGIN: z.string().min(1).refine((v) => v !== '*', 'En desarrollo indica los orígenes permitidos'),
});

const test = comun.extend({
  DATABASE_URL: z.string().default('pglite://memoria'),
  JWT_SECRET: z.string().default('secreto-de-pruebas-automatizadas'),
  LOG_HTTP: z.literal('false').default('false').transform(() => false),
});

const esquema = { local, desarrollo, test }[APP_ENV];
// Una variable vacía ("ADMIN_EMAIL=") cuenta como no definida.
const valores = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
const r = esquema.safeParse(valores);
if (!r.success) {
  console.error(`Configuración inválida para el entorno "${APP_ENV}":`);
  console.error(z.prettifyError(r.error));
  process.exit(1);
}

export const env = { APP_ENV, ...r.data };

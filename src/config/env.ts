import { z } from 'zod';
import { cargarEntorno } from './cargar-entorno.js';

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

import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default('postgres://provision:provision@localhost:5432/provision'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET debe tener al menos 16 caracteres').default('dev-secret-solo-para-desarrollo'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CORS_ORIGIN: z.string().default('*'),
  ADMIN_EMAIL: z.string().email().default('admin@provision.bo'),
  ADMIN_PASSWORD: z.string().min(8).default('Provision2026!'),
});

export const env = schema.parse(process.env);

if (env.NODE_ENV === 'production' && env.JWT_SECRET === 'dev-secret-solo-para-desarrollo') {
  throw new Error('Define JWT_SECRET en producción');
}

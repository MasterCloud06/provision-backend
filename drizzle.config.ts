import { defineConfig } from 'drizzle-kit';
import { cargarEntorno } from './src/config/cargar-entorno.js';

cargarEntorno();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://provision:provision@localhost:5432/provision',
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  },
  casing: 'snake_case',
});

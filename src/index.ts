import { crearApp } from './app.js';
import { env } from './config/env.js';
import { crearDb } from './db/client.js';

const { db, cerrar } = crearDb(env.DATABASE_URL, env.DATABASE_SSL);
const servidor = crearApp(db).listen(env.PORT, () => {
  console.log(`[${env.APP_ENV}] Provisión API escuchando en http://localhost:${env.PORT}/api/v1`);
});

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    servidor.close(() => void cerrar().then(() => process.exit(0)));
  });
}

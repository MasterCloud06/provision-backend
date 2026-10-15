import { crearApp } from './app.js';
import { env } from './config/env.js';
import { crearDb } from './db/client.js';

const { db, cerrar } = crearDb(env.DATABASE_URL);
const servidor = crearApp(db).listen(env.PORT, () => {
  console.log(`Provisión API escuchando en http://localhost:${env.PORT}/api/v1`);
});

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    servidor.close(() => void cerrar().then(() => process.exit(0)));
  });
}

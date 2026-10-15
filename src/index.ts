import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { crearApp } from './app.js';
import { env } from './config/env.js';
import { crearDb } from './db/client.js';
import { asegurarSuperadmin } from './db/superadmin.js';

const { db, cerrar } = crearDb(env.DATABASE_URL, env.DATABASE_SSL);

// Fuera de local, el servidor aplica las migraciones pendientes antes de arrancar.
// En local se corren a mano con `npm run db:migrate`.
if (env.APP_ENV !== 'local') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await migrate(db as any, { migrationsFolder: 'drizzle' });
  console.log(`[${env.APP_ENV}] Migraciones al día`);
}

const ascendido = await asegurarSuperadmin(db);
if (ascendido) console.log(`[${env.APP_ENV}] ${ascendido} ahora es super administrador`);

const servidor = crearApp(db).listen(env.PORT, () => {
  console.log(`[${env.APP_ENV}] Provisión API escuchando en el puerto ${env.PORT}`);
});

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    servidor.close(() => void cerrar().then(() => process.exit(0)));
  });
}

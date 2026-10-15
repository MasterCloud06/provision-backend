import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { crearApp } from './app.js';
import { env } from './config/env.js';
import { crearDb } from './db/client.js';
import { asegurarSuperadmin } from './db/superadmin.js';
import { pasarelaDesdeEntorno } from './lib/pagos.js';
import { liberarVencidos } from './modules/tienda/servicio.js';

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

const pagos = pasarelaDesdeEntorno();
console.log(`[${env.APP_ENV}] Fotos de productos: ${env.CLOUDINARY_URL ? 'Cloudinary activo' : 'sin configurar (falta CLOUDINARY_URL)'}`);
console.log(`[${env.APP_ENV}] Tienda web: ${pagos ? `pago con Stripe activo (${env.STRIPE_MONEDA})` : 'Stripe sin configurar, solo pago al retirar'}`);

// Cada 5 minutos devuelve al inventario el stock de pedidos que no se pagaron a tiempo.
const limpieza = setInterval(() => {
  liberarVencidos(db, pagos)
    .then((n) => n && console.log(`[tienda] ${n} pedido(s) sin pagar cancelados; el stock volvió a la venta`))
    .catch((err) => console.error('[tienda] error al liberar pedidos vencidos', err));
}, 5 * 60_000);
limpieza.unref();

const servidor = crearApp(db, { pagos }).listen(env.PORT, () => {
  console.log(`[${env.APP_ENV}] Provisión API escuchando en el puerto ${env.PORT}`);
});

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    servidor.close(() => void cerrar().then(() => process.exit(0)));
  });
}

import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import type { DB } from './db/client.js';
import { autenticar } from './middleware/auth.js';
import { auditoria } from './middleware/auditoria.js';
import { manejadorErrores, noEncontradoRuta } from './middleware/errores.js';
import { rutasAuth, rutasSucursales, rutasUsuarios } from './modules/admin/routes.js';
import { rutasAuditoria } from './modules/auditoria/routes.js';
import { rutasCaja } from './modules/caja/routes.js';
import { rutasPanel } from './modules/panel/routes.js';
import { rutasCatalogo } from './modules/catalogo/routes.js';
import { rutasClientes } from './modules/clientes/routes.js';
import { rutasFinanzas } from './modules/finanzas/routes.js';
import { rutasInventario } from './modules/inventario/routes.js';
import { rutasReportes } from './modules/reportes/routes.js';
import { rutasOrdenesTrabajo, rutasVentas } from './modules/ventas/routes.js';
import { rutasPedidosWeb } from './modules/pedidos-web/routes.js';
import { rutasTienda, webhookStripe } from './modules/tienda/routes.js';
import { pasarelaDesdeEntorno, type PasarelaPagos } from './lib/pagos.js';
import { almacenDesdeEntorno, type AlmacenFotos } from './lib/fotos.js';

export type OpcionesApp = {
  /** Pasarela de pagos; por defecto la de las variables de entorno (null si Stripe no está configurado). */
  pagos?: PasarelaPagos | null;
  /** Dónde se guardan las fotos; por defecto Cloudinary si CLOUDINARY_URL está definida. */
  fotos?: AlmacenFotos | null;
};

export function crearApp(db: DB, opciones: OpcionesApp = {}) {
  const pagos = opciones.pagos === undefined ? pasarelaDesdeEntorno() : opciones.pagos;
  const fotos = opciones.fotos === undefined ? almacenDesdeEntorno() : opciones.fotos;
  const app = express();
  app.disable('x-powered-by');
  // Render (y cualquier proxy) pone la IP real del cliente en X-Forwarded-For.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') }));
  // El webhook de Stripe necesita el cuerpo crudo para validar la firma: va antes de express.json().
  app.post('/api/v1/tienda/stripe/webhook', ...webhookStripe(db, pagos));
  app.use(express.json({ limit: '1mb' }));
  if (env.LOG_HTTP) app.use(morgan(env.APP_ENV === 'local' ? 'dev' : 'combined'));

  app.get('/salud', (_req, res) => {
    res.json({ ok: true, servicio: 'provision-backend', entorno: env.APP_ENV });
  });

  const api = Router();
  // Registra cada operación que modifica datos (también intentos negados y logins fallidos).
  api.use(auditoria(db));
  api.use('/auth', rutasAuth(db));
  // Tienda web para clientes: catálogo público y cuentas de clientes (con su propio token).
  api.use('/tienda', rutasTienda(db, pagos));

  // Todo lo que sigue requiere sesión
  api.use(autenticar(db));
  api.use('/panel', rutasPanel(db));
  api.use('/usuarios', rutasUsuarios(db));
  api.use('/sucursales', rutasSucursales(db));
  api.use('/catalogo', rutasCatalogo(db, fotos));
  api.use('/inventario', rutasInventario(db));
  api.use('/clientes', rutasClientes(db));
  api.use('/caja', rutasCaja(db));
  api.use('/ventas', rutasVentas(db));
  api.use('/ordenes-trabajo', rutasOrdenesTrabajo(db));
  api.use('/finanzas', rutasFinanzas(db));
  api.use('/reportes', rutasReportes(db));
  api.use('/auditoria', rutasAuditoria(db));
  api.use('/pedidos-web', rutasPedidosWeb(db, pagos));

  app.use('/api/v1', api);
  app.use(noEncontradoRuta);
  app.use(manejadorErrores);
  return app;
}

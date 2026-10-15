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

export function crearApp(db: DB) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') }));
  app.use(express.json({ limit: '1mb' }));
  if (env.LOG_HTTP) app.use(morgan(env.APP_ENV === 'local' ? 'dev' : 'combined'));

  app.get('/salud', (_req, res) => {
    res.json({ ok: true, servicio: 'provision-backend', entorno: env.APP_ENV });
  });

  const api = Router();
  // Registra cada operación que modifica datos (también intentos negados y logins fallidos).
  api.use(auditoria(db));
  api.use('/auth', rutasAuth(db));

  // Todo lo que sigue requiere sesión
  api.use(autenticar(db));
  api.use('/panel', rutasPanel(db));
  api.use('/usuarios', rutasUsuarios(db));
  api.use('/sucursales', rutasSucursales(db));
  api.use('/catalogo', rutasCatalogo(db));
  api.use('/inventario', rutasInventario(db));
  api.use('/clientes', rutasClientes(db));
  api.use('/caja', rutasCaja(db));
  api.use('/ventas', rutasVentas(db));
  api.use('/ordenes-trabajo', rutasOrdenesTrabajo(db));
  api.use('/finanzas', rutasFinanzas(db));
  api.use('/reportes', rutasReportes(db));
  api.use('/auditoria', rutasAuditoria(db));

  app.use('/api/v1', api);
  app.use(noEncontradoRuta);
  app.use(manejadorErrores);
  return app;
}

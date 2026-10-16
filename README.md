# Provisión · Backend

API para ópticas: **inventario, caja, ventas y finanzas personales** del dueño, pensada para el día a día real de una óptica en Bolivia: lentes que se encargan con anticipo, órdenes de laboratorio, cobros en efectivo/QR/tarjeta y arqueo de caja por turno.

**Stack:** Node 20+ · TypeScript · Express 5 · PostgreSQL 18.6 · Drizzle ORM · Zod · JWT. Los tests corren sobre un Postgres embebido (PGlite), sin instalar nada.

## Entornos

El proyecto tiene dos entornos de trabajo. Cada uno lee su propio archivo de configuración y apunta a su propia base de datos, así nunca se mezclan los datos.

| | **Local** | **Desarrollo** |
|---|---|---|
| Para qué | Programar y probar en tu computadora | Servidor compartido para probar antes de producción |
| Configuración | `.env.local` | `.env.desarrollo` |
| Base de datos | PostgreSQL 18.6 en Docker (`docker-compose.yml`) | PostgreSQL 18.6 del servidor, con SSL |
| Valores por defecto | Sí, funciona casi sin configurar | No: si falta algo, no arranca y dice qué falta |
| CORS | `http://localhost:5173` | Solo los orígenes que indiques (no acepta `*`) |

El entorno se elige con la variable `APP_ENV` (`local` por defecto). Los scripts ya la ponen; no hace falta escribirla. Los archivos `.env.*` reales están en `.gitignore`: solo se versionan los `.example`.

### Local

```bash
cp .env.local.example .env.local
npm install
npm run db:levantar          # PostgreSQL 18.6 en Docker (puerto 5432)
npm run db:migrate           # crea las tablas, vacías
npm run db:crear-admin       # solo la primera sucursal y el usuario admin
npm run dev                  # http://localhost:3000/api/v1
```

### Desarrollo

```bash
cp .env.desarrollo.example .env.desarrollo   # completa DATABASE_URL, JWT_SECRET, CORS_ORIGIN, admin
npm run db:migrate:desarrollo
npm run db:crear-admin:desarrollo
npm run build && npm run start:desarrollo    # o npm run dev:desarrollo para recargar al editar
```

En el servidor también puedes definir las variables en el sistema en vez del archivo: las del sistema tienen prioridad.

#### Desarrollo en Render

El entorno de desarrollo se despliega en Render con `render.yaml`:

1. En Render: **New → Blueprint** y elige este repositorio.
2. Cuando lo pida, completa:
   - `DATABASE_URL` → la **Internal Database URL** de tu base en Render.
   - `CORS_ORIGIN` → la URL del frontend de desarrollo (por ahora puede ser `http://localhost:5173`).
3. `JWT_SECRET` lo genera Render solo. Al arrancar, la API aplica sola las migraciones pendientes; el build se hace automáticamente tras `npm install`.
4. La región del servicio en `render.yaml` debe ser la misma que la de la base.

Para trabajar contra esa base **desde tu computadora** (migraciones manuales, `db:crear-admin:desarrollo`, `db:studio:desarrollo`), en `.env.desarrollo` usa la **External Database URL** con `DATABASE_SSL=true`. La Internal solo funciona dentro de Render.

### Base de datos vacía

La base arranca **sin datos**. `db:crear-admin` crea únicamente la primera sucursal y el administrador para poder ingresar, y no hace nada si ya hay usuarios. Productos, clientes y demás se cargan desde la aplicación.

### Comandos

| Comando | Local | Desarrollo |
|---|---|---|
| Servidor con recarga | `npm run dev` | `npm run dev:desarrollo` |
| Servidor compilado | `npm start` | `npm run start:desarrollo` |
| Aplicar migraciones | `npm run db:migrate` | `npm run db:migrate:desarrollo` |
| Crear admin inicial | `npm run db:crear-admin` | `npm run db:crear-admin:desarrollo` |
| Explorar la base | `npm run db:studio` | `npm run db:studio:desarrollo` |
| Levantar / detener Postgres | `npm run db:levantar` / `db:detener` | — |

Otros: `npm test`, `npm run typecheck`, `npm run db:generate` (genera una migración tras cambiar el esquema; siempre se genera en local y luego se aplica en cada entorno).

`GET /salud` responde qué entorno está corriendo.

## Convenciones

- **Montos en centavos (enteros).** Bs 150,50 se envía y recibe como `15050`. Evita errores de redondeo; el frontend formatea.
- **Fechas** `YYYY-MM-DD` en hora de Bolivia (UTC−4); los timestamps van en ISO.
- **Sucursal implícita:** cada usuario opera en su sucursal. Un ADMIN puede pasar `sucursalId` para operar en otra.
- **Errores** con forma `{ error: { codigo, mensaje, detalles } }`: `400 VALIDACION`, `401`, `403`, `404`, `409`, `422 REGLA_NEGOCIO`.
- Listados paginados con `?pagina=1&porPagina=50`.

## Roles y permisos

Las rutas piden **permisos**, no roles. Cada rol es un paquete de permisos definido en `src/lib/permisos.ts`: para ajustar qué hace un rol se cambia solo ese archivo. `POST /auth/login` y `GET /auth/me` devuelven `nombreRol` y `permisos`, y la app los usa para mostrar u ocultar pantallas; `GET /auth/roles` lista todos los roles. Un cambio de rol o una desactivación aplica en la siguiente petición, sin volver a iniciar sesión.

| Rol (`rol`) | Nombre | Qué hace |
|---|---|---|
| `SUPERADMIN` | Super administrador | **Absolutamente todo.** Exclusivo: auditoría (registro de eventos) y crear o modificar administradores y super administradores |
| `ADMIN` | Administrador | Todo lo demás: usuarios (no administradores), sucursales, otras sucursales, retiros del dueño |
| `ENCARGADO` | Encargado de sucursal | Todo lo operativo: catálogo, inventario (ajustes incluidos), anular ventas, cambiar precios, caja, laboratorio, reportes |
| `CAJERO` | Cajero | Caja (abrir, cerrar, gastos), vender y cobrar, cobrar saldos, entregar lentes pagados, pedidos web |
| `VENDEDOR` | Ejecutivo de ventas | Clientes y ventas **sin cobro**: la venta queda con saldo y la cobra caja. Entrega lentes pagados, pedidos web |
| `OPTOMETRISTA` | Optometrista | Clientes y recetas |
| `LABORATORIO` | Laboratorio | Órdenes de trabajo: pendiente → en laboratorio → listo |

Todos tienen sus propias **finanzas personales**, privadas.

Ingreso: 5 contraseñas incorrectas seguidas bloquean esa cuenta 15 minutos (también en la tienda), y cada conexión tiene un límite de intentos. Los bloqueos quedan en la auditoría.

Protecciones: nadie puede desactivarse ni cambiarse el rol a sí mismo; solo el super administrador gestiona cuentas de administrador; siempre debe quedar al menos un super administrador activo.

El primer usuario (`db:crear-admin`) es super administrador. En bases creadas antes de este rol, al arrancar el servidor (o al migrar) el administrador activo más antiguo pasa a ser super administrador.

## Mi panel (por rol)

`GET /panel` — lo primero que ve cada usuario, armado según su rol con datos del momento:

- **propósito** del rol y **responsabilidades** (definidos en `src/lib/guia-roles.ts`; también salen en `GET /auth/roles`);
- **tareas** de "qué hacer ahora", ordenadas por urgencia (`ALTA`, `MEDIA`, `INFO`, `OK`), cada una con la `pantalla` donde se resuelve;
- **indicadores** propios del rol.

| Rol | Ejemplos de tareas |
|---|---|
| Super administrador | Intentos negados hoy · caja cerrada · órdenes atrasadas · productos por reponer |
| Administrador / Encargado | Caja cerrada · órdenes atrasadas o que vencen hoy · productos por reponer · saldos por cobrar |
| Cajero | Abrir caja · ventas que esperan cobro · lentes listos con saldo o para entregar · cerrar caja |
| Ejecutivo de ventas | Clientes por avisar (lentes listos) · ventas suyas sin cobrar · órdenes suyas atrasadas |
| Optometrista | Registrar recetas · clientes nuevos del día |
| Laboratorio | Órdenes atrasadas · que vencen hoy · por empezar · en proceso |

## Registro de eventos (auditoría)

Cada operación que modifica datos queda registrada en la tabla `eventos`: quién, con qué rol (foto del momento), sucursal, módulo, una descripción legible ("Registró la venta V-MAT-000012 por Bs 750,00") y el resultado:

| Resultado | Cuándo |
|---|---|
| `EXITO` | La operación se hizo |
| `DENEGADO` | No tenía permiso (403) |
| `RECHAZADO` | Una regla de negocio la impidió (409/422), p. ej. caja ya abierta |
| `FALLIDO` | Intento de ingreso con credenciales incorrectas |
| `ERROR` | Falla del servidor |

No se registran consultas (GET), errores de validación ni las **finanzas personales** (son privadas). Nunca se guardan contraseñas ni el cuerpo de las peticiones.

- `GET /auditoria/resumen` — totales, actividad por rol (incluye roles sin actividad), por usuario, por módulo y por día, y últimos intentos negados
- `GET /auditoria/eventos` — lista paginada; filtros `desde`, `hasta` (últimos 7 días por defecto), `rol`, `usuarioId`, `sucursalId`, `modulo`, `resultado`, `q`

Solo con el permiso `auditoria.ver` (super administrador).

## Módulos y endpoints (`/api/v1`)

### Acceso
- `POST /auth/login` · `GET /auth/me` · `GET /auth/roles` · `POST /auth/cambiar-password`
- `GET|POST|PATCH /usuarios` (admin) · `GET|POST|PATCH /sucursales`

### Catálogo
- `GET|POST|PATCH /catalogo/marcas`, `/catalogo/proveedores`
- `GET /catalogo/productos` — filtros `q` (nombre, SKU, modelo, código de barras exacto), `tipo`, `marcaId`, `activo`, `bajoStock`; incluye stock de la sucursal
- `GET /catalogo/productos/:id` — ficha con existencias en todas las sucursales
- `POST /catalogo/productos` — admite `stockInicial: { cantidad, costoUnitario }` · `PATCH /catalogo/productos/:id`
- `PUT /catalogo/productos/:id/foto` — el cuerpo es la imagen (`Content-Type: image/jpeg`, png, webp o heic, hasta 12 MB); se guarda en **Cloudinary** y queda en `imagenUrl` · `DELETE /catalogo/productos/:id/foto`
- `DELETE /catalogo/productos/:id` — borra si nunca tuvo movimientos ni ventas; si tiene historial, lo desactiva
- Tipos: `MONTURA`, `LENTE_OFTALMICO`, `LENTE_CONTACTO`, `GAFAS_SOL`, `ACCESORIO`, `LIQUIDO`, `SERVICIO`. Atributos ópticos libres en `atributos` (género, material, forma, color, calibre/puente/varilla, índice, tratamiento…)

### Inventario
- `POST /inventario/entradas` — recepción de mercadería con costo; recalcula **costo promedio ponderado**
- `POST /inventario/salidas` — bajas (roturas, mermas) con motivo
- `POST /inventario/ajustes` — conteo físico: envías lo contado, el sistema ajusta la diferencia (admin)
- `POST /inventario/transferencias` — entre sucursales, atómico (admin)
- `GET /inventario/kardex/:productoId` — historial con stock resultante
- `GET /inventario/alertas` — lo que está en o bajo el mínimo
- `GET /inventario/valorizacion` — valor a costo y a precio de venta
- `PATCH /inventario/ubicacion/:productoId` — vitrina, cajón…

Todo cambio de stock pasa por un único servicio (`moverStock`) que bloquea la fila, impide stock negativo y deja rastro en el kardex.

### Clientes y recetas
- `GET|POST|PATCH /clientes` — búsqueda por nombre, CI, NIT o teléfono
- `GET /clientes/:id` — ficha con recetas, compras y **saldo pendiente**
- `POST|PATCH /clientes/:id/recetas[/:recetaId]` — OD/OI: esfera, cilindro, eje, adición, AV, DNP, altura focal. Valida pasos de 0,25 y que todo cilindro tenga eje

### Caja
- `POST /caja/abrir` (fondo inicial) · `GET /caja/actual` · `POST /caja/cerrar` (arqueo)
- `POST /caja/movimientos` — `GASTO`, `DEPOSITO`, `OTRO` o `RETIRO_DUENO`
- `GET /caja/sesiones` · `GET /caja/sesiones/:id`

Una caja abierta por sucursal. Al cerrar se declara el efectivo contado y el sistema calcula la **diferencia** contra lo esperado (apertura + ingresos − egresos en efectivo). QR, tarjeta y transferencia se reportan aparte para conciliar con el banco. No se puede sacar más efectivo del que hay.

### Ventas y laboratorio
- `POST /ventas` — ítems, descuento por línea y global, receta, pagos mixtos (efectivo + QR…), anticipo
- `GET /ventas` — filtros por fecha, cliente, estado, `conSaldo=true` (cuentas por cobrar)
- `GET /ventas/:id` · `POST /ventas/:id/pagos` (abonos) · `POST /ventas/:id/anular` (admin)
- `GET /ordenes-trabajo` — tablero del laboratorio, filtro `estado` y `atrasadas=true`
- `GET|PATCH /ordenes-trabajo/:id` · `POST /ordenes-trabajo/:id/estado`

Reglas: numeración correlativa por sucursal (`V-MAT-000001`, `OT-MAT-000001`); toda venta con lentes oftálmicos genera su **orden de trabajo** (`PENDIENTE → EN_LABORATORIO → LISTO → ENTREGADO`); **no se entregan lentes con saldo pendiente**; dejar saldo exige cliente; solo el admin cambia precios de lista; anular devuelve stock, reembolsa desde caja y cancela la orden (no si ya se entregó).

### Finanzas personales
- `GET|POST|PATCH /finanzas/cuentas` — efectivo, banco, billetera digital, tarjeta, ahorro; saldos calculados y patrimonio
- `GET|POST|PATCH /finanzas/categorias` — se crean categorías por defecto al crear el usuario
- `GET|POST|PATCH|DELETE /finanzas/transacciones` — ingreso, gasto, transferencia entre cuentas
- `GET|PUT /finanzas/presupuestos?mes=YYYY-MM` — tope mensual por categoría
- `GET /finanzas/resumen?mes=YYYY-MM` — ingresos, gastos, ahorro, tasa de ahorro, gasto vs presupuesto

**Puente negocio → bolsillo:** un `RETIRO_DUENO` de caja con `cuentaPersonalId` crea automáticamente el ingreso en la cuenta personal (categoría "Retiros del negocio"). Así el dueño ve cuánto vive del negocio sin mezclar las cuentas. Esas transacciones solo se corrigen desde la caja.

### Tienda web (clientes)

Lo que usa [`provision-frontend`](https://github.com/MasterCloud06/provision-frontend). Los clientes tienen **su propia cuenta** (`cuentas_tienda`), separada del personal: su token lleva la audiencia `tienda` y el sistema interno lo rechaza. Al registrarse se crea su ficha en `clientes`, así el personal lo ve como a cualquier cliente.

- Público: `GET /tienda/info` (sucursal, costo de envío, si hay pago en línea, categorías, marcas) · `GET /tienda/productos` (filtros `q`, `tipo`, `marcaId`, `genero`, `precioMin`, `precioMax`, `disponibles`, `orden`) · `GET /tienda/productos/:id` (con relacionados)
- Cuenta: `POST /tienda/auth/registro` · `POST /tienda/auth/login` · `GET|PATCH /tienda/cuenta` · `POST /tienda/cuenta/password` (devuelve un token nuevo y cierra las demás sesiones)
- Recuperar contraseña: `POST /tienda/auth/recuperar` `{ email }` (responde igual exista o no la cuenta) → correo con un enlace de un solo uso que vence en 1 hora → `POST /tienda/auth/restablecer` `{ token, password }` (cierra las demás sesiones e ingresa)
- Carrito (en el servidor): `GET /tienda/carrito` · `PUT /tienda/carrito/:productoId` `{ cantidad }` (0 quita) · `DELETE /tienda/carrito[/:productoId]` · `POST /tienda/carrito/fusionar` (lo que armó sin sesión)
- Pedidos: `POST /tienda/pedidos` `{ entrega: RETIRO|ENVIO, metodoPago: STRIPE|EN_TIENDA, … }` → `{ pedido, urlPago }` · `GET /tienda/pedidos[/:id]` · `POST /tienda/pedidos/:id/pagar` · `/verificar` · `/cancelar`
- Webhook: `POST /tienda/stripe/webhook`

Los clientes solo ven productos **activos** y con `visibleTienda = true` (por defecto todos), sin costos ni proveedores. Cada producto admite `imagenUrl` (una URL https) para la foto. El stock que se vende en línea es el de la sucursal `TIENDA_SUCURSAL_CODIGO` (o la primera).

**Reglas del pedido:** al confirmar, el stock se **reserva** (sale del inventario con el kardex `Pedido web W-MAT-000001`) y el carrito se vacía. Con tarjeta, el cliente paga en la página de **Stripe Checkout** (los datos de la tarjeta nunca pasan por nuestro servidor); si no paga en `TIENDA_MINUTOS_RESERVA` minutos, el pedido se cancela y el stock vuelve. Con *pago al retirar* la reserva dura `TIENDA_DIAS_RETIRO` días o hasta que el personal lo toma. El pago se confirma por el **webhook** de Stripe y, como respaldo, cuando el navegador vuelve de Stripe (`/verificar`). Si un pago llega después de vencida la reserva, se confirma igual y se reserva de nuevo (o queda una nota para el personal si ya no hay stock).

### Pedidos web (personal)
- `GET /pedidos-web?estado=POR_ATENDER|…&q=` · `GET /pedidos-web/:id` (con `siguientes`: los estados posibles)
- `GET /pedidos-web` también devuelve `conteos` por estado (y `POR_ATENDER`) para las pestañas de las apps
- `POST /pedidos-web/:id/estado` — `PAGADO → PREPARANDO → LISTO` (retiro) o `ENVIADO` (envío) `→ ENTREGADO`.
  - **Al entregar, el pedido se registra como venta** (`V-MAT-…`, con la nota del pedido): cuenta en reportes, margen y más vendidos. El stock no se vuelve a descontar.
  - **Pago al retirar:** al entregar se envía `pagos: [{ metodo, monto, referencia? }]` por el total y se cobra en la **caja abierta** (solo quien tiene `caja.operar`). `GET /pedidos-web/:id` indica `cobrarAlEntregar`.
  - **Pagado con tarjeta:** la venta queda pagada con la fecha del pago; ese dinero va al banco por Stripe, no a la caja.
- `POST /pedidos-web/:id/cancelar` `{ motivo }` — devuelve el stock y, si se pagó con tarjeta, **reembolsa en Stripe**
- `POST /pedidos-web/:id/notas` — notas internas (el cliente no las ve)

Permiso `tienda.gestionar`: administradores, encargado, cajero y ejecutivo de ventas. "Mi panel" les avisa cuántos pedidos web hay por preparar.

### Citas (examen de la vista)

Los clientes reservan desde la tienda web y el personal ve la agenda en el escritorio y la app.

- Tienda: `GET /tienda/citas/disponibilidad?desde&dias` (público: turnos libres) · `GET|POST /tienda/citas` · `POST /tienda/citas/:id/cancelar`. Cada cuenta puede tener hasta 2 citas por venir.
- Personal (`citas.gestionar`: administradores, encargado, cajero, ejecutivo de ventas y optometrista): `GET /citas?desde&hasta` (agenda; por defecto hoy) · `GET /citas/disponibilidad` · `GET /citas/config` · `POST /citas` (reserva por teléfono: queda confirmada y, si no tiene ficha, se le crea) · `POST /citas/:id/estado` (`CONFIRMADA`, `ATENDIDA`, `NO_ASISTIO`, `CANCELADA`; `nota` va a las notas internas).
- Reglas: no se puede reservar en el pasado, con menos de una hora de anticipación ni fuera del horario; cada turno admite `CITAS_CUPOS` citas a la vez (la reserva bloquea la sucursal para que dos personas no tomen el último cupo al mismo tiempo).
- "Mi panel" avisa las citas de hoy y las que falta confirmar.

| Variable | Por defecto |
|---|---|
| `CITAS_HORARIO` | `lun-vie 09:00-13:00 15:00-19:00; sab 09:00-13:00` |
| `CITAS_DURACION` | `30` (minutos) |
| `CITAS_CUPOS` | `1` (citas al mismo tiempo) |
| `CITAS_DIAS_ADELANTE` | `30` |

### Actualización obligatoria de las apps

Cada compilación del escritorio y de Android se publica en GitHub Releases con un número que siempre sube (`escritorio-41`, `v0.1.0-23`). El backend lee la última de cada una (`REPO_ESCRITORIO`, `REPO_ANDROID`, con caché de 5 minutos) y la publica en `GET /actualizaciones`.

Las apps envían `X-Provision-App: escritorio/41` (o `android/23`) en cada petición. Si es anterior a la última publicada, el backend responde **426 `ACTUALIZACION_REQUERIDA`** —también al ingresar— y la app muestra la pantalla para actualizar. No se bloquea: la tienda web, las compilaciones de desarrollo (número 0) ni a nadie si GitHub no responde. Para apagarlo: `ACTUALIZACION_OBLIGATORIA=false`. Si los repos fueran privados, define `GITHUB_TOKEN` (solo lectura); los celulares igual necesitan poder descargar la APK, por eso `provision-app` debe ser público.

### Correos a clientes (Resend)

Con `RESEND_API_KEY` la tienda envía correos: **recuperar contraseña**, **pedido recibido** (pago al retirar), **pago recibido** (tarjeta), **pedido listo para retirar / enviado**, **pedido cancelado** (con el motivo y si se devolvió el dinero) y **cita reservada**. Los correos nunca frenan ni hacen fallar la operación: si el envío falla, queda en el log. Sin la llave no se envía nada y "Olvidé mi contraseña" dice que se comuniquen con la óptica (`GET /tienda/info` → `recuperacionPorCorreo`).

1. Crea una cuenta en [resend.com](https://resend.com) y una **API Key** (`re_…`).
2. En Render: `RESEND_API_KEY` y, cuando verifiques tu dominio en Resend, `CORREO_REMITENTE` (p. ej. `Óptica Provisión <tienda@tudominio.bo>`).
3. Sin dominio verificado, Resend solo deja enviar desde `onboarding@resend.dev` **y solo a tu propio correo**: sirve para probar, no para clientes reales.

### Fotos (Cloudinary)

Render borra los archivos subidos en cada reinicio, por eso las fotos van a **Cloudinary**. En su dashboard (*Settings → API Keys*) copia la **API environment variable** (`cloudinary://API_KEY:API_SECRET@CLOUD_NAME`) y ponla en Render como `CLOUDINARY_URL`. Las fotos se guardan en la carpeta `provision-dev/productos/` (o `provision-local/` desde tu PC), una por producto, reducidas a 1600 px como máximo. Sin `CLOUDINARY_URL` todo funciona, pero subir una foto responde que falta configurarlo.

### Stripe

Sin `STRIPE_SECRET_KEY` la tienda funciona igual, pero solo con **pago al retirar**. Para activar el pago con tarjeta:

1. En el [dashboard de Stripe](https://dashboard.stripe.com/test/apikeys), en **modo de prueba**, copia la *Secret key* (`sk_test_…`).
2. En **Developers → Webhooks → Add endpoint**: URL `https://TU-API/api/v1/tienda/stripe/webhook`, eventos `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded` y `checkout.session.async_payment_failed`. Copia el *Signing secret* (`whsec_…`).
3. En Render (*Environment*): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` y `TIENDA_URL` (la dirección de la tienda). Agrega también la tienda a `CORS_ORIGIN`.
4. Prueba con la tarjeta `4242 4242 4242 4242`, cualquier fecha futura y cualquier CVC. Para producción, cambia a las llaves `sk_live_…` y crea el webhook en modo *live*.

Para probar el webhook en local: `stripe listen --forward-to localhost:3000/api/v1/tienda/stripe/webhook` (Stripe CLI) y usa el `whsec_…` que imprime. Sin webhook también funciona: la tienda verifica el pago al volver de Stripe.

`STRIPE_MONEDA` es `bob` por defecto (bolivianos, sin conversión). Si tu cuenta de Stripe cobra en otra moneda, por ejemplo `usd`, define `STRIPE_TIPO_CAMBIO` (bolivianos por dólar, p. ej. `6.96`) y los precios se convierten al crear el pago.

### Reportes
- `GET /reportes/dashboard?desde&hasta` — ventas de hoy y del periodo, ticket promedio, margen bruto (a costo promedio), cuentas por cobrar, órdenes por estado, productos bajo stock, top productos, ventas por día y por vendedor

## Estructura

```
src/
  app.ts               # arma Express y monta los módulos
  db/schema/           # tablas Drizzle (core, inventario, clientes, ventas+caja, finanzas)
  db/crear-admin.ts    # primera sucursal + administrador (sin datos de ejemplo)
  lib/                 # errores, validación, fechas, correlativos
  middleware/          # autenticación/roles y manejo de errores
  modules/<módulo>/    # routes.ts (HTTP) + servicio.ts (reglas de negocio transaccionales)
drizzle/               # migraciones SQL generadas
tests/                 # flujo completo sobre PGlite
```

Para cambiar el esquema: edita `src/db/schema`, luego `npm run db:generate`, `npm run db:migrate` y, cuando esté listo, `npm run db:migrate:desarrollo`.

## Pendiente / siguientes pasos

- Compras formales a proveedores (órdenes de compra, cuentas por pagar)
- Facturación SIAT (Impuestos Nacionales)
- Devoluciones parciales y cambios de producto
- Recordatorios a clientes (control anual, lentes listos) por WhatsApp
- Exportación de reportes a Excel/PDF
- Tienda: recuperar contraseña por correo, correos de confirmación, y llevar los pedidos web a los reportes de ventas

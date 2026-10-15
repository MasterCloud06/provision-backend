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
| `CAJERO` | Cajero | Caja (abrir, cerrar, gastos), vender y cobrar, cobrar saldos, entregar lentes pagados |
| `VENDEDOR` | Ejecutivo de ventas | Clientes y ventas **sin cobro**: la venta queda con saldo y la cobra caja. Entrega lentes pagados |
| `OPTOMETRISTA` | Optometrista | Clientes y recetas |
| `LABORATORIO` | Laboratorio | Órdenes de trabajo: pendiente → en laboratorio → listo |

Todos tienen sus propias **finanzas personales**, privadas.

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

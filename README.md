# Provisión · Backend

API para ópticas: **inventario, caja, ventas y finanzas personales** del dueño, pensada para el día a día real de una óptica en Bolivia: lentes que se encargan con anticipo, órdenes de laboratorio, cobros en efectivo/QR/tarjeta y arqueo de caja por turno.

**Stack:** Node 20+ · TypeScript · Express 5 · PostgreSQL · Drizzle ORM · Zod · JWT. Los tests corren sobre un Postgres embebido (PGlite), sin instalar nada.

## Puesta en marcha

```bash
cp .env.example .env          # ajusta JWT_SECRET y la contraseña del admin
docker compose up -d          # Postgres 17 en localhost:5432
npm install
npm run db:migrate            # crea las tablas
npm run db:seed               # sucursal "Casa matriz", admin y productos de ejemplo
npm run dev                   # http://localhost:3000/api/v1
npm test                      # flujo completo de punta a punta
```

Ingreso inicial: `admin@provision.bo` / `Provision2026!` (cámbialo con `POST /auth/cambiar-password`).

## Convenciones

- **Montos en centavos (enteros).** Bs 150,50 se envía y recibe como `15050`. Evita errores de redondeo; el frontend formatea.
- **Fechas** `YYYY-MM-DD` en hora de Bolivia (UTC−4); los timestamps van en ISO.
- **Sucursal implícita:** cada usuario opera en su sucursal. Un ADMIN puede pasar `sucursalId` para operar en otra.
- **Errores** con forma `{ error: { codigo, mensaje, detalles } }`: `400 VALIDACION`, `401`, `403`, `404`, `409`, `422 REGLA_NEGOCIO`.
- Listados paginados con `?pagina=1&porPagina=50`.

## Roles

| Rol | Puede |
|---|---|
| `ADMIN` | Todo: usuarios, sucursales, catálogo, ajustes de inventario, transferencias, anular ventas, cambiar precios, retiros del dueño |
| `VENDEDOR` | Vender, cobrar, abrir/cerrar caja, gastos de caja, recepción y bajas de inventario, clientes |
| `LABORATORIO` | Ver y avanzar órdenes de trabajo, consultar catálogo y clientes |

Todos tienen sus propias **finanzas personales**, privadas.

## Módulos y endpoints (`/api/v1`)

### Acceso
- `POST /auth/login` · `GET /auth/me` · `POST /auth/cambiar-password`
- `GET|POST|PATCH /usuarios` (admin) · `GET|POST|PATCH /sucursales`

### Catálogo
- `GET|POST|PATCH /catalogo/marcas`, `/catalogo/proveedores`
- `GET /catalogo/productos` — filtros `q` (nombre, SKU, modelo, código de barras exacto), `tipo`, `marcaId`, `activo`, `bajoStock`; incluye stock de la sucursal
- `GET /catalogo/productos/:id` — ficha con existencias en todas las sucursales
- `POST /catalogo/productos` — admite `stockInicial: { cantidad, costoUnitario }`
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
  db/seed.ts           # datos iniciales idempotentes
  lib/                 # errores, validación, fechas, correlativos
  middleware/          # autenticación/roles y manejo de errores
  modules/<módulo>/    # routes.ts (HTTP) + servicio.ts (reglas de negocio transaccionales)
drizzle/               # migraciones SQL generadas
tests/                 # flujo completo sobre PGlite
```

Para cambiar el esquema: edita `src/db/schema`, luego `npm run db:generate` y `npm run db:migrate`.

## Pendiente / siguientes pasos

- Compras formales a proveedores (órdenes de compra, cuentas por pagar)
- Facturación SIAT (Impuestos Nacionales)
- Devoluciones parciales y cambios de producto
- Recordatorios a clientes (control anual, lentes listos) por WhatsApp
- Exportación de reportes a Excel/PDF

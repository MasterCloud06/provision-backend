CREATE TYPE "public"."concepto_caja" AS ENUM('COBRO_VENTA', 'DEVOLUCION', 'GASTO', 'RETIRO_DUENO', 'DEPOSITO', 'OTRO');--> statement-breakpoint
CREATE TYPE "public"."estado_pago" AS ENUM('PENDIENTE', 'PARCIAL', 'PAGADA');--> statement-breakpoint
CREATE TYPE "public"."estado_sesion_caja" AS ENUM('ABIERTA', 'CERRADA');--> statement-breakpoint
CREATE TYPE "public"."estado_trabajo" AS ENUM('PENDIENTE', 'EN_LABORATORIO', 'LISTO', 'ENTREGADO', 'CANCELADO');--> statement-breakpoint
CREATE TYPE "public"."estado_venta" AS ENUM('ACTIVA', 'ANULADA');--> statement-breakpoint
CREATE TYPE "public"."metodo_pago" AS ENUM('EFECTIVO', 'QR', 'TARJETA', 'TRANSFERENCIA');--> statement-breakpoint
CREATE TYPE "public"."rol_usuario" AS ENUM('ADMIN', 'VENDEDOR', 'LABORATORIO');--> statement-breakpoint
CREATE TYPE "public"."tipo_categoria_personal" AS ENUM('INGRESO', 'GASTO');--> statement-breakpoint
CREATE TYPE "public"."tipo_cuenta_personal" AS ENUM('EFECTIVO', 'BANCO', 'BILLETERA_DIGITAL', 'TARJETA_CREDITO', 'AHORRO');--> statement-breakpoint
CREATE TYPE "public"."tipo_movimiento_caja" AS ENUM('INGRESO', 'EGRESO');--> statement-breakpoint
CREATE TYPE "public"."tipo_movimiento_inventario" AS ENUM('ENTRADA', 'SALIDA', 'AJUSTE', 'VENTA', 'DEVOLUCION_VENTA', 'TRANSFERENCIA_SALIDA', 'TRANSFERENCIA_ENTRADA');--> statement-breakpoint
CREATE TYPE "public"."tipo_producto" AS ENUM('MONTURA', 'LENTE_OFTALMICO', 'LENTE_CONTACTO', 'GAFAS_SOL', 'ACCESORIO', 'LIQUIDO', 'SERVICIO');--> statement-breakpoint
CREATE TYPE "public"."tipo_transaccion_personal" AS ENUM('INGRESO', 'GASTO', 'TRANSFERENCIA');--> statement-breakpoint
CREATE TABLE "correlativos" (
	"sucursal_id" uuid NOT NULL,
	"serie" varchar(10) NOT NULL,
	"ultimo" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "correlativos_sucursal_id_serie_pk" PRIMARY KEY("sucursal_id","serie")
);
--> statement-breakpoint
CREATE TABLE "sucursales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" varchar(120) NOT NULL,
	"codigo" varchar(10) NOT NULL,
	"direccion" text,
	"telefono" varchar(40),
	"activa" boolean DEFAULT true NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sucursales_codigo_unique" UNIQUE("codigo")
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" varchar(120) NOT NULL,
	"email" varchar(160) NOT NULL,
	"password_hash" text NOT NULL,
	"rol" "rol_usuario" DEFAULT 'VENDEDOR' NOT NULL,
	"sucursal_id" uuid,
	"activo" boolean DEFAULT true NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuarios_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "marcas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" varchar(80) NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marcas_nombre_unique" UNIQUE("nombre")
);
--> statement-breakpoint
CREATE TABLE "movimientos_inventario" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producto_id" uuid NOT NULL,
	"sucursal_id" uuid NOT NULL,
	"tipo" "tipo_movimiento_inventario" NOT NULL,
	"cantidad" integer NOT NULL,
	"stock_resultante" integer NOT NULL,
	"costo_unitario" integer,
	"motivo" text,
	"referencia_tipo" varchar(30),
	"referencia_id" uuid,
	"usuario_id" uuid,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "productos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" varchar(40) NOT NULL,
	"codigo_barras" varchar(64),
	"nombre" varchar(160) NOT NULL,
	"descripcion" text,
	"tipo" "tipo_producto" NOT NULL,
	"marca_id" uuid,
	"proveedor_id" uuid,
	"modelo" varchar(80),
	"atributos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"precio_venta" integer NOT NULL,
	"costo_promedio" integer DEFAULT 0 NOT NULL,
	"stock_minimo" integer DEFAULT 0 NOT NULL,
	"controla_stock" boolean DEFAULT true NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "productos_sku_unique" UNIQUE("sku"),
	CONSTRAINT "productos_codigoBarras_unique" UNIQUE("codigo_barras"),
	CONSTRAINT "productos_precio_positivo" CHECK ("productos"."precio_venta" >= 0)
);
--> statement-breakpoint
CREATE TABLE "proveedores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" varchar(120) NOT NULL,
	"nit" varchar(30),
	"contacto" varchar(120),
	"telefono" varchar(40),
	"email" varchar(160),
	"activo" boolean DEFAULT true NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock" (
	"producto_id" uuid NOT NULL,
	"sucursal_id" uuid NOT NULL,
	"cantidad" integer DEFAULT 0 NOT NULL,
	"ubicacion" varchar(60),
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_producto_id_sucursal_id_pk" PRIMARY KEY("producto_id","sucursal_id"),
	CONSTRAINT "stock_no_negativo" CHECK ("stock"."cantidad" >= 0)
);
--> statement-breakpoint
CREATE TABLE "clientes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" varchar(160) NOT NULL,
	"ci" varchar(30),
	"nit" varchar(30),
	"telefono" varchar(40),
	"email" varchar(160),
	"fecha_nacimiento" date,
	"direccion" text,
	"notas" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recetas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"fecha" date NOT NULL,
	"profesional" varchar(120),
	"od_esfera" numeric(5, 2),
	"od_cilindro" numeric(5, 2),
	"od_eje" integer,
	"od_adicion" numeric(5, 2),
	"od_agudeza_visual" varchar(20),
	"oi_esfera" numeric(5, 2),
	"oi_cilindro" numeric(5, 2),
	"oi_eje" integer,
	"oi_adicion" numeric(5, 2),
	"oi_agudeza_visual" varchar(20),
	"dnp_od" numeric(4, 1),
	"dnp_oi" numeric(4, 1),
	"altura_focal" numeric(4, 1),
	"uso_recomendado" varchar(60),
	"observaciones" text,
	"registrado_por" uuid,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "historial_trabajo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orden_id" uuid NOT NULL,
	"estado_anterior" "estado_trabajo",
	"estado_nuevo" "estado_trabajo" NOT NULL,
	"nota" text,
	"usuario_id" uuid,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "movimientos_caja" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sesion_caja_id" uuid NOT NULL,
	"tipo" "tipo_movimiento_caja" NOT NULL,
	"concepto" "concepto_caja" NOT NULL,
	"metodo" "metodo_pago" NOT NULL,
	"monto" integer NOT NULL,
	"descripcion" text,
	"venta_id" uuid,
	"pago_id" uuid,
	"usuario_id" uuid NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mov_caja_positivo" CHECK ("movimientos_caja"."monto" > 0)
);
--> statement-breakpoint
CREATE TABLE "ordenes_trabajo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" varchar(30) NOT NULL,
	"venta_id" uuid NOT NULL,
	"sucursal_id" uuid NOT NULL,
	"receta_id" uuid,
	"estado" "estado_trabajo" DEFAULT 'PENDIENTE' NOT NULL,
	"fecha_prometida" date,
	"instrucciones" text,
	"laboratorio_externo" varchar(120),
	"entregado_en" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ordenes_trabajo_numero_unique" UNIQUE("numero")
);
--> statement-breakpoint
CREATE TABLE "pagos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venta_id" uuid NOT NULL,
	"sesion_caja_id" uuid NOT NULL,
	"metodo" "metodo_pago" NOT NULL,
	"monto" integer NOT NULL,
	"referencia" varchar(80),
	"usuario_id" uuid NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pago_positivo" CHECK ("pagos"."monto" > 0)
);
--> statement-breakpoint
CREATE TABLE "sesiones_caja" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sucursal_id" uuid NOT NULL,
	"estado" "estado_sesion_caja" DEFAULT 'ABIERTA' NOT NULL,
	"abierta_por" uuid NOT NULL,
	"abierta_en" timestamp with time zone DEFAULT now() NOT NULL,
	"monto_apertura" integer NOT NULL,
	"cerrada_por" uuid,
	"cerrada_en" timestamp with time zone,
	"efectivo_esperado" integer,
	"efectivo_contado" integer,
	"diferencia" integer,
	"observaciones" text,
	CONSTRAINT "apertura_no_negativa" CHECK ("sesiones_caja"."monto_apertura" >= 0)
);
--> statement-breakpoint
CREATE TABLE "venta_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venta_id" uuid NOT NULL,
	"producto_id" uuid NOT NULL,
	"descripcion" varchar(200) NOT NULL,
	"cantidad" integer NOT NULL,
	"precio_unitario" integer NOT NULL,
	"descuento" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"costo_unitario" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "item_cantidad" CHECK ("venta_items"."cantidad" > 0)
);
--> statement-breakpoint
CREATE TABLE "ventas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" varchar(30) NOT NULL,
	"sucursal_id" uuid NOT NULL,
	"cliente_id" uuid,
	"vendedor_id" uuid NOT NULL,
	"receta_id" uuid,
	"estado" "estado_venta" DEFAULT 'ACTIVA' NOT NULL,
	"estado_pago" "estado_pago" DEFAULT 'PENDIENTE' NOT NULL,
	"subtotal" integer NOT NULL,
	"descuento" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"pagado" integer DEFAULT 0 NOT NULL,
	"saldo" integer NOT NULL,
	"notas" text,
	"anulada_por" uuid,
	"anulada_en" timestamp with time zone,
	"motivo_anulacion" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ventas_numero_unique" UNIQUE("numero"),
	CONSTRAINT "ventas_montos" CHECK ("ventas"."total" >= 0 AND "ventas"."pagado" >= 0 AND "ventas"."descuento" >= 0)
);
--> statement-breakpoint
CREATE TABLE "categorias_personales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"nombre" varchar(60) NOT NULL,
	"tipo" "tipo_categoria_personal" NOT NULL,
	"icono" varchar(40),
	"archivada" boolean DEFAULT false NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categoria_nombre_por_usuario" UNIQUE("usuario_id","tipo","nombre")
);
--> statement-breakpoint
CREATE TABLE "cuentas_personales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"nombre" varchar(80) NOT NULL,
	"tipo" "tipo_cuenta_personal" NOT NULL,
	"saldo_inicial" integer DEFAULT 0 NOT NULL,
	"color" varchar(9),
	"archivada" boolean DEFAULT false NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cuenta_nombre_por_usuario" UNIQUE("usuario_id","nombre")
);
--> statement-breakpoint
CREATE TABLE "presupuestos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"categoria_id" uuid NOT NULL,
	"mes" varchar(7) NOT NULL,
	"monto" integer NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presupuesto_unico" UNIQUE("usuario_id","categoria_id","mes"),
	CONSTRAINT "presupuesto_mes_formato" CHECK ("presupuestos"."mes" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "transacciones_personales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"tipo" "tipo_transaccion_personal" NOT NULL,
	"cuenta_id" uuid NOT NULL,
	"cuenta_destino_id" uuid,
	"categoria_id" uuid,
	"monto" integer NOT NULL,
	"fecha" date NOT NULL,
	"descripcion" text,
	"movimiento_caja_id" uuid,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tx_monto_positivo" CHECK ("transacciones_personales"."monto" > 0),
	CONSTRAINT "tx_transferencia_destino" CHECK (("transacciones_personales"."tipo" = 'TRANSFERENCIA') = ("transacciones_personales"."cuenta_destino_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "correlativos" ADD CONSTRAINT "correlativos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productos" ADD CONSTRAINT "productos_marca_id_marcas_id_fk" FOREIGN KEY ("marca_id") REFERENCES "public"."marcas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productos" ADD CONSTRAINT "productos_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recetas" ADD CONSTRAINT "recetas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recetas" ADD CONSTRAINT "recetas_registrado_por_usuarios_id_fk" FOREIGN KEY ("registrado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historial_trabajo" ADD CONSTRAINT "historial_trabajo_orden_id_ordenes_trabajo_id_fk" FOREIGN KEY ("orden_id") REFERENCES "public"."ordenes_trabajo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historial_trabajo" ADD CONSTRAINT "historial_trabajo_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_caja" ADD CONSTRAINT "movimientos_caja_sesion_caja_id_sesiones_caja_id_fk" FOREIGN KEY ("sesion_caja_id") REFERENCES "public"."sesiones_caja"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_caja" ADD CONSTRAINT "movimientos_caja_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_caja" ADD CONSTRAINT "movimientos_caja_pago_id_pagos_id_fk" FOREIGN KEY ("pago_id") REFERENCES "public"."pagos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimientos_caja" ADD CONSTRAINT "movimientos_caja_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordenes_trabajo" ADD CONSTRAINT "ordenes_trabajo_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordenes_trabajo" ADD CONSTRAINT "ordenes_trabajo_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ordenes_trabajo" ADD CONSTRAINT "ordenes_trabajo_receta_id_recetas_id_fk" FOREIGN KEY ("receta_id") REFERENCES "public"."recetas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_sesion_caja_id_sesiones_caja_id_fk" FOREIGN KEY ("sesion_caja_id") REFERENCES "public"."sesiones_caja"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones_caja" ADD CONSTRAINT "sesiones_caja_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones_caja" ADD CONSTRAINT "sesiones_caja_abierta_por_usuarios_id_fk" FOREIGN KEY ("abierta_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones_caja" ADD CONSTRAINT "sesiones_caja_cerrada_por_usuarios_id_fk" FOREIGN KEY ("cerrada_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_vendedor_id_usuarios_id_fk" FOREIGN KEY ("vendedor_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_receta_id_recetas_id_fk" FOREIGN KEY ("receta_id") REFERENCES "public"."recetas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_anulada_por_usuarios_id_fk" FOREIGN KEY ("anulada_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorias_personales" ADD CONSTRAINT "categorias_personales_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cuentas_personales" ADD CONSTRAINT "cuentas_personales_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_categoria_id_categorias_personales_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias_personales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacciones_personales" ADD CONSTRAINT "transacciones_personales_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacciones_personales" ADD CONSTRAINT "transacciones_personales_cuenta_id_cuentas_personales_id_fk" FOREIGN KEY ("cuenta_id") REFERENCES "public"."cuentas_personales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacciones_personales" ADD CONSTRAINT "transacciones_personales_cuenta_destino_id_cuentas_personales_id_fk" FOREIGN KEY ("cuenta_destino_id") REFERENCES "public"."cuentas_personales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacciones_personales" ADD CONSTRAINT "transacciones_personales_categoria_id_categorias_personales_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias_personales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacciones_personales" ADD CONSTRAINT "transacciones_personales_movimiento_caja_id_movimientos_caja_id_fk" FOREIGN KEY ("movimiento_caja_id") REFERENCES "public"."movimientos_caja"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mov_inv_producto_idx" ON "movimientos_inventario" USING btree ("producto_id","creado_en");--> statement-breakpoint
CREATE INDEX "mov_inv_referencia_idx" ON "movimientos_inventario" USING btree ("referencia_tipo","referencia_id");--> statement-breakpoint
CREATE INDEX "productos_tipo_idx" ON "productos" USING btree ("tipo");--> statement-breakpoint
CREATE INDEX "productos_marca_idx" ON "productos" USING btree ("marca_id");--> statement-breakpoint
CREATE INDEX "clientes_nombre_idx" ON "clientes" USING btree ("nombre");--> statement-breakpoint
CREATE INDEX "clientes_ci_idx" ON "clientes" USING btree ("ci");--> statement-breakpoint
CREATE INDEX "recetas_cliente_idx" ON "recetas" USING btree ("cliente_id","fecha");--> statement-breakpoint
CREATE INDEX "mov_caja_sesion_idx" ON "movimientos_caja" USING btree ("sesion_caja_id");--> statement-breakpoint
CREATE INDEX "ot_estado_idx" ON "ordenes_trabajo" USING btree ("sucursal_id","estado");--> statement-breakpoint
CREATE INDEX "pagos_venta_idx" ON "pagos" USING btree ("venta_id");--> statement-breakpoint
CREATE UNIQUE INDEX "una_caja_abierta_por_sucursal" ON "sesiones_caja" USING btree ("sucursal_id") WHERE "sesiones_caja"."estado" = 'ABIERTA';--> statement-breakpoint
CREATE INDEX "venta_items_venta_idx" ON "venta_items" USING btree ("venta_id");--> statement-breakpoint
CREATE INDEX "ventas_sucursal_fecha_idx" ON "ventas" USING btree ("sucursal_id","creado_en");--> statement-breakpoint
CREATE INDEX "ventas_cliente_idx" ON "ventas" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "tx_personal_usuario_fecha_idx" ON "transacciones_personales" USING btree ("usuario_id","fecha");
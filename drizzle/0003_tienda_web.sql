CREATE TYPE "public"."entrega_pedido_web" AS ENUM('RETIRO', 'ENVIO');--> statement-breakpoint
CREATE TYPE "public"."estado_pedido_web" AS ENUM('PENDIENTE_PAGO', 'PAGADO', 'PREPARANDO', 'LISTO', 'ENVIADO', 'ENTREGADO', 'CANCELADO');--> statement-breakpoint
CREATE TYPE "public"."metodo_pago_web" AS ENUM('STRIPE', 'EN_TIENDA');--> statement-breakpoint
CREATE TABLE "carrito_items" (
	"cuenta_id" uuid NOT NULL,
	"producto_id" uuid NOT NULL,
	"cantidad" integer NOT NULL,
	"agregado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carrito_items_cuenta_id_producto_id_pk" PRIMARY KEY("cuenta_id","producto_id"),
	CONSTRAINT "carrito_cantidad_positiva" CHECK ("carrito_items"."cantidad" > 0)
);
--> statement-breakpoint
CREATE TABLE "cuentas_tienda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"email" varchar(160) NOT NULL,
	"password_hash" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cuentas_tienda_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "pedido_web_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pedido_id" uuid NOT NULL,
	"producto_id" uuid NOT NULL,
	"nombre" varchar(160) NOT NULL,
	"precio_unitario" integer NOT NULL,
	"cantidad" integer NOT NULL,
	"subtotal" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pedidos_web" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" varchar(30) NOT NULL,
	"cuenta_id" uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"sucursal_id" uuid NOT NULL,
	"estado" "estado_pedido_web" DEFAULT 'PENDIENTE_PAGO' NOT NULL,
	"metodo_pago" "metodo_pago_web" NOT NULL,
	"entrega" "entrega_pedido_web" NOT NULL,
	"nombre_contacto" varchar(160) NOT NULL,
	"telefono" varchar(40) NOT NULL,
	"direccion" text,
	"ciudad" varchar(80),
	"notas" text,
	"subtotal" integer NOT NULL,
	"costo_envio" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"expira_en" timestamp with time zone,
	"stripe_session_id" varchar(255),
	"stripe_payment_intent" varchar(255),
	"pagado_en" timestamp with time zone,
	"notas_internas" text,
	"cancelado_motivo" text,
	"atendido_por" uuid,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pedidos_web_numero_unique" UNIQUE("numero"),
	CONSTRAINT "pedidos_web_total" CHECK ("pedidos_web"."total" = "pedidos_web"."subtotal" + "pedidos_web"."costo_envio")
);
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "imagen_url" text;--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "visible_tienda" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "carrito_items" ADD CONSTRAINT "carrito_items_cuenta_id_cuentas_tienda_id_fk" FOREIGN KEY ("cuenta_id") REFERENCES "public"."cuentas_tienda"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrito_items" ADD CONSTRAINT "carrito_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cuentas_tienda" ADD CONSTRAINT "cuentas_tienda_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedido_web_items" ADD CONSTRAINT "pedido_web_items_pedido_id_pedidos_web_id_fk" FOREIGN KEY ("pedido_id") REFERENCES "public"."pedidos_web"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedido_web_items" ADD CONSTRAINT "pedido_web_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedidos_web" ADD CONSTRAINT "pedidos_web_cuenta_id_cuentas_tienda_id_fk" FOREIGN KEY ("cuenta_id") REFERENCES "public"."cuentas_tienda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedidos_web" ADD CONSTRAINT "pedidos_web_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedidos_web" ADD CONSTRAINT "pedidos_web_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedidos_web" ADD CONSTRAINT "pedidos_web_atendido_por_usuarios_id_fk" FOREIGN KEY ("atendido_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pedidos_web_cuenta_idx" ON "pedidos_web" USING btree ("cuenta_id","creado_en");--> statement-breakpoint
CREATE INDEX "pedidos_web_estado_idx" ON "pedidos_web" USING btree ("estado");--> statement-breakpoint
CREATE INDEX "pedidos_web_stripe_idx" ON "pedidos_web" USING btree ("stripe_session_id");
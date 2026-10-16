CREATE TYPE "public"."estado_cita" AS ENUM('PENDIENTE', 'CONFIRMADA', 'ATENDIDA', 'NO_ASISTIO', 'CANCELADA');--> statement-breakpoint
CREATE TYPE "public"."motivo_cita" AS ENUM('EXAMEN_VISTA', 'CONTROL', 'LENTES_CONTACTO', 'AJUSTE', 'OTRO');--> statement-breakpoint
CREATE TABLE "citas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sucursal_id" uuid NOT NULL,
	"cliente_id" uuid,
	"cuenta_id" uuid,
	"fecha" date NOT NULL,
	"hora" varchar(5) NOT NULL,
	"duracion" integer NOT NULL,
	"motivo" "motivo_cita" DEFAULT 'EXAMEN_VISTA' NOT NULL,
	"estado" "estado_cita" DEFAULT 'PENDIENTE' NOT NULL,
	"nombre_contacto" varchar(160) NOT NULL,
	"telefono" varchar(40) NOT NULL,
	"notas" text,
	"notas_internas" text,
	"cancelada_motivo" text,
	"creada_por" uuid,
	"atendida_por" uuid,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "citas" ADD CONSTRAINT "citas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citas" ADD CONSTRAINT "citas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citas" ADD CONSTRAINT "citas_cuenta_id_cuentas_tienda_id_fk" FOREIGN KEY ("cuenta_id") REFERENCES "public"."cuentas_tienda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citas" ADD CONSTRAINT "citas_creada_por_usuarios_id_fk" FOREIGN KEY ("creada_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citas" ADD CONSTRAINT "citas_atendida_por_usuarios_id_fk" FOREIGN KEY ("atendida_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "citas_agenda_idx" ON "citas" USING btree ("sucursal_id","fecha","hora");--> statement-breakpoint
CREATE INDEX "citas_cuenta_idx" ON "citas" USING btree ("cuenta_id");
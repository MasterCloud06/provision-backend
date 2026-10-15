CREATE TYPE "public"."resultado_evento" AS ENUM('EXITO', 'DENEGADO', 'RECHAZADO', 'FALLIDO', 'ERROR');--> statement-breakpoint
ALTER TYPE "public"."rol_usuario" ADD VALUE 'SUPERADMIN';--> statement-breakpoint
CREATE TABLE "eventos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" uuid,
	"usuario_nombre" varchar(160),
	"rol" "rol_usuario",
	"sucursal_id" uuid,
	"modulo" varchar(30) NOT NULL,
	"accion" varchar(80) NOT NULL,
	"descripcion" text NOT NULL,
	"resultado" "resultado_evento" NOT NULL,
	"entidad_id" uuid,
	"metodo" varchar(8) NOT NULL,
	"ruta" varchar(200) NOT NULL,
	"ip" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "eventos" ADD CONSTRAINT "eventos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos" ADD CONSTRAINT "eventos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eventos_fecha_idx" ON "eventos" USING btree ("creado_en");--> statement-breakpoint
CREATE INDEX "eventos_usuario_idx" ON "eventos" USING btree ("usuario_id","creado_en");--> statement-breakpoint
CREATE INDEX "eventos_rol_idx" ON "eventos" USING btree ("rol","creado_en");
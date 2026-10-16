CREATE TABLE "recuperaciones_tienda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cuenta_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expira_en" timestamp with time zone NOT NULL,
	"usado_en" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recuperaciones_tienda_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "cuentas_tienda" ADD COLUMN "sesiones_desde" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recuperaciones_tienda" ADD CONSTRAINT "recuperaciones_tienda_cuenta_id_cuentas_tienda_id_fk" FOREIGN KEY ("cuenta_id") REFERENCES "public"."cuentas_tienda"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recuperaciones_cuenta_idx" ON "recuperaciones_tienda" USING btree ("cuenta_id");
/**
 * Datos iniciales: una sucursal, el administrador y algunas marcas y productos de ejemplo.
 * Es idempotente: si el administrador ya existe, no hace nada.
 */
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { crearCategoriasPorDefecto } from '../modules/finanzas/servicio.js';
import { moverStock } from '../modules/inventario/servicio.js';
import { crearDb, type DB } from './client.js';
import { marcas, productos, sucursales, usuarios } from './schema/index.js';

export async function sembrar(db: DB, opciones = { ejemplos: true }) {
  const [existe] = await db.select().from(usuarios).where(eq(usuarios.email, env.ADMIN_EMAIL));
  if (existe) return { admin: existe, creado: false };

  return db.transaction(async (tx) => {
    const [sucursal] = await tx
      .insert(sucursales)
      .values({ nombre: 'Casa matriz', codigo: 'MAT' })
      .returning();
    const [admin] = await tx
      .insert(usuarios)
      .values({
        nombre: 'Administrador',
        email: env.ADMIN_EMAIL,
        passwordHash: await bcrypt.hash(env.ADMIN_PASSWORD, 10),
        rol: 'ADMIN',
        sucursalId: sucursal!.id,
      })
      .returning();
    await crearCategoriasPorDefecto(tx, admin!.id);

    if (opciones.ejemplos) {
      const ms = await tx
        .insert(marcas)
        .values([{ nombre: 'Ray-Ban' }, { nombre: 'Vitaly' }, { nombre: 'Essilor' }])
        .returning();
      const [rayban, vitaly, essilor] = ms;
      const ejemplos = await tx
        .insert(productos)
        .values([
          {
            sku: 'MON-RB5154-NEG',
            nombre: 'Montura Clubmaster negro',
            tipo: 'MONTURA',
            marcaId: rayban!.id,
            modelo: 'RB5154',
            atributos: { genero: 'UNISEX', material: 'acetato', forma: 'clubmaster', color: 'negro', calibre: 51, puente: 21, varilla: 145 },
            precioVenta: 120000,
            stockMinimo: 2,
          },
          {
            sku: 'MON-VIT-2201-CAR',
            nombre: 'Montura Vitaly 2201 carey',
            tipo: 'MONTURA',
            marcaId: vitaly!.id,
            modelo: '2201',
            atributos: { genero: 'MUJER', material: 'acetato', forma: 'cat-eye', color: 'carey', calibre: 52, puente: 18, varilla: 140 },
            precioVenta: 45000,
            stockMinimo: 3,
          },
          {
            sku: 'LEN-156-AR',
            nombre: 'Lente monofocal 1.56 antirreflejo (par)',
            tipo: 'LENTE_OFTALMICO',
            marcaId: essilor!.id,
            atributos: { indice: 1.56, tratamiento: 'antirreflejo' },
            precioVenta: 35000,
            stockMinimo: 5,
          },
          {
            sku: 'LIQ-MULTI-360',
            nombre: 'Solución multipropósito 360 ml',
            tipo: 'LIQUIDO',
            precioVenta: 6500,
            stockMinimo: 6,
          },
          {
            sku: 'SRV-CONSULTA',
            nombre: 'Consulta optométrica',
            tipo: 'SERVICIO',
            precioVenta: 10000,
            controlaStock: false,
          },
        ])
        .returning();
      const iniciales: Record<string, [number, number]> = {
        'MON-RB5154-NEG': [4, 70000],
        'MON-VIT-2201-CAR': [10, 18000],
        'LEN-156-AR': [20, 12000],
        'LIQ-MULTI-360': [24, 3500],
      };
      for (const p of ejemplos) {
        const ini = iniciales[p.sku];
        if (!ini) continue;
        await moverStock(tx, {
          productoId: p.id,
          sucursalId: sucursal!.id,
          tipo: 'ENTRADA',
          cantidad: ini[0],
          costoUnitario: ini[1],
          motivo: 'Stock inicial (datos de ejemplo)',
          usuarioId: admin!.id,
        });
      }
    }
    return { admin: admin!, sucursal: sucursal!, creado: true };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { db, cerrar } = crearDb(env.DATABASE_URL);
  const r = await sembrar(db);
  console.log(r.creado ? `Listo. Ingresa con ${env.ADMIN_EMAIL}` : 'El administrador ya existía; nada que hacer.');
  await cerrar();
}

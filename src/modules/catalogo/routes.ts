import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { marcas, productos, proveedores, stock, tipoProducto } from '../../db/schema/index.js';
import { noEncontrado } from '../../lib/errors.js';
import { body, boolQuery, centavos, offset, paginacion, param, query, sucursalDe, usuarioDe } from '../../lib/http.js';
import { soloAdmin } from '../../middleware/auth.js';
import { moverStock } from '../inventario/servicio.js';

const tipo = z.enum(tipoProducto.enumValues);

const atributos = z
  .object({
    genero: z.enum(['HOMBRE', 'MUJER', 'NINO', 'UNISEX']).optional(),
    material: z.string().max(60).optional(),
    forma: z.string().max(60).optional(),
    color: z.string().max(60).optional(),
    calibre: z.number().positive().max(100).optional(),
    puente: z.number().positive().max(50).optional(),
    varilla: z.number().positive().max(200).optional(),
    indice: z.number().min(1.4).max(2).optional(),
    tratamiento: z.string().max(120).optional(),
  })
  .catchall(z.unknown());

const productoEsquema = z.object({
  sku: z.string().trim().toUpperCase().min(1).max(40),
  codigoBarras: z.string().trim().max(64).nullish(),
  nombre: z.string().trim().min(2).max(160),
  descripcion: z.string().trim().nullish(),
  tipo,
  marcaId: z.uuid().nullish(),
  proveedorId: z.uuid().nullish(),
  modelo: z.string().trim().max(80).nullish(),
  atributos,
  precioVenta: centavos,
  stockMinimo: z.number().int().nonnegative(),
  controlaStock: z.boolean().optional(),
  activo: z.boolean().optional(),
});

/** CRUD simple para tablas pequeñas de referencia (marcas, proveedores). */
function crudSimple<T extends typeof marcas | typeof proveedores>(
  db: DB,
  tabla: T,
  esquema: z.ZodObject,
  nombre: string,
) {
  const r = Router();
  r.get('/', async (_req, res) => {
    res.json(await db.select().from(tabla as typeof marcas).orderBy(asc((tabla as typeof marcas).nombre)));
  });
  r.post('/', async (req, res) => {
    const [fila] = await db.insert(tabla).values(body(req, esquema) as never).returning();
    res.status(201).json(fila);
  });
  r.patch('/:id', async (req, res) => {
    const t = tabla as typeof marcas;
    const [fila] = await db
      .update(t)
      .set(body(req, esquema.partial()) as never)
      .where(eq(t.id, param(req)))
      .returning();
    if (!fila) throw noEncontrado(nombre);
    res.json(fila);
  });
  return r;
}

export function rutasCatalogo(db: DB) {
  const r = Router();

  r.use(
    '/marcas',
    crudSimple(db, marcas, z.object({ nombre: z.string().trim().min(1).max(80), activa: z.boolean().optional() }), 'Marca'),
  );
  r.use(
    '/proveedores',
    crudSimple(
      db,
      proveedores,
      z.object({
        nombre: z.string().trim().min(2).max(120),
        nit: z.string().trim().max(30).nullish(),
        contacto: z.string().trim().max(120).nullish(),
        telefono: z.string().trim().max(40).nullish(),
        email: z.email().nullish(),
        activo: z.boolean().optional(),
      }),
      'Proveedor',
    ),
  );

  /**
   * Lista de productos con el stock de la sucursal consultada.
   * Filtros: q (nombre, sku, código de barras, modelo), tipo, marcaId, activo, bajoStock.
   */
  r.get('/productos', async (req, res) => {
    const f = query(
      req,
      paginacion.extend({
        q: z.string().trim().optional(),
        tipo: tipo.optional(),
        marcaId: z.uuid().optional(),
        activo: boolQuery.optional(),
        bajoStock: boolQuery.optional(),
        sucursalId: z.uuid().optional(),
      }),
    );
    const sucursalId = sucursalDe(req, f.sucursalId);
    const cantidad = sql<number>`coalesce(${stock.cantidad}, 0)`.mapWith(Number);
    const filtros: (SQL | undefined)[] = [
      f.q
        ? or(
            ilike(productos.nombre, `%${f.q}%`),
            ilike(productos.sku, `%${f.q}%`),
            ilike(productos.modelo, `%${f.q}%`),
            eq(productos.codigoBarras, f.q),
          )
        : undefined,
      f.tipo ? eq(productos.tipo, f.tipo) : undefined,
      f.marcaId ? eq(productos.marcaId, f.marcaId) : undefined,
      f.activo !== undefined ? eq(productos.activo, f.activo) : undefined,
      f.bajoStock ? sql`${productos.controlaStock} AND ${cantidad} <= ${productos.stockMinimo}` : undefined,
    ];
    const where = and(...filtros);
    const base = db
      .select({
        id: productos.id,
        sku: productos.sku,
        codigoBarras: productos.codigoBarras,
        nombre: productos.nombre,
        tipo: productos.tipo,
        modelo: productos.modelo,
        marcaId: productos.marcaId,
        marca: marcas.nombre,
        atributos: productos.atributos,
        precioVenta: productos.precioVenta,
        costoPromedio: productos.costoPromedio,
        stockMinimo: productos.stockMinimo,
        controlaStock: productos.controlaStock,
        activo: productos.activo,
        stock: cantidad,
        ubicacion: stock.ubicacion,
      })
      .from(productos)
      .leftJoin(marcas, eq(marcas.id, productos.marcaId))
      .leftJoin(stock, and(eq(stock.productoId, productos.id), eq(stock.sucursalId, sucursalId)))
      .where(where);

    const [datos, [conteo]] = await Promise.all([
      base.orderBy(asc(productos.nombre)).limit(f.porPagina).offset(offset(f)),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(productos)
        .leftJoin(stock, and(eq(stock.productoId, productos.id), eq(stock.sucursalId, sucursalId)))
        .where(where),
    ]);
    res.json({ datos, total: conteo!.total, pagina: f.pagina, porPagina: f.porPagina });
  });

  /** Ficha del producto con su stock en todas las sucursales. */
  r.get('/productos/:id', async (req, res) => {
    const id = param(req);
    const [p] = await db.select().from(productos).where(eq(productos.id, id));
    if (!p) throw noEncontrado('Producto');
    const existencias = await db.select().from(stock).where(eq(stock.productoId, id));
    res.json({ ...p, existencias });
  });

  /** Crea un producto; opcionalmente registra su stock inicial como una entrada. */
  r.post('/productos', soloAdmin, async (req, res) => {
    const { stockInicial, ...datos } = body(
      req,
      productoEsquema.extend({
        atributos: atributos.default({}),
        stockMinimo: z.number().int().nonnegative().default(0),
        stockInicial: z
          .object({
            sucursalId: z.uuid().optional(),
            cantidad: z.number().int().positive(),
            costoUnitario: centavos,
          })
          .optional(),
      }),
    );
    const usuario = usuarioDe(req);
    const creado = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(productos)
        .values({ ...datos, controlaStock: datos.controlaStock ?? datos.tipo !== 'SERVICIO' })
        .returning();
      if (stockInicial && p!.controlaStock) {
        await moverStock(tx, {
          productoId: p!.id,
          sucursalId: sucursalDe(req, stockInicial.sucursalId),
          tipo: 'ENTRADA',
          cantidad: stockInicial.cantidad,
          costoUnitario: stockInicial.costoUnitario,
          motivo: 'Stock inicial',
          usuarioId: usuario.id,
        });
      }
      const [final] = await tx.select().from(productos).where(eq(productos.id, p!.id));
      return final!;
    });
    res.status(201).json(creado);
  });

  r.patch('/productos/:id', soloAdmin, async (req, res) => {
    const [p] = await db
      .update(productos)
      .set(body(req, productoEsquema.partial()))
      .where(eq(productos.id, param(req)))
      .returning();
    if (!p) throw noEncontrado('Producto');
    res.json(p);
  });

  return r;
}

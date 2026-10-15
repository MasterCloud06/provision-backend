import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import express, { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { marcas, movimientosInventario, productos, proveedores, stock, tipoProducto, ventaItems } from '../../db/schema/index.js';
import { AppError, noEncontrado } from '../../lib/errors.js';
import { esImagen, MAX_FOTO_BYTES, TIPOS_FOTO, type AlmacenFotos } from '../../lib/fotos.js';
import { body, boolQuery, centavos, offset, paginacion, param, query, sucursalDe, usuarioDe } from '../../lib/http.js';
import { requierePermiso } from '../../middleware/auth.js';
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
  /** Foto para la tienda web: una URL https pública. */
  imagenUrl: z.url({ protocol: /^https?$/ }).max(500).nullish(),
  /** Si se muestra en la tienda web. */
  visibleTienda: z.boolean().optional(),
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
  const gestiona = requierePermiso('catalogo.gestionar');
  r.get('/', async (_req, res) => {
    res.json(await db.select().from(tabla as typeof marcas).orderBy(asc((tabla as typeof marcas).nombre)));
  });
  r.post('/', gestiona, async (req, res) => {
    const [fila] = await db.insert(tabla).values(body(req, esquema) as never).returning();
    res.status(201).json(fila);
  });
  r.patch('/:id', gestiona, async (req, res) => {
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

export function rutasCatalogo(db: DB, fotos: AlmacenFotos | null = null) {
  const r = Router();
  r.use(requierePermiso('catalogo.ver'));

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
        descripcion: productos.descripcion,
        tipo: productos.tipo,
        modelo: productos.modelo,
        marcaId: productos.marcaId,
        marca: marcas.nombre,
        atributos: productos.atributos,
        precioVenta: productos.precioVenta,
        costoPromedio: productos.costoPromedio,
        stockMinimo: productos.stockMinimo,
        controlaStock: productos.controlaStock,
        imagenUrl: productos.imagenUrl,
        visibleTienda: productos.visibleTienda,
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
  r.post('/productos', requierePermiso('catalogo.gestionar'), async (req, res) => {
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

  r.patch('/productos/:id', requierePermiso('catalogo.gestionar'), async (req, res) => {
    const [p] = await db
      .update(productos)
      .set(body(req, productoEsquema.partial()))
      .where(eq(productos.id, param(req)))
      .returning();
    if (!p) throw noEncontrado('Producto');
    res.json(p);
  });

  /**
   * Foto del producto: el cuerpo es la imagen tal cual (Content-Type image/jpeg, png, webp o heic).
   * Se guarda en Cloudinary y la URL queda en imagenUrl. Subir otra reemplaza la anterior.
   */
  r.put(
    '/productos/:id/foto',
    requierePermiso('catalogo.gestionar'),
    express.raw({ type: 'image/*', limit: MAX_FOTO_BYTES }),
    async (req, res) => {
      const id = param(req);
      if (!fotos) throw new AppError(503, 'FOTOS_NO_CONFIGURADAS', 'Las fotos todavía no están habilitadas: falta configurar Cloudinary en el servidor');
      const tipo = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const imagen = req.body as unknown;
      if (!(TIPOS_FOTO as readonly string[]).includes(tipo) || !Buffer.isBuffer(imagen) || !esImagen(imagen)) {
        throw new AppError(415, 'FOTO_INVALIDA', 'La foto debe ser JPG, PNG, WEBP o HEIC');
      }
      const [p] = await db.select({ id: productos.id }).from(productos).where(eq(productos.id, id));
      if (!p) throw noEncontrado('Producto');
      let url: string;
      try {
        url = await fotos.subir(id, imagen, tipo);
      } catch (err) {
        console.error('[fotos] no se pudo subir', err);
        throw new AppError(502, 'FOTO_NO_SUBIDA', 'No se pudo guardar la foto. Intenta de nuevo en un momento.');
      }
      const [actualizado] = await db.update(productos).set({ imagenUrl: url }).where(eq(productos.id, id)).returning();
      res.json(actualizado);
    },
  );

  r.delete('/productos/:id/foto', requierePermiso('catalogo.gestionar'), async (req, res) => {
    const id = param(req);
    const [p] = await db.select({ imagenUrl: productos.imagenUrl }).from(productos).where(eq(productos.id, id));
    if (!p) throw noEncontrado('Producto');
    // Si la foto estaba en Cloudinary se borra allá; si era un enlace externo solo se quita.
    if (fotos && p.imagenUrl?.includes('res.cloudinary.com')) {
      await fotos.borrar(id).catch((err) => console.error('[fotos] no se pudo borrar', err));
    }
    const [actualizado] = await db.update(productos).set({ imagenUrl: null }).where(eq(productos.id, id)).returning();
    res.json(actualizado);
  });

  /**
   * Eliminar: si el producto nunca tuvo movimientos ni ventas se borra de verdad;
   * si tiene historial se desactiva (deja de aparecer para vender), para no romper el kardex ni las ventas.
   */
  r.delete('/productos/:id', requierePermiso('catalogo.gestionar'), async (req, res) => {
    const id = param(req);
    const resultado = await db.transaction(async (tx) => {
      const [p] = await tx.select({ id: productos.id, nombre: productos.nombre }).from(productos).where(eq(productos.id, id));
      if (!p) throw noEncontrado('Producto');
      const [mov] = await tx.select({ id: movimientosInventario.id }).from(movimientosInventario)
        .where(eq(movimientosInventario.productoId, id)).limit(1);
      const [venta] = await tx.select({ id: ventaItems.id }).from(ventaItems).where(eq(ventaItems.productoId, id)).limit(1);
      if (mov || venta) {
        await tx.update(productos).set({ activo: false }).where(eq(productos.id, id));
        return { eliminado: false, desactivado: true, mensaje: `"${p.nombre}" tiene historial: se desactivó en lugar de borrarse` };
      }
      await tx.delete(stock).where(eq(stock.productoId, id));
      await tx.delete(productos).where(eq(productos.id, id));
      return { eliminado: true, desactivado: false, mensaje: `"${p.nombre}" eliminado` };
    });
    res.json(resultado);
  });

  return r;
}

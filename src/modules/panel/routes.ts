import { and, eq, gt, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { Router } from 'express';
import type { DB } from '../../db/client.js';
import {
  clientes,
  eventos,
  historialTrabajo,
  pedidosWeb,
  ordenesTrabajo,
  pagos,
  productos,
  recetas,
  sesionesCaja,
  stock,
  usuarios,
  ventas,
} from '../../db/schema/index.js';
import { finDia, hoy, inicioDia } from '../../lib/fechas.js';
import { GUIA_ROLES } from '../../lib/guia-roles.js';
import { usuarioDe, type UsuarioSesion } from '../../lib/http.js';
import { NOMBRE_ROL, tienePermiso } from '../../lib/permisos.js';
import { resumenSesion } from '../caja/servicio.js';
import { resumenCitas } from '../citas/servicio.js';

type Urgencia = 'ALTA' | 'MEDIA' | 'INFO' | 'OK';
/** Claves de pantalla que la app usa para llevar al usuario donde se hace la tarea. */
type Pantalla = 'panel' | 'indicadores' | 'auditoria' | 'vender' | 'ventas' | 'caja' | 'laboratorio' | 'clientes' | 'inventario' | 'usuarios' | 'pedidos' | 'agenda';

type Tarea = { clave: string; titulo: string; detalle: string; cantidad: number | null; urgencia: Urgencia; pantalla: Pantalla | null };
type Indicador = { titulo: string; valor: string; detalle?: string };

const ORDEN: Record<Urgencia, number> = { ALTA: 0, MEDIA: 1, INFO: 2, OK: 3 };
const bs = (c: number) => `Bs ${(c / 100).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/**
 * Consultas que arman el panel. Cada una se limita a la sucursal del usuario
 * (o a todo, si el usuario no tiene sucursal asignada).
 */
function consultas(db: DB, u: UsuarioSesion) {
  const dia = hoy();
  const enSucursal = (col: PgColumn): SQL | undefined => (u.sucursalId ? eq(col, u.sucursalId) : undefined);
  const deHoy = and(gte(ventas.creadoEn, inicioDia(dia)), lte(ventas.creadoEn, finDia(dia)));
  const activas = and(eq(ventas.estado, 'ACTIVA'), enSucursal(ventas.sucursalId));
  const num = (s: SQL) => sql<number>`coalesce(${s}, 0)`.mapWith(Number);

  return {
    async caja() {
      if (!u.sucursalId) return null;
      const [s] = await db
        .select({ id: sesionesCaja.id })
        .from(sesionesCaja)
        .where(and(eq(sesionesCaja.sucursalId, u.sucursalId), eq(sesionesCaja.estado, 'ABIERTA')));
      if (!s) return { abierta: false as const, efectivo: 0, ingresos: 0 };
      const r = await resumenSesion(db, s.id);
      return { abierta: true as const, efectivo: r.efectivoEsperado, ingresos: r.totalIngresos };
    },
    async ventas(filtro?: SQL) {
      const [r] = await db
        .select({ n: num(sql`count(*)`), monto: num(sql`sum(${ventas.total})`) })
        .from(ventas)
        .where(and(activas, filtro));
      return r!;
    },
    async conSaldo(filtro?: SQL) {
      const [r] = await db
        .select({ n: num(sql`count(*)`), monto: num(sql`sum(${ventas.saldo})`) })
        .from(ventas)
        .where(and(activas, gt(ventas.saldo, 0), filtro));
      return r!;
    },
    /** Ventas de hoy sin ningún pago: el cliente todavía no pasó por caja. */
    async esperandoCaja(filtro?: SQL) {
      const [r] = await db
        .select({ n: num(sql`count(*)`), monto: num(sql`sum(${ventas.saldo})`) })
        .from(ventas)
        .where(and(activas, deHoy, eq(ventas.estadoPago, 'PENDIENTE'), filtro));
      return r!;
    },
    async ordenes(filtro?: SQL) {
      const base = and(enSucursal(ordenesTrabajo.sucursalId), filtro);
      const enCurso = inArray(ordenesTrabajo.estado, ['PENDIENTE', 'EN_LABORATORIO']);
      const [r] = await db
        .select({
          pendientes: num(sql`count(*) filter (where ${ordenesTrabajo.estado} = 'PENDIENTE')`),
          enLaboratorio: num(sql`count(*) filter (where ${ordenesTrabajo.estado} = 'EN_LABORATORIO')`),
          atrasadas: num(sql`count(*) filter (where ${enCurso} and ${ordenesTrabajo.fechaPrometida} < ${dia})`),
          vencenHoy: num(sql`count(*) filter (where ${enCurso} and ${ordenesTrabajo.fechaPrometida} = ${dia})`),
          listasPagadas: num(sql`count(*) filter (where ${ordenesTrabajo.estado} = 'LISTO' and ${ventas.saldo} = 0)`),
          listasConSaldo: num(sql`count(*) filter (where ${ordenesTrabajo.estado} = 'LISTO' and ${ventas.saldo} > 0)`),
        })
        .from(ordenesTrabajo)
        .innerJoin(ventas, eq(ventas.id, ordenesTrabajo.ventaId))
        .where(base);
      return r!;
    },
    async bajoStock() {
      if (!u.sucursalId) return 0;
      const [r] = await db
        .select({ n: num(sql`count(*)`) })
        .from(productos)
        .leftJoin(stock, and(eq(stock.productoId, productos.id), eq(stock.sucursalId, u.sucursalId)))
        .where(and(eq(productos.activo, true), eq(productos.controlaStock, true), sql`coalesce(${stock.cantidad}, 0) <= ${productos.stockMinimo}`));
      return r!.n;
    },
    async cobradoHoyPorMi() {
      const [r] = await db
        .select({ n: num(sql`count(*)`), monto: num(sql`sum(${pagos.monto})`) })
        .from(pagos)
        .where(and(eq(pagos.usuarioId, u.id), gte(pagos.creadoEn, inicioDia(dia)), lte(pagos.creadoEn, finDia(dia))));
      return r!;
    },
    async recetasMias(desde: string) {
      const [r] = await db
        .select({ n: num(sql`count(*)`) })
        .from(recetas)
        .where(and(eq(recetas.registradoPor, u.id), gte(recetas.creadoEn, inicioDia(desde))));
      return r!.n;
    },
    async clientesNuevosHoy() {
      const [r] = await db.select({ n: num(sql`count(*)`) }).from(clientes).where(gte(clientes.creadoEn, inicioDia(dia)));
      return r!.n;
    },
    async terminadasHoyPorMi() {
      const [r] = await db
        .select({ n: num(sql`count(*)`) })
        .from(historialTrabajo)
        .where(and(eq(historialTrabajo.usuarioId, u.id), eq(historialTrabajo.estadoNuevo, 'LISTO'), gte(historialTrabajo.creadoEn, inicioDia(dia))));
      return r!.n;
    },
    async auditoriaHoy() {
      const [r] = await db
        .select({
          eventos: num(sql`count(*)`),
          negados: num(sql`count(*) filter (where ${eventos.resultado} in ('DENEGADO', 'FALLIDO'))`),
          usuarios: num(sql`count(distinct ${eventos.usuarioId})`),
        })
        .from(eventos)
        .where(gte(eventos.creadoEn, inicioDia(dia)));
      return r!;
    },
    async usuariosActivos() {
      const [r] = await db.select({ n: num(sql`count(*)`) }).from(usuarios).where(eq(usuarios.activo, true));
      return r!.n;
    },
    inicioMes: `${dia.slice(0, 7)}-01`,
    hoy: dia,
  };
}

async function armarPanel(db: DB, u: UsuarioSesion) {
  const q = consultas(db, u);
  const tareas: Tarea[] = [];
  const indicadores: Indicador[] = [];
  const tarea = (t: Tarea) => tareas.push(t);
  const mes = and(gte(ventas.creadoEn, inicioDia(q.inicioMes)), lte(ventas.creadoEn, finDia(q.hoy)));
  const hoySql = and(gte(ventas.creadoEn, inicioDia(q.hoy)), lte(ventas.creadoEn, finDia(q.hoy)));

  // Tareas compartidas por los roles que dirigen la sucursal.
  const tareasDeGestion = async (conCaja: boolean) => {
    const [caja, ord, bajo, saldo] = await Promise.all([q.caja(), q.ordenes(), q.bajoStock(), q.conSaldo()]);
    if (conCaja && caja && !caja.abierta) {
      tarea({ clave: 'caja-cerrada', titulo: 'La caja está cerrada', detalle: 'Sin caja abierta no se pueden cobrar ventas.', cantidad: null, urgencia: 'ALTA', pantalla: 'caja' });
    }
    if (ord.atrasadas > 0) {
      tarea({ clave: 'ordenes-atrasadas', titulo: plural(ord.atrasadas, 'orden atrasada', 'órdenes atrasadas'), detalle: 'Pasó la fecha prometida al cliente y aún no están listas.', cantidad: ord.atrasadas, urgencia: 'ALTA', pantalla: 'laboratorio' });
    }
    if (bajo > 0) {
      tarea({ clave: 'bajo-stock', titulo: plural(bajo, 'producto por reponer', 'productos por reponer'), detalle: 'Están en o por debajo del stock mínimo.', cantidad: bajo, urgencia: 'MEDIA', pantalla: 'inventario' });
    }
    if (saldo.n > 0) {
      tarea({ clave: 'por-cobrar', titulo: `${bs(saldo.monto)} por cobrar`, detalle: `${plural(saldo.n, 'venta', 'ventas')} con saldo pendiente.`, cantidad: saldo.n, urgencia: 'INFO', pantalla: 'ventas' });
    }
    return { caja, ord, bajo, saldo };
  };

  switch (u.rol) {
    case 'SUPERADMIN':
    case 'ADMIN': {
      const extra = u.rol === 'SUPERADMIN' ? await q.auditoriaHoy() : null;
      if (extra && extra.negados > 0) {
        tarea({ clave: 'negados', titulo: plural(extra.negados, 'intento negado hoy', 'intentos negados hoy'), detalle: 'Alguien intentó hacer algo sin permiso o ingresar con una contraseña incorrecta.', cantidad: extra.negados, urgencia: 'ALTA', pantalla: 'auditoria' });
      }
      const { saldo, bajo } = await tareasDeGestion(true);
      const [vHoy, vMes] = await Promise.all([q.ventas(hoySql), q.ventas(mes)]);
      indicadores.push(
        { titulo: 'Ventas de hoy', valor: bs(vHoy.monto), detalle: plural(vHoy.n, 'venta', 'ventas') },
        { titulo: 'Ventas del mes', valor: bs(vMes.monto), detalle: plural(vMes.n, 'venta', 'ventas') },
        { titulo: 'Por cobrar', valor: bs(saldo.monto), detalle: plural(saldo.n, 'venta con saldo', 'ventas con saldo') },
        { titulo: 'Por reponer', valor: String(bajo), detalle: 'productos bajo el mínimo' },
      );
      if (extra) {
        indicadores.push({ titulo: 'Actividad de hoy', valor: String(extra.eventos), detalle: `eventos de ${plural(extra.usuarios, 'usuario', 'usuarios')}` });
      } else {
        indicadores.push({ titulo: 'Personal activo', valor: String(await q.usuariosActivos()), detalle: 'usuarios que pueden ingresar' });
      }
      break;
    }

    case 'ENCARGADO': {
      const { caja, ord, bajo } = await tareasDeGestion(true);
      if (ord.vencenHoy > 0) {
        tarea({ clave: 'vencen-hoy', titulo: plural(ord.vencenHoy, 'orden vence hoy', 'órdenes vencen hoy'), detalle: 'Confirma con laboratorio que estén a tiempo.', cantidad: ord.vencenHoy, urgencia: 'MEDIA', pantalla: 'laboratorio' });
      }
      const vHoy = await q.ventas(hoySql);
      indicadores.push(
        { titulo: 'Ventas de hoy', valor: bs(vHoy.monto), detalle: plural(vHoy.n, 'venta', 'ventas') },
        { titulo: 'Efectivo en caja', valor: caja?.abierta ? bs(caja.efectivo) : 'Caja cerrada' },
        { titulo: 'Órdenes en proceso', valor: String(ord.pendientes + ord.enLaboratorio), detalle: `${ord.atrasadas} atrasadas` },
        { titulo: 'Por reponer', valor: String(bajo), detalle: 'productos bajo el mínimo' },
      );
      break;
    }

    case 'CAJERO': {
      const [caja, esperando, saldo, ord, cobrado] = await Promise.all([
        q.caja(), q.esperandoCaja(), q.conSaldo(), q.ordenes(), q.cobradoHoyPorMi(),
      ]);
      if (caja && !caja.abierta) {
        tarea({ clave: 'abrir-caja', titulo: 'Abre la caja para empezar', detalle: 'Cuenta el fondo inicial (sencillo) y regístralo.', cantidad: null, urgencia: 'ALTA', pantalla: 'caja' });
      }
      if (esperando.n > 0) {
        tarea({ clave: 'esperando-cobro', titulo: plural(esperando.n, 'venta espera cobro', 'ventas esperan cobro'), detalle: `Registradas hoy por ventas, sin ningún pago (${bs(esperando.monto)}).`, cantidad: esperando.n, urgencia: 'ALTA', pantalla: 'ventas' });
      }
      if (ord.listasConSaldo > 0) {
        tarea({ clave: 'listas-con-saldo', titulo: plural(ord.listasConSaldo, 'lente listo con saldo', 'lentes listos con saldo'), detalle: 'Cobra el saldo antes de entregarlos.', cantidad: ord.listasConSaldo, urgencia: 'MEDIA', pantalla: 'ventas' });
      }
      if (ord.listasPagadas > 0) {
        tarea({ clave: 'listas-pagadas', titulo: plural(ord.listasPagadas, 'lente listo para entregar', 'lentes listos para entregar'), detalle: 'Ya están pagados: entrégalos cuando llegue el cliente.', cantidad: ord.listasPagadas, urgencia: 'MEDIA', pantalla: 'laboratorio' });
      }
      if (saldo.n > 0) {
        tarea({ clave: 'por-cobrar', titulo: `${bs(saldo.monto)} en saldos pendientes`, detalle: `${plural(saldo.n, 'venta', 'ventas')} con saldo. Cóbralo cuando el cliente vuelva.`, cantidad: saldo.n, urgencia: 'INFO', pantalla: 'ventas' });
      }
      if (caja?.abierta) {
        tarea({ clave: 'cerrar-caja', titulo: 'Al terminar tu turno, cierra la caja', detalle: 'Cuenta el efectivo y regístralo: el sistema te dirá si cuadra.', cantidad: null, urgencia: 'INFO', pantalla: 'caja' });
      }
      indicadores.push(
        { titulo: 'Efectivo que debe haber', valor: caja?.abierta ? bs(caja.efectivo) : 'Caja cerrada' },
        { titulo: 'Cobrado por ti hoy', valor: bs(cobrado.monto), detalle: plural(cobrado.n, 'cobro', 'cobros') },
        { titulo: 'Esperando cobro', valor: String(esperando.n), detalle: 'ventas de hoy sin pagar' },
        { titulo: 'Saldos pendientes', valor: bs(saldo.monto) },
      );
      break;
    }

    case 'VENDEDOR': {
      const mias = eq(ventas.vendedorId, u.id);
      const [esperando, ord, vHoy, vMes, saldo] = await Promise.all([
        q.esperandoCaja(mias), q.ordenes(mias), q.ventas(and(mias, hoySql)), q.ventas(and(mias, mes)), q.conSaldo(mias),
      ]);
      const listas = ord.listasPagadas + ord.listasConSaldo;
      if (listas > 0) {
        tarea({ clave: 'avisar-cliente', titulo: plural(listas, 'cliente por avisar', 'clientes por avisar'), detalle: 'Sus lentes están listos: llámalos para que pasen a recogerlos.', cantidad: listas, urgencia: 'ALTA', pantalla: 'laboratorio' });
      }
      if (esperando.n > 0) {
        tarea({ clave: 'mandar-a-caja', titulo: plural(esperando.n, 'venta tuya sin cobrar', 'ventas tuyas sin cobrar'), detalle: 'Asegúrate de que el cliente pasó por caja.', cantidad: esperando.n, urgencia: 'MEDIA', pantalla: 'ventas' });
      }
      if (ord.atrasadas > 0) {
        tarea({ clave: 'atrasadas', titulo: plural(ord.atrasadas, 'orden tuya atrasada', 'órdenes tuyas atrasadas'), detalle: 'Avisa al cliente y coordina con laboratorio.', cantidad: ord.atrasadas, urgencia: 'MEDIA', pantalla: 'laboratorio' });
      }
      tarea({ clave: 'nueva-venta', titulo: 'Atiende y registra una venta', detalle: 'Registra al cliente, asocia su receta y la fecha de entrega.', cantidad: null, urgencia: 'INFO', pantalla: 'vender' });
      indicadores.push(
        { titulo: 'Tus ventas de hoy', valor: bs(vHoy.monto), detalle: plural(vHoy.n, 'venta', 'ventas') },
        { titulo: 'Tus ventas del mes', valor: bs(vMes.monto), detalle: plural(vMes.n, 'venta', 'ventas') },
        { titulo: 'Tus clientes con saldo', valor: String(saldo.n), detalle: bs(saldo.monto) },
        { titulo: 'Tus órdenes en proceso', valor: String(ord.pendientes + ord.enLaboratorio) },
      );
      break;
    }

    case 'OPTOMETRISTA': {
      const [rHoy, rMes, nuevos] = await Promise.all([q.recetasMias(q.hoy), q.recetasMias(q.inicioMes), q.clientesNuevosHoy()]);
      tarea({ clave: 'registrar-receta', titulo: 'Registra la receta de cada examen', detalle: 'Busca al cliente (o regístralo) y carga su graduación completa.', cantidad: null, urgencia: 'INFO', pantalla: 'clientes' });
      if (nuevos > 0) {
        tarea({ clave: 'clientes-nuevos', titulo: plural(nuevos, 'cliente nuevo hoy', 'clientes nuevos hoy'), detalle: 'Revisa si ya tienen su receta registrada.', cantidad: nuevos, urgencia: 'INFO', pantalla: 'clientes' });
      }
      indicadores.push(
        { titulo: 'Recetas de hoy', valor: String(rHoy) },
        { titulo: 'Recetas del mes', valor: String(rMes) },
        { titulo: 'Clientes nuevos hoy', valor: String(nuevos) },
      );
      break;
    }

    case 'LABORATORIO': {
      const [ord, terminadas] = await Promise.all([q.ordenes(), q.terminadasHoyPorMi()]);
      if (ord.atrasadas > 0) {
        tarea({ clave: 'atrasadas', titulo: plural(ord.atrasadas, 'orden atrasada', 'órdenes atrasadas'), detalle: 'El cliente ya las esperaba: son la prioridad.', cantidad: ord.atrasadas, urgencia: 'ALTA', pantalla: 'laboratorio' });
      }
      if (ord.vencenHoy > 0) {
        tarea({ clave: 'vencen-hoy', titulo: plural(ord.vencenHoy, 'orden vence hoy', 'órdenes vencen hoy'), detalle: 'Deben quedar listas hoy.', cantidad: ord.vencenHoy, urgencia: 'ALTA', pantalla: 'laboratorio' });
      }
      if (ord.pendientes > 0) {
        tarea({ clave: 'pendientes', titulo: plural(ord.pendientes, 'orden por empezar', 'órdenes por empezar'), detalle: 'Pásalas a "en laboratorio" cuando empieces a armarlas.', cantidad: ord.pendientes, urgencia: 'MEDIA', pantalla: 'laboratorio' });
      }
      if (ord.enLaboratorio > 0) {
        tarea({ clave: 'en-proceso', titulo: plural(ord.enLaboratorio, 'orden en proceso', 'órdenes en proceso'), detalle: 'Márcalas como "listo" al terminar.', cantidad: ord.enLaboratorio, urgencia: 'INFO', pantalla: 'laboratorio' });
      }
      indicadores.push(
        { titulo: 'Por empezar', valor: String(ord.pendientes) },
        { titulo: 'En laboratorio', valor: String(ord.enLaboratorio) },
        { titulo: 'Atrasadas', valor: String(ord.atrasadas) },
        { titulo: 'Terminadas por ti hoy', valor: String(terminadas) },
      );
      break;
    }
  }

  // Tienda web: pedidos que esperan al personal (pagados por preparar, o "pago al retirar").
  if (tienePermiso(u.rol, 'tienda.gestionar')) {
    const [porAtender] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pedidosWeb)
      .where(
        and(
          u.sucursalId ? eq(pedidosWeb.sucursalId, u.sucursalId) : undefined,
          sql`(${pedidosWeb.estado} in ('PAGADO', 'PREPARANDO') or (${pedidosWeb.estado} = 'PENDIENTE_PAGO' and ${pedidosWeb.metodoPago} = 'EN_TIENDA'))`,
        ),
      );
    if (porAtender!.n > 0) {
      tarea({
        clave: 'pedidos-web',
        titulo: plural(porAtender!.n, 'pedido web por preparar', 'pedidos web por preparar'),
        detalle: 'Clientes que compraron en la tienda en línea: prepara sus productos y avísales.',
        cantidad: porAtender!.n,
        urgencia: 'ALTA',
        pantalla: 'pedidos',
      });
    }
  }

  // Citas: las de hoy y las que falta confirmar (hoy y mañana).
  if (tienePermiso(u.rol, 'citas.gestionar')) {
    const c = await resumenCitas(db, u.sucursalId);
    if (c.porConfirmar > 0) {
      tarea({
        clave: 'citas-por-confirmar',
        titulo: plural(c.porConfirmar, 'cita por confirmar', 'citas por confirmar'),
        detalle: 'Reservadas para hoy o mañana: llama o escribe al cliente para confirmarlas.',
        cantidad: c.porConfirmar,
        urgencia: 'MEDIA',
        pantalla: 'agenda',
      });
    }
    if (c.hoy > 0) {
      tarea({
        clave: 'citas-hoy',
        titulo: plural(c.hoy, 'cita hoy', 'citas hoy'),
        detalle: 'Revisa la agenda y marca cada una como atendida o no asistió.',
        cantidad: c.hoy,
        urgencia: u.rol === 'OPTOMETRISTA' ? 'ALTA' : 'INFO',
        pantalla: 'agenda',
      });
    }
  }

  if (!tareas.some((t) => t.urgencia === 'ALTA' || t.urgencia === 'MEDIA')) {
    tarea({ clave: 'al-dia', titulo: 'Todo al día', detalle: 'No hay nada urgente por ahora.', cantidad: null, urgencia: 'OK', pantalla: null });
  }
  tareas.sort((a, b) => ORDEN[a.urgencia] - ORDEN[b.urgencia]);

  return {
    rol: u.rol,
    nombreRol: NOMBRE_ROL[u.rol],
    nombre: u.nombre,
    ...GUIA_ROLES[u.rol],
    tareas,
    indicadores,
    generadoEn: new Date().toISOString(),
  };
}

/** "Mi panel": para qué existe tu rol, qué se espera de ti y qué hacer ahora. Todos los roles. */
export function rutasPanel(db: DB) {
  const r = Router();
  r.get('/', async (req, res) => {
    res.json(await armarPanel(db, usuarioDe(req)));
  });
  return r;
}


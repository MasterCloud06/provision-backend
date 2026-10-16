import type { Rol } from './permisos.js';

/**
 * Para qué existe cada rol y qué se espera de quien lo tiene.
 * Es lo que ve cada usuario en "Mi panel" y la referencia para asignar roles.
 */
export const GUIA_ROLES: Record<Rol, { proposito: string; responsabilidades: string[] }> = {
  SUPERADMIN: {
    proposito:
      'Eres el dueño del sistema. Tienes acceso a todo y eres el único que ve la auditoría y gestiona a los administradores. Tu trabajo es vigilar que el negocio y el equipo funcionen bien y con seguridad.',
    responsabilidades: [
      'Revisar la auditoría: quién hizo qué y quién intentó algo sin permiso',
      'Crear y supervisar a los administradores',
      'Seguir los indicadores del negocio: ventas, margen y cuentas por cobrar',
      'Registrar tus retiros del negocio para llevar tus finanzas personales',
    ],
  },
  ADMIN: {
    proposito:
      'Diriges la óptica: el personal, las sucursales, los precios y el catálogo. Ves los números del negocio para tomar decisiones.',
    responsabilidades: [
      'Dar de alta al personal y asignar el rol correcto a cada persona',
      'Mantener el catálogo y los precios al día',
      'Revisar ventas, margen, saldos por cobrar y productos por reponer',
      'Autorizar anulaciones y resolver diferencias de caja',
    ],
  },
  ENCARGADO: {
    proposito:
      'Eres responsable de que tu sucursal funcione en el día a día: caja, inventario, laboratorio y atención. Resuelves lo que el resto del equipo no puede.',
    responsabilidades: [
      'Asegurar que la caja se abra y se cierre cuadrada cada turno',
      'Reponer lo que está bajo el mínimo y recibir la mercadería',
      'Vigilar que las órdenes de laboratorio no se atrasen',
      'Anular ventas cuando corresponda y autorizar cambios de precio',
    ],
  },
  CAJERO: {
    proposito:
      'Manejas el dinero de la sucursal: cobras las ventas y los saldos, registras los gastos y cierras la caja con el efectivo exacto.',
    responsabilidades: [
      'Abrir la caja con el fondo inicial al empezar el turno',
      'Cobrar las ventas que registran los ejecutivos y los saldos pendientes',
      'Entregar los lentes listos solo cuando el saldo está en cero',
      'Cerrar la caja contando el efectivo al terminar el turno',
    ],
  },
  VENDEDOR: {
    proposito:
      'Atiendes al cliente: lo asesoras, eliges con él la montura y los lentes, y registras la venta. El cobro lo hace caja.',
    responsabilidades: [
      'Registrar al cliente y asociar su receta a la venta',
      'Registrar la venta con la fecha de entrega prometida',
      'Enviar al cliente a caja para pagar o dejar su anticipo',
      'Avisar al cliente cuando sus lentes estén listos',
    ],
  },
  OPTOMETRISTA: {
    proposito:
      'Examinas la vista de los clientes y registras su graduación. Tu receta es la base de todo el trabajo del laboratorio.',
    responsabilidades: [
      'Revisar tu agenda del día y confirmar las citas',
      'Registrar al cliente si es nuevo',
      'Cargar la receta completa: esfera, cilindro, eje, adición y DNP',
      'Indicar el uso recomendado y las observaciones',
      'Revisar el historial de recetas en los controles',
    ],
  },
  LABORATORIO: {
    proposito:
      'Armas los lentes: tomas cada orden, montas los lentes con la graduación indicada y la marcas como lista para entregar.',
    responsabilidades: [
      'Revisar las órdenes pendientes cada mañana',
      'Pasar a "en laboratorio" lo que empiezas a armar',
      'Marcar como "listo" cada trabajo terminado',
      'Priorizar las órdenes atrasadas o que vencen hoy',
    ],
  },
};

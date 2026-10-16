/**
 * Permisos de Provisión. Cada rol es un paquete de permisos: las rutas piden permisos,
 * no roles, así un rol nuevo o un ajuste se hace solo aquí.
 */
export const PERMISOS = [
  /** Ver el registro de eventos (auditoría) de todos los roles. */
  'auditoria.ver',
  /** Crear y modificar cuentas de administrador y super administrador. */
  'usuarios.administradores',
  'usuarios.gestionar',
  'sucursales.gestionar',
  /** Operar en una sucursal distinta a la propia. */
  'sucursales.todas',
  'catalogo.ver',
  /** Crear, editar y eliminar productos, marcas y proveedores. */
  'catalogo.gestionar',
  'inventario.ver',
  /** Recepción de mercadería. */
  'inventario.recibir',
  /** Bajas por rotura, merma, uso interno. */
  'inventario.bajas',
  /** Ajustes por conteo físico y transferencias entre sucursales. */
  'inventario.ajustar',
  'clientes.ver',
  'clientes.gestionar',
  'recetas.gestionar',
  'ventas.ver',
  'ventas.crear',
  'ventas.anular',
  /** Vender a un precio distinto al de lista. */
  'precios.modificar',
  /** Abrir y cerrar caja, cobrar ventas y saldos, gastos y depósitos. */
  'caja.operar',
  'caja.retiro_dueno',
  'laboratorio.ver',
  /** Mover órdenes entre pendiente, en laboratorio y listo. */
  'laboratorio.gestionar',
  /** Entregar lentes al cliente (exige saldo en cero). */
  'laboratorio.entregar',
  'laboratorio.cancelar',
  'reportes.ver',
  /** Atender los pedidos de la tienda web: prepararlos, entregarlos o cancelarlos. */
  'tienda.gestionar',
  /** Agenda de citas: reservar, confirmar, marcar atendidas o canceladas. */
  'citas.gestionar',
] as const;

export type Permiso = (typeof PERMISOS)[number];

export const ROLES = ['SUPERADMIN', 'ADMIN', 'ENCARGADO', 'CAJERO', 'VENDEDOR', 'OPTOMETRISTA', 'LABORATORIO'] as const;
export type Rol = (typeof ROLES)[number];

/** Lo que solo tiene el super administrador. */
export const EXCLUSIVOS_SUPERADMIN: Permiso[] = ['auditoria.ver', 'usuarios.administradores'];
const SOLO_DUENO: Permiso[] = [
  ...EXCLUSIVOS_SUPERADMIN,
  'usuarios.gestionar',
  'sucursales.gestionar',
  'sucursales.todas',
  'caja.retiro_dueno',
];

/** Roles que solo puede asignar o modificar quien tiene 'usuarios.administradores'. */
export const ROLES_PROTEGIDOS: Rol[] = ['SUPERADMIN', 'ADMIN'];

export const PERMISOS_POR_ROL: Record<Rol, readonly Permiso[]> = {
  /** Super administrador: absolutamente todo, incluida la auditoría y las cuentas de administradores. */
  SUPERADMIN: PERMISOS,

  /** Administrador (dueño/gerente general): todo menos auditoría y cuentas de administradores. */
  ADMIN: PERMISOS.filter((p) => !EXCLUSIVOS_SUPERADMIN.includes(p)),

  /** Encargado de sucursal: todo lo operativo de su sucursal, sin usuarios ni retiros del dueño. */
  ENCARGADO: PERMISOS.filter((p) => !SOLO_DUENO.includes(p)),

  /** Cajero: la caja, el cobro y la entrega de lentes ya pagados. */
  CAJERO: [
    'catalogo.ver',
    'inventario.ver',
    'clientes.ver',
    'clientes.gestionar',
    'ventas.ver',
    'ventas.crear',
    'caja.operar',
    'laboratorio.ver',
    'laboratorio.entregar',
    'tienda.gestionar',
    'citas.gestionar',
  ],

  /** Ejecutivo de ventas (asesor): atiende y arma la venta; el cobro lo hace caja. */
  VENDEDOR: [
    'catalogo.ver',
    'inventario.ver',
    'clientes.ver',
    'clientes.gestionar',
    'ventas.ver',
    'ventas.crear',
    'laboratorio.ver',
    'laboratorio.entregar',
    'tienda.gestionar',
    'citas.gestionar',
  ],

  /** Optometrista: clientes y graduaciones. */
  OPTOMETRISTA: ['catalogo.ver', 'clientes.ver', 'clientes.gestionar', 'recetas.gestionar', 'ventas.ver', 'laboratorio.ver', 'citas.gestionar'],

  /** Técnico de laboratorio: armado de lentes. */
  LABORATORIO: ['catalogo.ver', 'inventario.ver', 'clientes.ver', 'laboratorio.ver', 'laboratorio.gestionar'],
};

export const NOMBRE_ROL: Record<Rol, string> = {
  SUPERADMIN: 'Super administrador',
  ADMIN: 'Administrador',
  ENCARGADO: 'Encargado de sucursal',
  CAJERO: 'Cajero',
  VENDEDOR: 'Ejecutivo de ventas',
  OPTOMETRISTA: 'Optometrista',
  LABORATORIO: 'Laboratorio',
};

export const tienePermiso = (rol: Rol, permiso: Permiso) => PERMISOS_POR_ROL[rol].includes(permiso);

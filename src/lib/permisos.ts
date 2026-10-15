/**
 * Permisos de Provisión. Cada rol es un paquete de permisos: las rutas piden permisos,
 * no roles, así un rol nuevo o un ajuste se hace solo aquí.
 */
export const PERMISOS = [
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
] as const;

export type Permiso = (typeof PERMISOS)[number];

export const ROLES = ['ADMIN', 'ENCARGADO', 'CAJERO', 'VENDEDOR', 'OPTOMETRISTA', 'LABORATORIO'] as const;
export type Rol = (typeof ROLES)[number];

const SOLO_DUENO: Permiso[] = ['usuarios.gestionar', 'sucursales.gestionar', 'sucursales.todas', 'caja.retiro_dueno'];

export const PERMISOS_POR_ROL: Record<Rol, readonly Permiso[]> = {
  /** Dueño: todo. */
  ADMIN: PERMISOS,

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
  ],

  /** Optometrista: clientes y graduaciones. */
  OPTOMETRISTA: ['catalogo.ver', 'clientes.ver', 'clientes.gestionar', 'recetas.gestionar', 'ventas.ver', 'laboratorio.ver'],

  /** Técnico de laboratorio: armado de lentes. */
  LABORATORIO: ['catalogo.ver', 'inventario.ver', 'clientes.ver', 'laboratorio.ver', 'laboratorio.gestionar'],
};

export const NOMBRE_ROL: Record<Rol, string> = {
  ADMIN: 'Administrador',
  ENCARGADO: 'Encargado de sucursal',
  CAJERO: 'Cajero',
  VENDEDOR: 'Ejecutivo de ventas',
  OPTOMETRISTA: 'Optometrista',
  LABORATORIO: 'Laboratorio',
};

export const tienePermiso = (rol: Rol, permiso: Permiso) => PERMISOS_POR_ROL[rol].includes(permiso);

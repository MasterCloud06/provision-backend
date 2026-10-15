/** Bolivia no usa horario de verano: siempre UTC−4. */
export const TZ_OFFSET = '-04:00';

export const inicioDia = (f: string) => new Date(`${f}T00:00:00${TZ_OFFSET}`);
export const finDia = (f: string) => new Date(`${f}T23:59:59.999${TZ_OFFSET}`);

/** Fecha de hoy (YYYY-MM-DD) en hora de Bolivia. */
export const hoy = () => new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);

/** Primer y último día de un mes 'YYYY-MM'. */
export function rangoMes(mes: string): { desde: string; hasta: string } {
  const [y, m] = mes.split('-').map(Number) as [number, number];
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { desde: `${mes}-01`, hasta: `${mes}-${String(ultimo).padStart(2, '0')}` };
}

/**
 * Horario de atención para las citas, escrito como lo diría una persona:
 *   "lun-vie 09:00-13:00 15:00-19:00; sab 09:00-13:00"
 * Días: lun mar mie jue vie sab dom (también rangos "lun-vie"). Hora local de Bolivia.
 */
export type Horario = Map<number, { desde: number; hasta: number }[]>; // día (0 = domingo) → tramos en minutos

const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

const aMinutos = (h: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(h);
  if (!m) throw new Error(`Hora inválida "${h}" (usa HH:MM)`);
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (v > 24 * 60 || Number(m[2]) >= 60) throw new Error(`Hora inválida "${h}"`);
  return v;
};

export const aHora = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function leerHorario(texto: string): Horario {
  const h: Horario = new Map();
  for (const parte of texto.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [dias, ...tramos] = parte.split(/\s+/);
    const indices: number[] = [];
    for (const d of dias!.toLowerCase().split(',')) {
      const [a, b] = d.split('-');
      const i = DIAS.indexOf(a!);
      const j = b ? DIAS.indexOf(b) : i;
      if (i < 0 || j < 0) throw new Error(`Día inválido "${d}" (usa ${DIAS.join(', ')})`);
      for (let k = i; ; k = (k + 1) % 7) {
        indices.push(k);
        if (k === j) break;
      }
    }
    if (tramos.length === 0) throw new Error(`Faltan las horas para "${dias}"`);
    const lista = tramos.map((t) => {
      const [desde, hasta] = t.split('-');
      const r = { desde: aMinutos(desde!), hasta: aMinutos(hasta ?? '') };
      if (r.hasta <= r.desde) throw new Error(`Tramo inválido "${t}"`);
      return r;
    });
    for (const i of indices) h.set(i, [...(h.get(i) ?? []), ...lista]);
  }
  return h;
}

/** Día de la semana (0 = domingo) de una fecha YYYY-MM-DD. */
export const diaSemana = (fecha: string) => new Date(`${fecha}T12:00:00Z`).getUTCDay();

/** Horas de inicio de los turnos de un día, cada `duracion` minutos. */
export function turnosDelDia(h: Horario, fecha: string, duracion: number): string[] {
  const horas: string[] = [];
  for (const t of h.get(diaSemana(fecha)) ?? []) {
    for (let m = t.desde; m + duracion <= t.hasta; m += duracion) horas.push(aHora(m));
  }
  return horas;
}

/** Suma días a una fecha YYYY-MM-DD. */
export const sumarDias = (fecha: string, n: number) => {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Fecha y minutos de ahora en Bolivia (UTC−4). */
export function ahoraBolivia(ahora = Date.now()) {
  const d = new Date(ahora - 4 * 3600_000);
  return { fecha: d.toISOString().slice(0, 10), minutos: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

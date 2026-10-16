import { AppError } from './errors.js';

/**
 * Frena a quien intenta adivinar la contraseña de una cuenta: después de `maxFallos` intentos fallidos
 * dentro de `ventanaMs`, la cuenta queda bloqueada `bloqueoMs` (aunque la contraseña sea correcta).
 * Vive en memoria: alcanza para un servidor; si se reinicia, los contadores vuelven a cero.
 */
export class BloqueoIntentos {
  private readonly fallos = new Map<string, { n: number; desde: number; hasta?: number }>();

  constructor(
    private readonly maxFallos = 5,
    private readonly ventanaMs = 15 * 60_000,
    private readonly bloqueoMs = 15 * 60_000,
    private readonly ahora: () => number = Date.now,
  ) {}

  /** Lanza 429 si la cuenta está bloqueada. */
  verificar(clave: string) {
    const f = this.fallos.get(clave);
    if (!f?.hasta) return;
    const resta = f.hasta - this.ahora();
    if (resta <= 0) {
      this.fallos.delete(clave);
      return;
    }
    const minutos = Math.ceil(resta / 60_000);
    throw new AppError(
      429,
      'CUENTA_BLOQUEADA',
      `Demasiados intentos fallidos con esta cuenta. Espera ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'} y vuelve a intentar.`,
      { segundos: Math.ceil(resta / 1000) },
    );
  }

  fallo(clave: string) {
    const t = this.ahora();
    const f = this.fallos.get(clave);
    if (!f || t - f.desde > this.ventanaMs) {
      this.fallos.set(clave, { n: 1, desde: t });
      return;
    }
    f.n++;
    if (f.n >= this.maxFallos) f.hasta = t + this.bloqueoMs;
    this.limpiar(t);
  }

  exito(clave: string) {
    this.fallos.delete(clave);
  }

  /** Evita que el mapa crezca sin fin con correos inventados. */
  private limpiar(t: number) {
    if (this.fallos.size < 5000) return;
    for (const [k, f] of this.fallos) if ((f.hasta ?? f.desde + this.ventanaMs) < t) this.fallos.delete(k);
  }
}

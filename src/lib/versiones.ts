import { env } from '../config/env.js';

export const PLATAFORMAS = ['escritorio', 'android'] as const;
export type Plataforma = (typeof PLATAFORMAS)[number];

/** La última versión publicada de una app. `compilacion` es el número que siempre sube con cada cambio. */
export type Version = {
  compilacion: number;
  version: string;
  url: string;
  tamano: number | null;
  notas: string | null;
  publicadaEn: string;
};

/** De dónde salen las versiones publicadas (GitHub Releases; en los tests, uno falso). */
export type FuenteVersiones = (p: Plataforma) => Promise<Version | null>;

/** Número de compilación al final de la etiqueta: "v0.1.0-23" → 23, "escritorio-41" → 41. */
export function compilacionDe(etiqueta: string): number | null {
  const m = etiqueta.match(/(\d+)$/);
  return m ? Number(m[1]) : null;
}

type Release = { tag_name: string; name: string | null; body: string | null; published_at: string; draft: boolean; prerelease: boolean; assets: { name: string; browser_download_url: string; size: number }[] };

export function fuenteGitHub(): FuenteVersiones {
  const repos: Record<Plataforma, { repo: string; ext: string }> = {
    escritorio: { repo: env.REPO_ESCRITORIO, ext: '.exe' },
    android: { repo: env.REPO_ANDROID, ext: '.apk' },
  };
  return async (p) => {
    const { repo, ext } = repos[p];
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'provision-backend',
        ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404) return null; // sin versiones publicadas (o repo privado sin token)
    if (!r.ok) throw new Error(`GitHub ${r.status} al leer ${repo}`);
    const rel = (await r.json()) as Release;
    const archivo = rel.assets.find((a) => a.name.toLowerCase().endsWith(ext));
    const compilacion = compilacionDe(rel.tag_name);
    if (!archivo || compilacion == null) return null;
    return {
      compilacion,
      version: rel.name ?? rel.tag_name,
      url: archivo.browser_download_url,
      tamano: archivo.size,
      notas: rel.body,
      publicadaEn: rel.published_at,
    };
  };
}

/**
 * Guarda en memoria la última versión de cada app y la refresca cada pocos minutos.
 * Nunca frena una petición: si GitHub no responde, se sigue con lo último que se supo
 * (y si nunca se supo, no se bloquea a nadie).
 */
export class Versiones {
  private datos: Partial<Record<Plataforma, { v: Version | null; en: number }>> = {};
  private enCurso: Partial<Record<Plataforma, Promise<void>>> = {};

  constructor(
    private readonly fuente: FuenteVersiones,
    private readonly vigenciaMs = 5 * 60_000,
  ) {}

  /** Lo último conocido, sin esperar. Dispara una actualización si está viejo. */
  conocida(p: Plataforma): Version | null {
    const d = this.datos[p];
    if (!d || Date.now() - d.en > this.vigenciaMs) void this.refrescar(p);
    return d?.v ?? null;
  }

  /** La última versión, consultando la fuente si hace falta. */
  async ultima(p: Plataforma): Promise<Version | null> {
    const d = this.datos[p];
    if (!d || Date.now() - d.en > this.vigenciaMs) await this.refrescar(p);
    return this.datos[p]?.v ?? null;
  }

  private refrescar(p: Plataforma) {
    this.enCurso[p] ??= this.fuente(p)
      .then((v) => {
        this.datos[p] = { v, en: Date.now() };
      })
      .catch((err) => {
        console.error(`[versiones] no se pudo consultar ${p}:`, (err as Error).message);
        // Se reintenta en un minuto, conservando lo último conocido.
        const previo = this.datos[p];
        this.datos[p] = { v: previo?.v ?? null, en: Date.now() - this.vigenciaMs + 60_000 };
      })
      .finally(() => {
        delete this.enCurso[p];
      });
    return this.enCurso[p];
  }
}

/** Lee la cabecera "X-Provision-App: escritorio/23". */
export function leerCliente(valor: string | undefined): { plataforma: Plataforma; compilacion: number } | null {
  const m = valor?.trim().match(/^(escritorio|android)\/(\d+)$/);
  if (!m) return null;
  return { plataforma: m[1] as Plataforma, compilacion: Number(m[2]) };
}

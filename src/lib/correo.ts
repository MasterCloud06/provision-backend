import { env } from '../config/env.js';

export type Mensaje = { para: string; asunto: string; html: string; texto: string };

/** Envío de correos. La implementación real usa Resend; los tests usan una falsa. */
export interface Correo {
  enviar(m: Mensaje): Promise<void>;
}

export function crearCorreoResend(clave: string, remitente: string): Correo {
  return {
    async enviar(m) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: remitente, to: [m.para], subject: m.asunto, html: m.html, text: m.texto }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { message?: string };
        throw new Error(`Resend ${r.status}: ${e.message ?? r.statusText}`);
      }
    },
  };
}

/** El servicio configurado, o null si falta RESEND_API_KEY. */
export function correoDesdeEntorno(): Correo | null {
  return env.RESEND_API_KEY ? crearCorreoResend(env.RESEND_API_KEY, env.CORREO_REMITENTE) : null;
}

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Arma un correo sencillo y legible en cualquier cliente: un saludo, párrafos y, opcionalmente, un botón.
 * Todo el texto se escapa; solo `boton.url` va como enlace.
 */
export function plantilla(d: { para: string; asunto: string; saludo: string; parrafos: string[]; boton?: { texto: string; url: string }; pie?: string }): Mensaje {
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:#1d2733">${escapar(t)}</p>`;
  const boton = d.boton
    ? `<p style="margin:22px 0"><a href="${escapar(d.boton.url)}" style="background:#17695f;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:6px;display:inline-block">${escapar(d.boton.texto)}</a></p>`
    : '';
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f2f5f5;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<p style="margin:0 0 20px;font-size:20px;font-weight:bold;color:#17695f">Provisión</p>
<div style="background:#ffffff;border:1px solid #d3dbde;border-radius:10px;padding:24px">
${p(d.saludo)}${d.parrafos.map(p).join('')}${boton}
</div>
<p style="margin:16px 0 0;font-size:13px;color:#56626e">${escapar(d.pie ?? 'Este correo se envió automáticamente desde la tienda en línea de la óptica.')}</p>
</div></body></html>`;
  const texto = [d.saludo, ...d.parrafos, d.boton ? `${d.boton.texto}: ${d.boton.url}` : null].filter(Boolean).join('\n\n');
  return { para: d.para, asunto: d.asunto, html, texto };
}

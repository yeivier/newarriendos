import type { Context, Config } from '@netlify/functions'
import { quienLlama, sinAcceso, soloDueno } from '../lib/auth.mts'

// Envía por correo los datos de acceso que el propietario acaba de crear para
// otra persona (su mamá, su contador, quien administre con él).
//
// El correo sale desde contacto@aliviasoluciones.com, que es la dirección de la
// administración. Para que salga de verdad hay que tener configurada en Netlify
// la variable RESEND_API_KEY (servicio de correo Resend) y el dominio
// aliviasoluciones.com verificado ahí. Mientras eso no esté, la función
// responde { sinCorreo: true } y la plataforma abre el correo del teléfono con
// el mensaje ya escrito, para que igual se pueda mandar.
//
// La clave viaja solo en este correo y no se guarda en ninguna parte: el
// servidor únicamente conserva su huella (ver netlify/lib/auth.mts).
//
// POST /api/enviar-acceso { nombre, email, clave, rol, url } -> { ok } | { sinCorreo }

const REMITENTE_DEF = 'ArriendoPro <contacto@aliviasoluciones.com>'

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const textoAcceso = (nombre: string, clave: string, rol: string, url: string) =>
  [
    `Hola ${nombre || ''}`.trim() + ':',
    '',
    'Te damos acceso a la plataforma donde administramos las propiedades.',
    '',
    'Dirección: ' + url,
    'Tu clave: ' + clave,
    'Permiso: ' + (rol === 'lectura' ? 'solo lectura (puedes ver todo, no modificar)' : 'ver y modificar'),
    '',
    'Entra a la dirección, escribe la clave y listo. No la compartas con nadie más.',
    '',
    'Cualquier duda, escríbenos a contacto@aliviasoluciones.com o al WhatsApp +56 9 7554 9829.',
    '',
    'ArriendoPro · Administración de propiedades',
  ].join('\n')

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return Response.json({ error: 'Método no permitido' }, { status: 405 })

  const quien = await quienLlama(req)
  if (!quien) return sinAcceso()
  if (quien.rol !== 'dueño') return soloDueno()

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const nombre = String(body.nombre || '').trim()
  const email = String(body.email || '').trim().toLowerCase()
  const clave = String(body.clave || '')
  const rol = body.rol === 'lectura' ? 'lectura' : 'dueño'
  const url = String(body.url || '').trim()

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: 'Correo inválido' }, { status: 400 })
  }
  if (!clave) return Response.json({ error: 'Falta la clave' }, { status: 400 })
  if (!/^https?:\/\//.test(url)) return Response.json({ error: 'Falta la dirección del sitio' }, { status: 400 })

  const resendKey = Netlify.env.get('RESEND_API_KEY')
  const texto = textoAcceso(nombre, clave, rol, url)
  if (!resendKey) return Response.json({ ok: false, sinCorreo: true, texto })

  const desde = Netlify.env.get('CORREO_REMITENTE') || REMITENTE_DEF
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + resendKey },
      body: JSON.stringify({
        from: desde,
        to: [email],
        subject: 'Tu acceso a la plataforma — ArriendoPro',
        text: texto,
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden">
          <div style="background:#0B0B0D;color:#C6A25B;padding:18px 22px;font-weight:bold;letter-spacing:2px">ARRIENDOPRO</div>
          <div style="padding:22px;color:#222;line-height:1.6">
            <p>Hola ${esc(nombre)}:</p>
            <p>Te damos acceso a la plataforma donde administramos las propiedades.</p>
            <table style="border-collapse:collapse;margin:16px 0;font-size:15px">
              <tr><td style="color:#666;padding:5px 12px 5px 0">Dirección</td><td><a href="${esc(url)}">${esc(url)}</a></td></tr>
              <tr><td style="color:#666;padding:5px 12px 5px 0">Tu clave</td><td><b style="letter-spacing:1px">${esc(clave)}</b></td></tr>
              <tr><td style="color:#666;padding:5px 12px 5px 0">Permiso</td><td>${rol === 'lectura' ? 'Solo lectura (puedes ver todo, no modificar)' : 'Ver y modificar'}</td></tr>
            </table>
            <p>Entra a la dirección, escribe la clave y listo. No la compartas con nadie más.</p>
            <p style="color:#666;font-size:13px">Cualquier duda, escríbenos a contacto@aliviasoluciones.com o al WhatsApp +56 9 7554 9829.</p>
          </div></div>`,
      }),
    })
    if (!r.ok) {
      const j: any = await r.json().catch(() => ({}))
      return Response.json({ ok: false, sinCorreo: true, texto, aviso: j?.message || 'No se pudo enviar el correo' })
    }
    return Response.json({ ok: true })
  } catch {
    return Response.json({ ok: false, sinCorreo: true, texto, aviso: 'Servicio de correo no disponible' })
  }
}

export const config: Config = {
  path: '/api/enviar-acceso',
  method: ['POST'],
}

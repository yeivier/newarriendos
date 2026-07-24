import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// Códigos de verificación de correo para el registro de cuentas.
// - Si existe RESEND_API_KEY, envía el código real por correo (Resend).
// - Si no existe, responde en modo demo: devuelve el código para mostrarlo en
//   pantalla y que el flujo de registro funcione igual mientras se configura
//   el servicio de correo.
//
// POST /api/codigo { action:"enviar",   email }          -> { ok, demo?, codigo? }
// POST /api/codigo { action:"verificar", email, codigo } -> { ok, valido }

const VIGENCIA_MS = 15 * 60 * 1000 // 15 minutos

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return Response.json({ error: 'Método no permitido' }, { status: 405 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }
  const email = String(body.email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: 'Correo inválido' }, { status: 400 })
  }

  const store = getStore({ name: 'codigos-correo', consistency: 'strong' })
  const key = 'codigo:' + email

  if (body.action === 'enviar') {
    const codigo = String(Math.floor(100000 + Math.random() * 900000))
    await store.setJSON(key, { codigo, exp: Date.now() + VIGENCIA_MS })

    const resendKey = Netlify.env.get('RESEND_API_KEY')
    if (!resendKey) {
      // Modo demo: sin servicio de correo configurado todavía.
      return Response.json({ ok: true, demo: true, codigo })
    }
    const desde = Netlify.env.get('CORREO_REMITENTE') || 'ArriendoPro <onboarding@resend.dev>'
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + resendKey },
        body: JSON.stringify({
          from: desde,
          to: [email],
          subject: 'Tu código de verificación — ArriendoPro',
          html: `<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden">
            <div style="background:#0B0B0D;color:#C6A25B;padding:18px 22px;font-weight:bold;letter-spacing:2px">ARRIENDOPRO</div>
            <div style="padding:22px">
              <p style="color:#222">Hola: usa este código para validar tu correo y crear tu cuenta.</p>
              <div style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:14px 0;color:#0B0B0D">${codigo}</div>
              <p style="color:#666;font-size:13px">El código vence en 15 minutos. Si no solicitaste esta cuenta, ignora este correo.</p>
            </div></div>`,
        }),
      })
      if (!r.ok) {
        const j: any = await r.json().catch(() => ({}))
        // Si el envío falla, degradar a demo para no bloquear el registro.
        return Response.json({ ok: true, demo: true, codigo, aviso: j?.message || 'No se pudo enviar el correo' })
      }
      return Response.json({ ok: true })
    } catch {
      return Response.json({ ok: true, demo: true, codigo, aviso: 'Servicio de correo no disponible' })
    }
  }

  if (body.action === 'verificar') {
    const rec: any = await store.get(key, { type: 'json' }).catch(() => null)
    const c = String(body.codigo || '').trim()
    const valido = !!(rec && rec.codigo === c && rec.exp > Date.now())
    if (valido) await store.delete(key).catch(() => {})
    return Response.json({ ok: true, valido, error: valido ? undefined : 'Código incorrecto o vencido' })
  }

  return Response.json({ error: 'Acción desconocida' }, { status: 400 })
}

export const config: Config = {
  path: '/api/codigo',
  method: ['POST'],
}

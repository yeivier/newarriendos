import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// Guarda en Netlify Blobs los datos públicos (ya sin información personal) de una
// propiedad para que su ficha sea visible en /p/<id> por cualquier persona con el
// enlace. El cliente envía solo lo que decidió mostrar; aquí no se agrega nada más.
export default async (req: Request, _context: Context) => {
  let payload: { publicId?: string; ficha?: Record<string, unknown> }
  try {
    payload = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const ficha = payload.ficha
  if (!ficha || typeof ficha !== 'object') {
    return Response.json({ error: 'Ficha inválida' }, { status: 400 })
  }

  // Normaliza el identificador público: solo letras y números, corto y limpio.
  let publicId = String(payload.publicId || '').replace(/[^a-z0-9]/gi, '').slice(0, 24)
  if (publicId.length < 6) {
    publicId = (Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, '').slice(0, 10)
  }

  const store = getStore('fichas')
  await store.setJSON(publicId, { ...ficha, publicId, updatedAt: Date.now() })

  const origin = new URL(req.url).origin
  return Response.json({ publicId, url: `${origin}/p/${publicId}` })
}

export const config: Config = {
  path: '/api/ficha/publicar',
  method: 'POST',
}

import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// API de datos de la "ficha completa" interactiva que se llena desde un enlace público.
//   GET  /api/fc/<id>  -> devuelve el JSON de la ficha guardada
//   POST /api/fc/<id>  -> guarda el JSON de la ficha (body: { ficha: {...} })
// Lo usan tanto la app (para publicar/actualizar y para "traer cambios") como la
// página pública /llenar/<id> cuando alguien la completa desde fuera.
export default async (req: Request, context: Context) => {
  const id = String((context.params as Record<string, string>)?.id || '')
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 24)
  if (!id || id.length < 6) {
    return Response.json({ error: 'Identificador inválido' }, { status: 400 })
  }

  const store = getStore('fichas-completas')

  if (req.method === 'GET') {
    const f: any = await store.get(id, { type: 'json' })
    if (!f) return Response.json({ error: 'Ficha no encontrada' }, { status: 404 })
    return Response.json(f)
  }

  // POST -> guardar
  let body: { ficha?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }
  const ficha = body?.ficha
  if (!ficha || typeof ficha !== 'object') {
    return Response.json({ error: 'Ficha inválida' }, { status: 400 })
  }
  const rec = { ...ficha, publicId: id, updatedAt: Date.now() }
  await store.setJSON(id, rec)
  return Response.json({ ok: true, publicId: id, updatedAt: rec.updatedAt })
}

export const config: Config = {
  path: '/api/fc/:id',
  method: ['GET', 'POST'],
}

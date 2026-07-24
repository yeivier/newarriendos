import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// Guarda y entrega el estado completo del panel (propiedades, sociedades,
// contactos, indicadores y configuración) en Netlify Blobs. Así todo lo que se
// ingresa queda guardado en el servidor y está disponible desde cualquier
// dispositivo, sin importar la IP ni la ubicación: ya no vive solo en el
// navegador. El documento se lee y escribe completo (no requiere consultas
// relacionales), por lo que Blobs con consistencia fuerte es el primitivo
// adecuado.
//
// GET  /api/estado  -> { estado, updatedAt } | { estado:null }
// PUT  /api/estado  -> guarda el cuerpo JSON recibido

const KEY = 'workspace'

export default async (req: Request, _context: Context) => {
  const store = getStore({ name: 'app-estado', consistency: 'strong' })

  if (req.method === 'GET') {
    const data = await store.get(KEY, { type: 'json' }).catch(() => null)
    return Response.json(data ?? { estado: null })
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    let estado: unknown
    try {
      estado = await req.json()
    } catch {
      return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
    }
    if (!estado || typeof estado !== 'object') {
      return Response.json({ error: 'Estado inválido' }, { status: 400 })
    }
    const updatedAt = Date.now()
    await store.setJSON(KEY, { estado, updatedAt })
    return Response.json({ ok: true, updatedAt })
  }

  return Response.json({ error: 'Método no permitido' }, { status: 405 })
}

export const config: Config = {
  path: '/api/estado',
  method: ['GET', 'PUT', 'POST'],
}

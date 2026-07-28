import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { quienLlama, sinAcceso, soloDueno } from '../lib/auth.mts'

// Copias de seguridad del panel.
//
// GET  /api/respaldos            -> { respaldos:[{fecha, updatedAt}] }
// POST /api/respaldos {fecha}    -> devuelve ese respaldo y lo deja como estado
//                                   actual (antes guarda el estado de hoy, para
//                                   poder deshacer la restauración).

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const resp = getStore({ name: 'app-respaldos', consistency: 'strong' })

  if (req.method === 'GET') {
    const { blobs } = await resp.list()
    const respaldos = blobs
      .filter((b) => b.key.startsWith('snap-'))
      .map((b) => ({ fecha: b.key.slice(5) }))
      .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))
    return Response.json({ respaldos })
  }

  if (req.method === 'POST') {
    if (yo.rol !== 'dueño') return soloDueno()
    let body: any
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
    }
    const fecha = String(body.fecha || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return Response.json({ error: 'Fecha inválida' }, { status: 400 })
    const snap = (await resp.get('snap-' + fecha, { type: 'json' }).catch(() => null)) as any
    if (!snap || !snap.estado) return Response.json({ error: 'No hay respaldo de ese día' }, { status: 404 })

    const estadoStore = getStore({ name: 'app-estado', consistency: 'strong' })
    const actual = (await estadoStore.get('workspace', { type: 'json' }).catch(() => null)) as any
    // Antes de restaurar, guarda lo que hay ahora: restaurar no debe ser una
    // puerta de una sola dirección.
    if (actual?.estado) {
      await resp.setJSON('snap-antes-de-restaurar', { ...actual, fecha: 'antes-de-restaurar' }).catch(() => {})
    }
    const updatedAt = Date.now()
    await estadoStore.setJSON('workspace', { estado: snap.estado, updatedAt })
    return Response.json({ ok: true, estado: snap.estado, updatedAt, fecha })
  }

  return Response.json({ error: 'Método no permitido' }, { status: 405 })
}

export const config: Config = {
  path: '/api/respaldos',
  method: ['GET', 'POST'],
}

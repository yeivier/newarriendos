import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { quienLlama, sinAcceso, soloDueno } from '../lib/auth.mts'

// Guarda y entrega el estado completo del panel (propiedades, sociedades,
// contactos, indicadores y configuración) en Netlify Blobs. Así todo lo que se
// ingresa queda guardado en el servidor y está disponible desde cualquier
// dispositivo, sin importar la IP ni la ubicación: ya no vive solo en el
// navegador. El documento se lee y escribe completo (no requiere consultas
// relacionales), por lo que Blobs con consistencia fuerte es el primitivo
// adecuado.
//
// Requiere sesión: sin la clave de la plataforma no se puede leer ni escribir.
// Los accesos de solo lectura pueden mirar, pero no guardar.
//
// Cada guardado deja además la copia del día en 'app-respaldos', para poder
// volver atrás si algo se sobrescribe por error.
//
// GET  /api/estado  -> { estado, updatedAt } | { estado:null }
// PUT  /api/estado  -> guarda el cuerpo JSON recibido

const KEY = 'workspace'
const DIAS_RESPALDO = 30

/** Deja la copia del día y borra las que pasaron los 30 días.
 *  La copia de cada día es la PRIMERA del día y no se pisa después: así, si
 *  hoy se estropea algo, la copia de hoy todavía tiene el estado con el que
 *  empezó la jornada. */
async function respaldar(estado: unknown, updatedAt: number) {
  const store = getStore({ name: 'app-respaldos', consistency: 'strong' })
  const fecha = new Date().toISOString().slice(0, 10)
  const yaHay = await store.get('snap-' + fecha, { type: 'json' }).catch(() => null)
  if (!yaHay) await store.setJSON('snap-' + fecha, { estado, updatedAt, fecha })
  const limite = new Date(Date.now() - DIAS_RESPALDO * 86400000).toISOString().slice(0, 10)
  const { blobs } = await store.list()
  await Promise.all(
    blobs
      .filter((b) => b.key.startsWith('snap-') && b.key.slice(5) < limite)
      .map((b) => store.delete(b.key).catch(() => {})),
  )
}

export default async (req: Request, _context: Context) => {
  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  const store = getStore({ name: 'app-estado', consistency: 'strong' })

  if (req.method === 'GET') {
    const data = await store.get(KEY, { type: 'json' }).catch(() => null)
    return Response.json(data ?? { estado: null })
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    if (yo.rol !== 'dueño') return soloDueno()
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
    // Si el respaldo falla, el guardado igual vale.
    await respaldar(estado, updatedAt).catch(() => {})
    return Response.json({ ok: true, updatedAt })
  }

  return Response.json({ error: 'Método no permitido' }, { status: 405 })
}

export const config: Config = {
  path: '/api/estado',
  method: ['GET', 'PUT', 'POST'],
}

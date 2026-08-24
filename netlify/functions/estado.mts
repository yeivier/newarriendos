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
// Varias personas pueden estar dentro al mismo tiempo, desde distintos
// dispositivos y lugares. Antes cada guardado escribía el documento completo a
// ciegas: si dos editaban a la vez, el último borraba el trabajo del otro sin
// avisar. Ahora cada guardado dice sobre qué versión se hizo:
//
//   · si nadie guardó en el intermedio, se escribe y se devuelve la versión nueva;
//   · si alguien guardó antes, se responde 409 con el estado que hay ahora para
//     que quien guarda lo fusione con lo suyo y reintente.
//
// Y hay una consulta barata de versión, para que cada dispositivo sepa cuándo
// traerse lo que hicieron los demás sin descargar todo el documento.
//
// GET  /api/estado          -> { estado, updatedAt } | { estado:null }
// GET  /api/estado?v=1      -> { updatedAt }   (solo la versión)
// PUT  /api/estado          -> guarda; cabecera X-Estado-Base con la versión sobre
//                              la que se editó (si falta, se guarda sin comprobar)

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
    const data = (await store.get(KEY, { type: 'json' }).catch(() => null)) as
      | { estado: unknown; updatedAt?: number }
      | null
    // Consulta de versión: la usan los dispositivos para saber si alguien más
    // guardó algo, sin traerse el documento entero cada vez.
    if (new URL(req.url).searchParams.get('v')) {
      return Response.json({ updatedAt: data?.updatedAt ?? 0 })
    }
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
    // ¿Sobre qué versión se editó? Si alguien guardó en el intermedio, no se
    // pisa: se devuelve lo que hay para que el cliente lo fusione y reintente.
    const base = Number(req.headers.get('x-estado-base') || '')
    if (Number.isFinite(base) && base > 0) {
      const actual = (await store.get(KEY, { type: 'json' }).catch(() => null)) as
        | { estado: unknown; updatedAt?: number }
        | null
      const versionActual = actual?.updatedAt ?? 0
      if (versionActual > base) {
        return Response.json(
          { error: 'desactualizado', estado: actual?.estado ?? null, updatedAt: versionActual },
          { status: 409 },
        )
      }
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

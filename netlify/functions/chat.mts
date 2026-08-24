import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { quienLlama, sinAcceso, nuevoId } from '../lib/auth.mts'

// Chat interno del equipo: quienes tienen acceso a la plataforma (el
// propietario, su contador, quien administre con él) conversan entre ellos y
// adjuntan fotos, PDF, Word o lo que sea. Todo queda guardado en el servidor,
// así que se ve igual desde el teléfono y desde el computador, y no depende
// del navegador de nadie.
//
// Cada mensaje es un blob aparte, con la fecha en la llave:
//     m/<AAAA-MM>/<epoch>-<id>
// Se guarda uno por uno a propósito. Si todos vivieran en un mismo archivo,
// dos personas escribiendo a la vez se pisarían el mensaje: el segundo en
// guardar borraría el del primero. Así cada quien escribe en su propia llave y
// no hay forma de perder nada.
//
// GET  /api/chat            -> { mensajes:[…], yo:{nombre,rol} }  últimos 200
// POST /api/chat  {texto, adjuntos:[{url,name,contentType}]} -> { ok, mensaje }
// POST /api/chat  {accion:"borrar", id}                      -> { ok }

const TIENDA = 'chat-equipo'
const TOPE = 200            // mensajes que se devuelven
const MAX_TEXTO = 4000
const MAX_ADJUNTOS = 6

type Mensaje = {
  id: string
  ts: number
  autor: string
  rol: string
  texto: string
  adjuntos: { url: string; name: string; contentType: string }[]
}

const tienda = () => getStore({ name: TIENDA, consistency: 'strong' })

/** Prefijo AAAA-MM de un momento dado, para agrupar por mes. */
const mesDe = (ms: number) => {
  const d = new Date(ms)
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
}

/** Los meses a mirar hacia atrás hasta juntar suficientes mensajes. */
const mesesAtras = (n: number) => {
  const out: string[] = []
  const d = new Date()
  for (let i = 0; i < n; i++) {
    out.push(mesDe(d.getTime()))
    d.setUTCMonth(d.getUTCMonth() - 1)
  }
  return out
}

async function leerMensajes(): Promise<Mensaje[]> {
  const store = tienda()
  const llaves: string[] = []
  // Se recorren los meses del más nuevo al más viejo y se corta apenas hay
  // suficientes: así un historial largo no obliga a leerlo entero.
  for (const mes of mesesAtras(12)) {
    const { blobs } = await store.list({ prefix: `m/${mes}/` }).catch(() => ({ blobs: [] as { key: string }[] }))
    llaves.push(...blobs.map((b) => b.key))
    if (llaves.length >= TOPE) break
  }
  llaves.sort()                       // la llave empieza por el epoch: orden cronológico
  const ultimas = llaves.slice(-TOPE)
  const msgs = await Promise.all(
    ultimas.map((k) => store.get(k, { type: 'json' }).catch(() => null)),
  )
  return (msgs.filter(Boolean) as Mensaje[]).sort((a, b) => a.ts - b.ts)
}

export default async (req: Request, _context: Context) => {
  const quien = await quienLlama(req)
  if (!quien) return sinAcceso()

  if (req.method === 'GET') {
    const mensajes = await leerMensajes()
    return Response.json({ mensajes, yo: { nombre: quien.nombre, rol: quien.rol } })
  }

  if (req.method !== 'POST') return Response.json({ error: 'Método no permitido' }, { status: 405 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  // Cada quien puede borrar lo que escribió; el dueño puede borrar cualquiera.
  if (body.accion === 'borrar') {
    const id = String(body.id || '')
    if (!id) return Response.json({ error: 'Falta el mensaje' }, { status: 400 })
    const store = tienda()
    const todos = await leerMensajes()
    const m = todos.find((x) => x.id === id)
    if (!m) return Response.json({ error: 'Ese mensaje ya no está' }, { status: 404 })
    if (quien.rol !== 'dueño' && m.autor !== quien.nombre) {
      return Response.json({ error: 'Solo puedes borrar tus propios mensajes' }, { status: 403 })
    }
    await store.delete(`m/${mesDe(m.ts)}/${m.ts}-${m.id}`).catch(() => {})
    return Response.json({ ok: true })
  }

  const texto = String(body.texto || '').slice(0, MAX_TEXTO).trim()
  const adjuntos = (Array.isArray(body.adjuntos) ? body.adjuntos : [])
    .slice(0, MAX_ADJUNTOS)
    .map((a: any) => ({
      // Solo rutas servidas por la propia plataforma: nada de enlaces de fuera,
      // que podrían apuntar a cualquier parte.
      url: /^\/(a|m)\//.test(String(a?.url || '')) ? String(a.url) : '',
      name: String(a?.name || 'archivo').slice(0, 120),
      contentType: String(a?.contentType || 'application/octet-stream').slice(0, 100),
    }))
    .filter((a: any) => a.url)

  if (!texto && !adjuntos.length) {
    return Response.json({ error: 'Escribe algo o adjunta un archivo' }, { status: 400 })
  }

  const ts = Date.now()
  const mensaje: Mensaje = {
    id: nuevoId().slice(0, 16),
    ts,
    autor: quien.nombre || 'Alguien del equipo',
    rol: quien.rol,
    texto,
    adjuntos,
  }
  await tienda().setJSON(`m/${mesDe(ts)}/${ts}-${mensaje.id}`, mensaje)
  return Response.json({ ok: true, mensaje })
}

export const config: Config = {
  path: '/api/chat',
  method: ['GET', 'POST'],
}

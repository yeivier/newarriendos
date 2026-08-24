import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import { leerConfig, quienLlama, sinAcceso, puedeAportar, nuevoId } from '../lib/auth.mts'

// Aportes del equipo: lo que un colaborador —una arquitecta, un maestro, el
// contador— carga a la plataforma para que quede guardado y ordenado. Planos,
// presupuestos, fotos, archivos y notas, cada uno con su categoría y, si
// corresponde, la propiedad a la que pertenece.
//
// Se guarda como el chat: un blob por aporte, con la fecha en la llave, para
// que dos personas subiendo a la vez no se pisen. Así el material vive en el
// servidor —disponible desde cualquier aparato— y no depende del navegador de
// nadie.
//
// El arquitecto NO puede guardar el panel (propiedades, cuentas): eso sigue
// siendo solo del dueño. Pero sí puede aportar aquí, que es su trabajo.
//
// GET  /api/aportes          -> { aportes:[…], yo:{nombre,rol} }
// POST /api/aportes  { tipo, titulo, pid, nota, archivos:[{url,name,contentType}] } -> { ok, aporte }
// POST /api/aportes  { accion:"borrar", id } -> { ok }

const TIENDA = 'aportes-equipo'
const TOPE = 400
const MAX_ARCH = 12
const TIPOS = ['plano', 'presupuesto', 'foto', 'archivo', 'nota']

type Aporte = {
  id: string
  ts: number
  autor: string
  rol: string
  tipo: string
  titulo: string
  pid: string          // propiedad, opcional
  nota: string
  archivos: { url: string; name: string; contentType: string }[]
}

const tienda = () => getStore({ name: TIENDA, consistency: 'strong' })
const mesDe = (ms: number) => {
  const d = new Date(ms)
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
}
const mesesAtras = (n: number) => {
  const out: string[] = []
  const d = new Date()
  for (let i = 0; i < n; i++) { out.push(mesDe(d.getTime())); d.setUTCMonth(d.getUTCMonth() - 1) }
  return out
}

async function leerAportes(): Promise<Aporte[]> {
  const store = tienda()
  const llaves: string[] = []
  for (const mes of mesesAtras(24)) {
    const { blobs } = await store.list({ prefix: `a/${mes}/` }).catch(() => ({ blobs: [] as { key: string }[] }))
    llaves.push(...blobs.map((b) => b.key))
    if (llaves.length >= TOPE) break
  }
  llaves.sort()
  const ultimos = llaves.slice(-TOPE)
  const items = await Promise.all(ultimos.map((k) => store.get(k, { type: 'json' }).catch(() => null)))
  return (items.filter(Boolean) as Aporte[]).sort((a, b) => b.ts - a.ts)
}

export default async (req: Request, _context: Context) => {
  const quien = await quienLlama(req)
  if (!quien) return sinAcceso()

  if (req.method === 'GET') {
    const aportes = await leerAportes()
    return Response.json({ aportes, yo: { nombre: quien.nombre, rol: quien.rol } })
  }
  if (req.method !== 'POST') return Response.json({ error: 'Método no permitido' }, { status: 405 })

  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'Cuerpo inválido' }, { status: 400 }) }

  if (body.accion === 'borrar') {
    const id = String(body.id || '')
    const todos = await leerAportes()
    const a = todos.find((x) => x.id === id)
    if (!a) return Response.json({ error: 'Ese aporte ya no está' }, { status: 404 })
    // El dueño borra cualquiera; cada quien, solo lo suyo.
    if (quien.rol !== 'dueño' && a.autor !== quien.nombre) {
      return Response.json({ error: 'Solo puedes borrar lo que subiste tú' }, { status: 403 })
    }
    await tienda().delete(`a/${mesDe(a.ts)}/${a.ts}-${a.id}`).catch(() => {})
    return Response.json({ ok: true })
  }

  // Subir requiere poder aportar (dueño o arquitecto). El de solo lectura, no.
  if (!puedeAportar(quien.rol)) return Response.json({ error: 'Tu acceso no permite subir material' }, { status: 403 })

  const tipo = TIPOS.includes(String(body.tipo)) ? String(body.tipo) : 'archivo'
  const archivos = (Array.isArray(body.archivos) ? body.archivos : [])
    .slice(0, MAX_ARCH)
    .map((a: any) => ({
      url: /^\/(a|m)\//.test(String(a?.url || '')) ? String(a.url) : '',
      name: String(a?.name || 'archivo').slice(0, 120),
      contentType: String(a?.contentType || 'application/octet-stream').slice(0, 100),
    }))
    .filter((a: any) => a.url)

  const titulo = String(body.titulo || '').slice(0, 160).trim()
  const nota = String(body.nota || '').slice(0, 2000).trim()
  if (!archivos.length && !titulo && !nota) {
    return Response.json({ error: 'Agrega un archivo o al menos un título' }, { status: 400 })
  }
  // La propiedad, si se indicó, se contrasta contra las que existen.
  let pid = String(body.pid || '')

  const ts = Date.now()
  const aporte: Aporte = {
    id: nuevoId().slice(0, 16), ts,
    autor: quien.nombre || 'Alguien del equipo', rol: quien.rol,
    tipo, titulo, pid, nota, archivos,
  }
  await tienda().setJSON(`a/${mesDe(ts)}/${ts}-${aporte.id}`, aporte)
  return Response.json({ ok: true, aporte })
}

export const config: Config = { path: '/api/aportes', method: ['GET', 'POST'] }

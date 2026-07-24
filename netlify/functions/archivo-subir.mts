import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// Recibe un archivo adjunto (video, PDF, foto, Word, Excel, etc.) como data URL
// base64, lo guarda en Netlify Blobs y devuelve una URL pública servida por la
// función `archivo`. Así los adjuntos de incidencias y bitácora quedan en el
// servidor —disponibles desde cualquier dispositivo— y nunca dependen del
// almacenamiento local del navegador.
export default async (req: Request, _context: Context) => {
  let payload: { dataUrl?: string; name?: string }
  try {
    payload = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const dataUrl = payload.dataUrl || ''
  const m = /^data:([^;]*);base64,(.+)$/s.exec(dataUrl)
  if (!m) {
    return Response.json({ error: 'Archivo inválido' }, { status: 400 })
  }
  const contentType = m[1] || 'application/octet-stream'
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))

  // Límite defensivo. Las funciones de Netlify reciben hasta ~6 MB por solicitud
  // (el base64 infla ~33%), por lo que limitamos el archivo original a ~4 MB.
  if (bytes.length > 4 * 1024 * 1024) {
    return Response.json(
      { error: 'El archivo supera el límite de 4 MB. Comprímelo o súbelo a un enlace externo.' },
      { status: 413 },
    )
  }

  const safeName = String(payload.name || 'archivo')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .slice(-60)
  const rand = Math.random().toString(36).slice(2, 10)
  const key = `${Date.now().toString(36)}-${rand}-${safeName}`

  const store = getStore('ficha-archivos')
  await store.set(key, bytes, {
    metadata: { contentType, name: String(payload.name || safeName) },
  })

  return Response.json({ url: `/a/${key}`, key, name: payload.name || safeName, contentType })
}

export const config: Config = {
  path: '/api/archivo/subir',
  method: 'POST',
}

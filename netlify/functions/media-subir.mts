import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// Recibe una imagen (foto o panorámica 360°) como data URL base64, la guarda en
// Netlify Blobs y devuelve una URL pública servida por la función `media`. Así las
// imágenes quedan en el servidor —disponibles desde cualquier dispositivo y para
// cualquiera que abra la ficha pública— en lugar de viajar dentro del enlace.
export default async (req: Request, _context: Context) => {
  let payload: { dataUrl?: string; kind?: string; name?: string }
  try {
    payload = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const dataUrl = payload.dataUrl || ''
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl)
  if (!m) {
    return Response.json({ error: 'Imagen inválida' }, { status: 400 })
  }
  const contentType = m[1]
  if (!contentType.startsWith('image/')) {
    return Response.json({ error: 'Solo se permiten imágenes' }, { status: 400 })
  }

  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))
  // Límite defensivo (~8 MB) para evitar abusos; el cliente ya comprime antes de subir.
  if (bytes.length > 8 * 1024 * 1024) {
    return Response.json({ error: 'La imagen es demasiado grande' }, { status: 413 })
  }

  const kind = payload.kind === 'pano' ? 'pano' : 'foto'
  const ext = contentType.split('/')[1].split('+')[0] || 'jpg'
  const rand = Math.random().toString(36).slice(2, 10)
  const key = `${kind}/${Date.now().toString(36)}-${rand}.${ext}`

  const store = getStore('ficha-media')
  await store.set(key, bytes, { metadata: { contentType } })

  return Response.json({ url: `/m/${key}`, key })
}

export const config: Config = {
  path: '/api/media/subir',
  method: 'POST',
}
